//! Rust unit tests for Overcover — the on-chain mirror of the reference
//! adversarial suite (`research/model/attacks.mjs`). Each test names the attack
//! it mirrors where applicable. Run: `cd contract && cargo test`.
//!
//! The oracle is a multi-operator quorum. Tests register three operators with
//! distinct keys, so a single operator can never finalize a reading on its own.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000_000_000; // 1 NEAR

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}
fn pubkey(seed: u8) -> Vec<u8> {
    key(seed).verifying_key().to_bytes().to_vec()
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

fn contract_id() -> AccountId {
    "overcover.testnet".parse().unwrap()
}

fn op(i: u8) -> AccountId {
    format!("op{}.testnet", i).parse().unwrap()
}

/// The signed message for a reading, mirroring `Overcover::reading_message`.
#[allow(clippy::too_many_arguments)]
fn sign_reading(
    operator: &AccountId,
    metric_id: &str,
    city: &str,
    obs_date: u64,
    value: u64,
    reported_at: u64,
    nonce: u64,
    seed: u8,
) -> Vec<u8> {
    let msg = format!(
        "overcover:v2|{}|{}|{}|{}|{}|{}|{}|{}",
        operator, metric_id, city, obs_date, value, reported_at, nonce, contract_id()
    );
    key(seed).sign(msg.as_bytes()).to_bytes().to_vec()
}

/// Register three operators (seeds 1..=3) and set a 3-of-3 quorum.
fn register_ops(c: &mut Overcover) {
    ctx(owner(), 0, 0);
    for i in 1..=3u8 {
        c.add_operator(op(i), pubkey(i));
    }
    c.set_quorum(3);
}

/// Register three independent resolvers and a 3-of-3 resolver quorum.
fn register_resolvers(c: &mut Overcover) {
    ctx(owner(), 0, 0);
    for i in 1..=3u8 {
        c.add_resolver(format!("res{}.testnet", i).parse().unwrap());
    }
    c.set_resolver_quorum(3);
}

/// Submit one reading from operator `i` (nonce = its reading count).
fn submit(c: &mut Overcover, i: u8, metric: &str, city: &str, date: u64, value: u64, reported_at: u64) {
    let operator = op(i);
    let nonce = c.get_operator(operator.clone()).map(|o| o.readings).unwrap_or(0);
    let sig = sign_reading(&operator, metric, city, date, value, reported_at, nonce, i);
    ctx(operator, 0, reported_at);
    c.submit_reading(metric.to_string(), city.to_string(), date, value, reported_at, nonce, sig);
}

/// Finalize an observation for a legacy rainfall product (metric id "") using
/// all three operators reporting the same value.
fn report_rain(c: &mut Overcover, city: &str, date: u64, value: u64, reported_at: u64) {
    for i in 1..=3u8 {
        submit(c, i, "", city, date, value, reported_at);
    }
}

fn setup() -> Overcover {
    ctx(owner(), 0, 0);
    let mut c = Overcover::new(owner(), pubkey(9), U128(ONE / 10), 0, 3600);
    register_ops(&mut c);
    ctx(owner(), 0, 0);
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

    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);

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
    report_rain(&mut c, "berlin", day3, 50, day3 + 60); // 5.0 mm
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
// B — oracle (multi-operator quorum)
// --------------------------------------------------------------------------

#[test]
fn b1_bad_signature_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    ctx(op(1), 0, day3 + 60);
    let bad = vec![0u8; 64];
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, 0, bad)
    }));
    assert!(r.is_err(), "an invalid signature must be rejected");
}

#[test]
fn b1b_one_operator_cannot_finalize() {
    // A single operator (even a registered one) must not finalize a reading
    // when the quorum requires three.
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    ctx(owner(), 0, day3 + 60);
    assert!(
        c.get_observation("".to_string(), "berlin".to_string(), day3).is_none(),
        "one operator is below quorum; no observation may be finalized"
    );
}

#[test]
fn b1c_unregistered_operator_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    let rogue: AccountId = "rogue.testnet".parse().unwrap();
    let sig = sign_reading(&rogue, "", "berlin", day3, 250, day3 + 60, 0, 5);
    ctx(rogue, 0, day3 + 60);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, 0, sig)
    }));
    assert!(r.is_err(), "an unregistered operator must be rejected");
}

#[test]
fn b2_stale_observation_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    let day10 = 10 * 24 * 3600;
    let sig = sign_reading(&op(1), "", "berlin", day3, 250, day10, 0, 1);
    ctx(op(1), 0, day10);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day10, 0, sig)
    }));
    assert!(r.is_err(), "a stale observation must be rejected");
}

#[test]
fn b3_implausible_value_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    let sig = sign_reading(&op(1), "", "berlin", day3, 100_000, day3 + 60, 0, 1);
    ctx(op(1), 0, day3 + 60);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 100_000, day3 + 60, 0, sig)
    }));
    assert!(r.is_err(), "an implausible value must be rejected");
}

