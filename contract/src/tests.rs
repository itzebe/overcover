//! Rust unit tests for Overcover — the on-chain mirror of the Mission 1
//! adversarial suite (`research/model/attacks.mjs`). Each test names the attack
//! it mirrors where applicable. Run: `cd contract && cargo test`.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}
fn pubkey() -> Vec<u8> {
    key().verifying_key().to_bytes().to_vec()
}

/// Build a context with a predecessor, deposit and block time (seconds).
fn ctx(predecessor: AccountId, deposit: u128, ts_sec: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor)
        .account_balance(NearToken::from_near(1_000_000))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts_sec * NS_PER_SEC);
    testing_env!(b.build());
}

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}

fn setup() -> Overcover {
    ctx(owner(), 0, 0);
    let mut c = Overcover::new(owner(), pubkey(), U128(ONE / 10), 0);
    c.add_product(
        "rain-berlin-20mm".to_string(),
        "berlin".to_string(),
        200,          // 20.0 mm
        300,          // 3%
        U128(ONE),    // min payout 1 NEAR
        U128(1000 * ONE),
        24 * 3600,
        U128(5000 * ONE),
    );
    c
}

fn sign_obs(city: &str, obs_date: u64, value: u64, reported_at: u64, nonce: u64, contract: AccountId) -> Vec<u8> {
    // Mirror obs_message; the contract is `current_account_id`, which the test
    // VM sets to "contract.testnet" by default in VMContextBuilder.
    let msg = format!(
        "overcover:v1|{}|{}|{}|{}|{}|{}",
        city, obs_date, value, reported_at, nonce, contract
    );
    key().sign(msg.as_bytes()).to_bytes().to_vec()
}

/// The contract's own account id, fixed in every test context.
fn contract_id() -> AccountId {
    "overcover.testnet".parse().unwrap()
}

// --------------------------------------------------------------------------
// A1/A2 — happy path pays; below-threshold does not
// --------------------------------------------------------------------------

#[test]
fn a1_breach_pays_exactly_the_payout() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();

    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0); // 3% of 100
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    assert_eq!(c.get_pool().reserved.0, 100 * ONE);

    // Observation for day 3, reported that day, +1h to clear the challenge window.
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);

    ctx(owner(), 0, day3 + 7200);
    let triggered = c.resolve(id);
    assert!(triggered);
    let pol = c.get_policy(id).unwrap();
    assert_eq!(pol.status, "settled_paid");
    assert_eq!(pol.paid_amount, 100 * ONE);
    // capital: 1000 deposit + 3 premium - 100 payout = 903
    assert_eq!(c.get_pool().capital.0, 903 * ONE);
    assert!(c.reconcile());
}

#[test]
fn a2_below_threshold_does_not_pay() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);

    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 50, day3 + 60, 1, contract_id()); // 5.0 mm
    c.report_observation("berlin".to_string(), day3, 50, day3 + 60, 1, sig);
    ctx(owner(), 0, day3 + 7200);
    let triggered = c.resolve(id);
    assert!(!triggered);
    assert_eq!(c.get_policy(id).unwrap().paid_amount, 0);
    assert_eq!(c.get_pool().capital.0, 1003 * ONE); // premium retained, no payout
    assert_eq!(c.get_pool().reserved.0, 0);
}

// --------------------------------------------------------------------------
// A3/A8 — reservation and capital bounds
// --------------------------------------------------------------------------

#[test]
fn a8_insufficient_capital_is_rejected() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 50 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None)
    }));
    assert!(r.is_err(), "buying cover the pool cannot fund must panic");
}

#[test]
fn a4_premium_is_contract_computed_not_caller_supplied() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    // Attach 0 when the premium is 3 NEAR: must be rejected.
    ctx("biz.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None)
    }));
    assert!(r.is_err(), "attached deposit must equal the quoted premium");
    assert_eq!(c.quote("rain-berlin-20mm".to_string(), U128(100 * ONE)).0, 3 * ONE);
}

#[test]
fn a5_reserved_funds_cannot_be_withdrawn() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 100 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    ctx("lp1.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(U128(100 * ONE))));
    assert!(r.is_err(), "withdrawing reserved capital must fail");
}

#[test]
fn a7_min_lead_is_enforced() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3600, None) // 1h ahead
    }));
    assert!(r.is_err(), "buying inside the min lead must fail");
}

// --------------------------------------------------------------------------
// E1 — the threshold-gaming fix: buyer cannot choose the threshold
// --------------------------------------------------------------------------

#[test]
fn e1_threshold_is_owned_by_the_product() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    // buy_cover has no threshold parameter at all; the policy carries the product's.
    assert_eq!(c.get_policy(id).unwrap().threshold_tenths, 200);
}

// --------------------------------------------------------------------------
// E2 — product capacity cap
// --------------------------------------------------------------------------

#[test]
fn e2_product_capacity_caps_concentration() {
    let mut c = setup();
    ctx(owner(), 0, 0);
    c.add_product(
        "small".to_string(),
        "berlin".to_string(),
        200,
        300,
        U128(ONE),
        U128(100 * ONE),
        24 * 3600,
        U128(250 * ONE), // capacity 250
    );
    ctx("lp1.testnet".parse().unwrap(), 100_000 * ONE, 0);
    c.deposit();
    let mut issued = 0;
    for i in 0..10 {
        let buyer: AccountId = format!("b{}.testnet", i).parse().unwrap();
        ctx(buyer, 3 * ONE, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.buy_cover("small".to_string(), U128(100 * ONE), 3 * 24 * 3600, None)
        }));
        if r.is_ok() {
            issued += 1;
        }
    }
    assert_eq!(issued, 2, "capacity 250 permits only two 100 NEAR policies");
}