#[test]
fn b4_replayed_reading_is_rejected() {
    // After an operator reports, its nonce advances; the same signed reading
    // can never be replayed.
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    // Replay the exact nonce-0 signature.
    let sig = sign_reading(&op(1), "", "berlin", day3, 250, day3 + 60, 0, 1);
    ctx(op(1), 0, day3 + 120);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, 0, sig)
    }));
    assert!(r.is_err(), "a replayed reading must be rejected");
}

#[test]
fn b5_revoked_operator_cannot_submit() {
    let mut c = setup();
    ctx(owner(), 0, 0);
    c.revoke_operator(op(3));
    let day3 = 3 * 24 * 3600;
    let sig = sign_reading(&op(3), "", "berlin", day3, 250, day3 + 60, 0, 3);
    ctx(op(3), 0, day3 + 60);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, 0, sig)
    }));
    assert!(r.is_err(), "a revoked operator must be rejected");
}

#[test]
fn b6_challenge_window_blocks_flash_settlement() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
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
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);

    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3 + 61);
    c.challenge_observation("".to_string(), "berlin".to_string(), day3, 5);
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a disputed observation must not settle");
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
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
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
    // The buyer is not a registered operator.
    let biz: AccountId = "biz.testnet".parse().unwrap();
    let sig = sign_reading(&biz, "", "berlin", day3, 999, day3 + 60, 0, 9);
    ctx(biz, 0, day3 + 60);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 999, day3 + 60, 0, sig)
    }));
    assert!(r.is_err(), "only registered operators are accepted");
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
    report_rain(&mut c, "berlin", day3, 300, day3 + 60);
    ctx(owner(), 0, day3 + 7200);
    for id in ids {
        c.resolve(id);
        assert!(c.check_invariant());
        assert!(c.reconcile());
    }
    assert_eq!(c.get_pool().total_paid.0, 500 * ONE);
    assert_eq!(c.get_pool().reserved.0, 0);
}

// --------------------------------------------------------------------------
// F — generic metrics and multiple risk categories
// --------------------------------------------------------------------------

/// Build a contract with a `heat` metric (temperature, Above) and a `drought`
/// metric (rainfall deficit, Below), each with a product.
fn setup_metrics() -> Overcover {
    ctx(owner(), 0, 0);
    let mut c = Overcover::new(owner(), pubkey(9), U128(ONE / 10), 0, 3600);
    register_ops(&mut c);
    ctx(owner(), 0, 0);
    c.add_metric("heat".to_string(), "temperature".to_string(), "degC/10".to_string(), 700, 10, Direction::Above);
    c.add_metric("drought".to_string(), "drought".to_string(), "mm/10".to_string(), 5000, 10, Direction::Below);
    ctx(owner(), 0, 0);
    c.add_metric_product(
        "heat-lagos-40c".to_string(), "lagos".to_string(), "heat".to_string(),
        400, 400, U128(ONE), U128(100 * ONE), 24 * 3600, U128(5000 * ONE),
    );
    ctx(owner(), 0, 0);
    c.add_metric_product(
        "drought-lagos".to_string(), "lagos".to_string(), "drought".to_string(),
        200, 500, U128(ONE), U128(100 * ONE), 24 * 3600, U128(5000 * ONE),
    );
    c
}

#[test]
fn f1_heat_above_threshold_pays() {
    let mut c = setup_metrics();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 4 * ONE, 0);
    let id = c.buy_cover("heat-lagos-40c".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    // 41.0 degC: above the 40.0 threshold -> pays.
    for i in 1..=3u8 {
        submit(&mut c, i, "heat", "lagos", day3, 410, day3 + 60);
    }
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id));
    assert_eq!(c.get_policy(id).unwrap().status, "settled_paid");
}

#[test]
fn f2_drought_below_threshold_pays_and_above_does_not() {
    let mut c = setup_metrics();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    // Below-direction product: pays when the reading is <= threshold (deficit).
    ctx("biz.testnet".parse().unwrap(), 5 * ONE, 0);
    let id = c.buy_cover("drought-lagos".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    for i in 1..=3u8 {
        submit(&mut c, i, "drought", "lagos", day3, 100, day3 + 60); // 10.0 mm <= 20.0 -> pay
    }
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id), "drought deficit at/below threshold must pay");

    // A second policy where the reading is ABOVE the threshold must not pay.
    ctx("lp1.testnet".parse().unwrap(), 0, day3 + 7200);
    let day6 = 6 * 24 * 3600;
    ctx("biz.testnet".parse().unwrap(), 5 * ONE, day3 + 7200);
    let id2 = c.buy_cover("drought-lagos".to_string(), U128(100 * ONE), day6, None);
    for i in 1..=3u8 {
        submit(&mut c, i, "drought", "lagos", day6, 900, day6 + 60); // 90.0 mm > 20.0 -> no pay
    }
    ctx(owner(), 0, day6 + 7200);
    assert!(!c.resolve(id2), "a wet reading must not trigger a drought policy");
}

#[test]
fn f3_metric_threshold_above_max_is_rejected() {
    let mut c = setup_metrics();
    ctx(owner(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.add_metric_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            900, 400, U128(ONE), U128(100 * ONE), 24 * 3600, U128(5000 * ONE),
        )
    }));
    assert!(r.is_err(), "a threshold above the metric max_value must be rejected");
}