// --------------------------------------------------------------------------
// B — oracle
// --------------------------------------------------------------------------

#[test]
fn b1_bad_signature_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3);
    let bad = vec![0u8; 64];
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, bad)
    }));
    assert!(r.is_err(), "an invalid signature must be rejected");
}

#[test]
fn b2_stale_observation_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    let day10 = 10 * 24 * 3600;
    ctx(owner(), 0, day10);
    let sig = sign_obs("berlin", day3, 250, day10, 1, contract_id());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.report_observation("berlin".to_string(), day3, 250, day10, 1, sig)
    }));
    assert!(r.is_err(), "a stale observation must be rejected");
}

#[test]
fn b3_implausible_value_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 100_000, day3 + 60, 1, contract_id());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.report_observation("berlin".to_string(), day3, 100_000, day3 + 60, 1, sig)
    }));
    assert!(r.is_err(), "an implausible value must be rejected");
}

#[test]
fn b4_duplicate_observation_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);
    let sig2 = sign_obs("berlin", day3, 5, day3 + 120, 2, contract_id());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.report_observation("berlin".to_string(), day3, 5, day3 + 120, 2, sig2)
    }));
    assert!(r.is_err(), "re-reporting the same (city,date) must be rejected");
}

#[test]
fn b6_challenge_window_blocks_flash_settlement() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);
    // 1 second later — inside the challenge window.
    ctx(owner(), 0, day3 + 61);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "settling inside the challenge window must fail");
}

#[test]
fn b7_disputed_observation_cannot_settle() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);

    // A watchdog disputes with a bond.
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3);
    c.challenge_observation("berlin".to_string(), day3, 5);
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a disputed observation must not settle");
}

#[test]
fn b7b_owner_upholds_dispute_and_pool_keeps_the_bond() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3);
    c.challenge_observation("berlin".to_string(), day3, 5);
    let capital_before = c.get_pool().capital.0;
    ctx(owner(), 0, day3 + 100);
    c.resolve_dispute("berlin".to_string(), day3, true); // uphold -> bond to pool
    assert_eq!(c.get_pool().capital.0, capital_before + ONE / 10);
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id), "after upholding, the honest observation pays");
    assert!(c.reconcile());
}

// --------------------------------------------------------------------------
// C — mechanics
// --------------------------------------------------------------------------

#[test]
fn c1_double_settlement_is_rejected() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 250, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 250, day3 + 60, 1, sig);
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a policy must settle at most once");
}

#[test]
fn c4_non_provider_cannot_withdraw() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("attacker.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(U128(ONE))));
    assert!(r.is_err());
}

#[test]
fn c5_cannot_withdraw_more_than_own_capital() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 100 * ONE, 0);
    c.deposit();
    ctx("lp1.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(U128(150 * ONE))));
    assert!(r.is_err());
}

#[test]
fn c2_premium_never_rounds_to_zero() {
    let c = setup();
    // 3% of 1 yocto must ceil to 1 yocto.
    assert_eq!(c.quote("rain-berlin-20mm".to_string(), U128(1)).0, 1);
}

// --------------------------------------------------------------------------
// D — agent abuse / self-attestation
// --------------------------------------------------------------------------

#[test]
fn d5_buyer_cannot_self_attest() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    ctx("biz.testnet".parse().unwrap(), 0, day3 + 60);
    // The buyer signs with its OWN key, not the attestor's.
    let other = SigningKey::from_bytes(&[9u8; 32]);
    let msg = format!("overcover:v1|{}|{}|{}|{}|{}|{}", "berlin", day3, 999, day3 + 60, 1, contract_id());
    let sig = other.sign(msg.as_bytes()).to_bytes().to_vec();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.report_observation("berlin".to_string(), day3, 999, day3 + 60, 1, sig)
    }));
    assert!(r.is_err(), "only the registered attestor's signature is accepted");
}

// --------------------------------------------------------------------------
// solvency invariant + reconciliation under a mixed sequence
// --------------------------------------------------------------------------

#[test]
fn invariant_and_reconciliation_hold_across_a_sequence() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    let mut ids = vec![];
    for i in 0..5 {
        let buyer: AccountId = format!("b{}.testnet", i).parse().unwrap();
        ctx(buyer, 3 * ONE, 0);
        ids.push(c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None));
        assert!(c.check_invariant());
        assert!(c.reconcile());
    }
    let day3 = 3 * 24 * 3600;
    ctx(owner(), 0, day3 + 60);
    let sig = sign_obs("berlin", day3, 300, day3 + 60, 1, contract_id());
    c.report_observation("berlin".to_string(), day3, 300, day3 + 60, 1, sig);
    ctx(owner(), 0, day3 + 7200);
    for id in ids {
        c.resolve(id);
        assert!(c.check_invariant());
        assert!(c.reconcile());
    }
    assert_eq!(c.get_pool().total_paid.0, 500 * ONE);
    assert_eq!(c.get_pool().reserved.0, 0);
}