// --------------------------------------------------------------------------
// G — decentralized dispute resolution
// --------------------------------------------------------------------------

/// A finalized, disputed observation. Returns the contract and the day.
fn disputed() -> (Overcover, u64) {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
    register_resolvers(&mut c);
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3 + 61);
    c.challenge_observation("".to_string(), "berlin".to_string(), day3, 5);
    (c, day3)
}

#[test]
fn g1_operator_cannot_resolve_its_own_dispute() {
    let (mut c, day3) = disputed();
    // op(1) signed the reading; make it a resolver too and try to vote.
    ctx(owner(), 0, day3 + 70);
    c.add_resolver(op(1));
    ctx(op(1), 0, day3 + 70);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, false)
    }));
    assert!(r.is_err(), "a signer must not resolve its own dispute");
}

#[test]
fn g2_challenger_cannot_resolve_its_own_dispute() {
    let (mut c, day3) = disputed();
    ctx(owner(), 0, day3 + 70);
    c.add_resolver("watchdog.testnet".parse().unwrap());
    ctx("watchdog.testnet".parse().unwrap(), 0, day3 + 70);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, false)
    }));
    assert!(r.is_err(), "the challenger must not resolve its own dispute");
}

#[test]
fn g3_resolver_quorum_upholds_and_pool_keeps_the_bond() {
    let (mut c, day3) = disputed();
    let capital_before = c.get_pool().capital.0;
    for i in 1..=3u8 {
        ctx(format!("res{}.testnet", i).parse().unwrap(), 0, day3 + 80);
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, true);
    }
    assert_eq!(c.get_pool().capital.0, capital_before + ONE / 10, "upheld -> bond forfeited to pool");
    // The honest reading now settles and pays.
    let id = 1;
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id));
    assert!(c.reconcile());
}

#[test]
fn g4_resolver_quorum_nullifies_and_refunds_the_bond() {
    let (mut c, day3) = disputed();
    for i in 1..=3u8 {
        ctx(format!("res{}.testnet", i).parse().unwrap(), 0, day3 + 80);
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, false);
    }
    // The reading is voided: the policy fails closed and does not pay.
    let id = 1;
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a nullified observation must not settle");
}

#[test]
fn g5_resolver_cannot_vote_twice() {
    let (mut c, day3) = disputed();
    ctx("res1.testnet".parse().unwrap(), 0, day3 + 80);
    c.resolver_vote("".to_string(), "berlin".to_string(), day3, true);
    ctx("res1.testnet".parse().unwrap(), 0, day3 + 81);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, true)
    }));
    assert!(r.is_err(), "a resolver must not vote twice");
}

#[test]
fn g6_owner_cannot_unilaterally_resolve_a_dispute() {
    // There is no owner-only resolution path any more; the owner must go
    // through the independent resolver quorum like everyone else.
    let (mut c, day3) = disputed();
    // The owner is not a registered resolver, so it cannot vote.
    ctx(owner(), 0, day3 + 80);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, true)
    }));
    assert!(r.is_err(), "the owner cannot unilaterally resolve a dispute");
}

#[test]
fn g7_timeout_voids_the_reading_and_refunds_the_challenger() {
    let (mut c, day3) = disputed();
    // No resolver quorum. After the dispute window, anyone may time it out.
    ctx("anyone.testnet".parse().unwrap(), 0, day3 + 61 + 3601);
    c.timeout_dispute("".to_string(), "berlin".to_string(), day3);
    let id = 1;
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a timed-out (voided) observation must not settle");
}

// --------------------------------------------------------------------------
// Multi-provider capital accounting
// --------------------------------------------------------------------------

#[test]
fn h1_two_providers_share_one_pool_and_reserved_le_capital() {
    let mut c = setup();
    ctx("lpa.testnet".parse().unwrap(), 600 * ONE, 0);
    c.deposit();
    ctx("lpb.testnet".parse().unwrap(), 400 * ONE, 0);
    c.deposit();
    assert_eq!(c.get_pool().capital.0, 1000 * ONE);

    // Two 100 NEAR policies.
    for i in 0..2 {
        let buyer: AccountId = format!("b{}.testnet", i).parse().unwrap();
        ctx(buyer, 3 * ONE, 0);
        c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
        assert!(c.check_invariant(), "reserved <= capital after every buy");
    }
    assert_eq!(c.get_pool().reserved.0, 200 * ONE);

    // lpB may withdraw only its unencumbered share.
    ctx("lpb.testnet".parse().unwrap(), 0, 0);
    c.withdraw(U128(400 * ONE));
    assert!(c.check_invariant());
    assert_eq!(c.get_provider("lpb.testnet".parse().unwrap()).withdrawn, 400 * ONE);

    // After paying claims, both providers' accounting still reconciles.
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 300, day3 + 60);
    ctx(owner(), 0, day3 + 7200);
    c.resolve(1);
    c.resolve(2);
    assert!(c.check_invariant());
    assert!(c.reconcile());
    assert_eq!(c.get_pool().reserved.0, 0);
}
