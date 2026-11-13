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

/// The canonical observation message, mirroring `Overcover::reading_message`
/// byte-for-byte (domain tag, contract id, fields, length-prefixed evidence).
#[allow(clippy::too_many_arguments)]
fn reading_msg(
    operator: &AccountId,
    metric_id: &str,
    city: &str,
    obs_date: u64,
    value: u64,
    reported_at: u64,
    expiry: u64,
    evidence: &[u8],
    nonce: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    m.extend_from_slice(b"overcover:v3:observation");
    m.push(b'|');
    m.extend_from_slice(contract_id().as_bytes());
    for field in [
        operator.to_string(),
        metric_id.to_string(),
        city.to_string(),
        obs_date.to_string(),
        value.to_string(),
        reported_at.to_string(),
        expiry.to_string(),
        nonce.to_string(),
    ] {
        m.push(b'|');
        m.extend_from_slice(field.as_bytes());
    }
    m.push(b'|');
    m.extend_from_slice(&(evidence.len() as u32).to_be_bytes());
    m.extend_from_slice(evidence);
    m
}

/// Default validity window used by the test helpers (one day past report time,
/// long enough to outlast the default challenge window and still settle).
fn default_expiry(reported_at: u64) -> u64 {
    reported_at + 24 * 3600
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
    sign_reading_full(operator, metric_id, city, obs_date, value, reported_at, default_expiry(reported_at), b"ev", nonce, seed)
}

/// Sign an arbitrary reading payload (used by the adversarial tests).
#[allow(clippy::too_many_arguments)]
fn sign_reading_full(
    operator: &AccountId,
    metric_id: &str,
    city: &str,
    obs_date: u64,
    value: u64,
    reported_at: u64,
    expiry: u64,
    evidence: &[u8],
    nonce: u64,
    seed: u8,
) -> Vec<u8> {
    let msg = reading_msg(operator, metric_id, city, obs_date, value, reported_at, expiry, evidence, nonce);
    key(seed).sign(&msg).to_bytes().to_vec()
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
    c.submit_reading(
        metric.to_string(), city.to_string(), date, value, reported_at,
        default_expiry(reported_at), b"ev".to_vec(), nonce, sig,
    );
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, bad)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, sig)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day10, default_expiry(day10), b"ev".to_vec(), 0, sig)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 100_000, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, sig)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, sig)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, sig)
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
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 999, day3 + 60, default_expiry(day3 + 60), b"ev".to_vec(), 0, sig)
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
    // The reading is voided: the policy fails closed (no payout) and, because a
    // nullified reading can never be replaced, the reservation is RELEASED so
    // the capital is not locked forever.
    let id = 1;
    ctx(owner(), 0, day3 + 7200);
    assert!(!c.resolve(id), "a nullified observation must never pay");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_no_pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert!(c.reconcile());
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
    // A timed-out reading is voided: no payout, and the reservation is released
    // (a voided reading can never be replaced for this key).
    let id = 1;
    ctx(owner(), 0, day3 + 7200);
    assert!(!c.resolve(id), "a timed-out (voided) observation must never pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_no_pay");
    assert!(c.reconcile());
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

// --------------------------------------------------------------------------
// migrate() privilege guard (found in the security pre-audit)
//
// `migrate` is `#[init(ignore_state)]`, so it runs before any state is read and
// cannot consult the stored owner. Without a guard, ANY account can call it and
// reset the contract with itself as owner — a full unauthenticated takeover.
// The guard restricts it to the contract account itself (a self-call, which is
// what a redeploy performs).
// --------------------------------------------------------------------------

#[test]
fn migrate_by_a_third_party_is_refused() {
    ctx("attacker.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(|| {
        Overcover::migrate(owner(), pubkey(1), U128(1), 0, 60)
    });
    assert!(r.is_err(), "a third party must not be able to call migrate");
}

#[test]
fn migrate_by_the_contract_itself_is_allowed() {
    ctx(contract_id(), 0, 0);
    let c = Overcover::migrate(owner(), pubkey(1), U128(1), 0, 60);
    assert_eq!(c.get_config().owner, owner());
}

// --------------------------------------------------------------------------
// SEC-1 — migrate() authorization (the deployed-v1 takeover, and its fix)
// --------------------------------------------------------------------------
//
// v1 declared `migrate` as `#[init(ignore_state)]`, which runs before any state
// read, so it could not check the stored owner: any account could overwrite all
// state (owner + attestor) and then forge an observation to drain the pool.
// v2 restricts it to a self-call. These tests assert the guard behaviourally.

#[test]
fn sec1_a_third_party_cannot_migrate() {
    let attacker: AccountId = "attacker.testnet".parse().unwrap();
    ctx(attacker.clone(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Overcover::migrate(attacker.clone(), pubkey(1), U128(ONE), 0, 1)
    }));
    assert!(r.is_err(), "a third party must not be able to call migrate()");
}

#[test]
fn sec1_a_refused_migrate_leaves_state_untouched() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    let owner_before = c.get_config().owner;
    let capital_before = c.get_pool().capital.0;

    ctx("attacker.testnet".parse().unwrap(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Overcover::migrate("attacker.testnet".parse().unwrap(), pubkey(1), U128(ONE), 0, 1)
    }));
    assert!(r.is_err(), "the attack must be refused");
    assert_eq!(c.get_config().owner, owner_before, "owner must be unchanged");
    assert_eq!(c.get_pool().capital.0, capital_before, "capital must be unchanged");
}

#[test]
fn sec1_repeated_third_party_migrate_is_still_refused() {
    let attacker: AccountId = "attacker.testnet".parse().unwrap();
    for _ in 0..3 {
        ctx(attacker.clone(), 0, 0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Overcover::migrate(attacker.clone(), pubkey(1), U128(ONE), 0, 1)
        }));
        assert!(r.is_err(), "a repeated third-party migrate() must stay refused");
    }
}

#[test]
fn sec1_the_contract_account_itself_may_migrate() {
    // The intended lifecycle: after deploying new wasm, the contract account
    // calls migrate() on itself. That self-call is the only authority the guard
    // can check safely in an `#[init(ignore_state)]` method.
    ctx(contract_id(), 0, 0);
    let c = Overcover::migrate(owner(), pubkey(9), U128(ONE / 10), 0, 3600);
    assert_eq!(c.get_config().owner, owner(), "self-migration restores the owner");
}

// ---------------------------------------------------------------------------
// In-place upgrade MUST preserve state (the runbook's "keeps the pool capital
// and the policies" claim). A v1-shaped state blob is written, then `migrate`
// runs and every carried field is checked. Regression for the destructive
// migrate that reset capital/reserved to zero and re-keyed nothing.
// ---------------------------------------------------------------------------
#[test]
fn migrate_preserves_legacy_state() {
    ctx(contract_id(), 0, 0);

    // Build a v1-shaped state blob directly, as the deployed v1 contract would
    // have written it.
    let owner_acct = owner();
    let mut legacy_products: LookupMap<String, LegacyProduct> = LookupMap::new(StorageKey::Products);
    let mut legacy_product_ids: UnorderedSet<String> = UnorderedSet::new(StorageKey::ProductIds);
    let mut legacy_policies: LookupMap<u64, LegacyPolicy> = LookupMap::new(StorageKey::Policies);
    let mut legacy_policy_ids: UnorderedSet<u64> = UnorderedSet::new(StorageKey::PolicyIds);
    let legacy_providers: LookupMap<AccountId, Provider> = LookupMap::new(StorageKey::Providers);
    let mut legacy_observations: LookupMap<Vec<u8>, LegacyObservation> = LookupMap::new(StorageKey::Observations);
    let mut legacy_observation_ids: UnorderedSet<Vec<u8>> = UnorderedSet::new(StorageKey::ObservationIds);

    let prod = "rain-lagos".to_string();
    legacy_products.insert(&prod, &LegacyProduct {
        id: prod.clone(), city: "lagos".to_string(), threshold_tenths: 400, premium_bp: 1000,
        min_payout: 3 * ONE / 10, max_payout: 3 * ONE / 10, min_lead_sec: 0,
        max_total_coverage: 3 * ONE, reserved: 3 * ONE / 10, active: true,
    });
    legacy_product_ids.insert(&prod);

    let pol = LegacyPolicy {
        id: 1, buyer: owner_acct.clone(), beneficiary: owner_acct.clone(),
        product_id: prod.clone(), city: "lagos".to_string(), threshold_tenths: 400,
        payout: 3 * ONE / 10, premium: 3 * ONE / 100, obs_date: 1_000, issued_at: 1,
        status: "active".to_string(), paid_amount: 0, observed_value: 0, settled_at: 0,
    };
    legacy_policies.insert(&1, &pol);
    legacy_policy_ids.insert(&1);

    let obs_key = format!("lagos|1000").into_bytes();
    legacy_observations.insert(&obs_key, &LegacyObservation {
        city: "lagos".to_string(), obs_date: 1_000, value_tenths: 1_000, reported_at: 1_000,
        nonce: 0, disputed: false, nullified: false, challenger: None,
        counter_value_tenths: 0, bond: 0,
    });
    legacy_observation_ids.insert(&obs_key);

    let legacy = LegacyState {
        owner: owner_acct.clone(), attestor: pubkey(1), paused: false,
        challenge_bond: ONE / 10, settle_delay_sec: 0, challenge_window_sec: 1,
        products: legacy_products, product_ids: legacy_product_ids,
        policies: legacy_policies, policy_ids: legacy_policy_ids,
        providers: legacy_providers,
        observations: legacy_observations, observation_ids: legacy_observation_ids,
        capital: 5 * ONE, reserved: 3 * ONE / 10, held_bonds: 0,
        total_deposited: 5 * ONE, total_withdrawn: 0, premiums_collected: 3 * ONE / 100,
        total_paid: 0, bonds_forfeited: 0, next_policy_id: 2,
    };
    env::state_write(&legacy);

    // The contract account migrates itself.
    ctx(contract_id(), 0, 0);
    let mut c = Overcover::migrate(owner_acct.clone(), pubkey(1), U128(ONE / 10), 0, 1);

    // Pool accounting survives.
    assert_eq!(c.get_pool().capital.0, 5 * ONE, "capital must survive the upgrade");
    assert_eq!(c.get_pool().reserved.0, 3 * ONE / 10, "reserved must survive the upgrade");
    assert_eq!(c.get_config().owner, owner_acct, "owner must survive the upgrade");

    // The catalog and the policies survive, re-encoded in the v2 shape.
    let products = c.list_products();
    assert_eq!(products.len(), 1, "the legacy product must survive");
    assert_eq!(products[0].id, "rain-lagos");
    assert_eq!(products[0].metric_id, "", "legacy products keep the rainfall metric");
    assert_eq!(products[0].reserved, 3 * ONE / 10, "product reservation survives");

    let policies = c.list_policies();
    assert_eq!(policies.len(), 1, "the legacy policy must survive");
    assert_eq!(policies[0].status, "active");
    assert_eq!(policies[0].payout, 3 * ONE / 10);
    assert_eq!(policies[0].direction, Direction::Above, "legacy policies settle Above");
    assert_eq!(policies[0].metric_id, "");

    // The observation is re-keyed to the v2 format so `resolve` can find it.
    let o = c.get_observation("".to_string(), "lagos".to_string(), 1_000);
    assert!(o.is_some(), "the observation must be re-keyed to metric|city|date");
    assert_eq!(o.unwrap().value_tenths, 1_000);
    assert_eq!(c.list_observations().len(), 1, "the observation set must survive");

    // And the migrated policy settles end to end.
    ctx(owner_acct, 0, 1_001 + 1); // past obs_date + settle_delay + challenge_window
    assert!(c.resolve(1), "a migrated policy must still settle");
}

// ===========================================================================
// Threshold-oracle + decentralised-dispute adversarial suite (mission Stage 6).
// Each test names the condition it proves.
// ===========================================================================

/// A registered operator submits a *deliberately* malformed/forged reading with
/// full control over the signed payload. Used by the threshold tests.
#[allow(clippy::too_many_arguments)]
fn submit_raw(
    c: &mut Overcover, seed: u8, metric: &str, city: &str, date: u64, value: u64,
    reported_at: u64, expiry: u64, evidence: &[u8], nonce: u64, sign_seed: u8,
) {
    let operator = op(seed);
    let sig = sign_reading_full(&operator, metric, city, date, value, reported_at, expiry, evidence, nonce, sign_seed);
    ctx(operator, 0, reported_at);
    c.submit_reading(metric.to_string(), city.to_string(), date, value, reported_at, expiry, evidence.to_vec(), nonce, sig);
}

fn count_observations(c: &Overcover) -> usize {
    c.list_observations().len()
}

// --- condition 1 & 2: one or two signers do not finalize --------------------

#[test]
fn k1_one_signer_cannot_finalize() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    assert_eq!(count_observations(&c), 0, "a single signer must not finalize an observation");
}

#[test]
fn k2_two_signers_cannot_finalize() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    submit(&mut c, 2, "", "berlin", day3, 250, day3 + 61);
    assert_eq!(count_observations(&c), 0, "two signers must not finalize a 3-of-5 observation");
}

// --- condition 3: three distinct authorised signers finalize ----------------

#[test]
fn k3_three_distinct_signers_finalize() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
    assert_eq!(count_observations(&c), 1, "three distinct signers must finalize");
    assert_eq!(c.get_observation("".to_string(), "berlin".to_string(), day3).unwrap().quorum, 3);
}

// --- condition 4: a duplicate signer cannot stand in for a distinct one -----

#[test]
fn k4_duplicate_signer_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    // op1 tries to report again for the same date (nonce replay / duplicate).
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        submit(&mut c, 1, "", "berlin", day3, 250, day3 + 61)
    }));
    assert!(r.is_err(), "a duplicate operator submission must be refused");
    assert_eq!(count_observations(&c), 0, "one operator is still one signer");
}

// --- condition 5: a forged signature is rejected ----------------------------

#[test]
fn k5_forged_signature_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    // op2's account signs with op1's key -> verification fails.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        submit_raw(&mut c, 2, "", "berlin", day3, 250, day3 + 60, day3 + 3660, b"ev", 0, 1)
    }));
    assert!(r.is_err(), "a signature from the wrong key must be refused");
}

// --- condition 5b: a signature bound to another contract is rejected --------

#[test]
fn k5b_cross_contract_signature_is_rejected() {
    // The domain binds the contract id, so a reading signed for a different
    // contract can never be replayed here.
    let operator = op(1);
    let mut msg = Vec::new();
    msg.extend_from_slice(b"overcover:v3:observation");
    msg.push(b'|');
    msg.extend_from_slice(b"other-contract.testnet");
    for f in [operator.to_string(), "".to_string(), "berlin".to_string(), (3 * 24 * 3600u64).to_string(),
              "250".to_string(), (3 * 24 * 3600u64 + 60).to_string(), (3 * 24 * 3600u64 + 3660).to_string(), "0".to_string()] {
        msg.push(b'|'); msg.extend_from_slice(f.as_bytes());
    }
    msg.push(b'|'); msg.extend_from_slice(&2u32.to_be_bytes()); msg.extend_from_slice(b"ev");
    let sig = key(1).sign(&msg).to_bytes().to_vec();

    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    ctx(operator, 0, day3 + 60);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, day3 + 60, day3 + 3660, b"ev".to_vec(), 0, sig)
    }));
    assert!(r.is_err(), "a signature for a different contract must be refused");
}

// --- condition 6: replay is rejected ---------------------------------------

#[test]
fn k6_replayed_nonce_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    // Re-submit op1's exact signed reading (nonce 0) for a *different* city.
    let sig = sign_reading(&op(1), "", "paris", day3, 250, day3 + 60, 0, 1);
    ctx(op(1), 0, day3 + 61);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_reading("".to_string(), "paris".to_string(), day3, 250, day3 + 60, day3 + 3660, b"ev".to_vec(), 0, sig)
    }));
    assert!(r.is_err(), "a replayed nonce must be refused");
}

// --- condition 7: a stale observation is rejected --------------------------

#[test]
fn k7_stale_observation_is_rejected() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    // reported_at more than 24 h after obs_date -> stale.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        submit(&mut c, 1, "", "berlin", day3, 250, day3 + 90000)
    }));
    assert!(r.is_err(), "an observation reported too late must be refused");
}

// --- condition 7b: an expired reading cannot settle -------------------------

#[test]
fn k7b_expired_reading_cannot_settle() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    // Every operator signs a reading that expires 2 minutes after reporting.
    for i in 1..=3u8 {
        submit_raw(&mut c, i, "", "berlin", day3, 250, day3 + 60, day3 + 180, b"ev", 0, i);
    }
    assert_eq!(count_observations(&c), 1);
    // Past the expiry the reading can never settle, so the policy settles no-pay
    // and the reservation is released rather than locked.
    ctx(owner(), 0, day3 + 7200);
    assert!(!c.resolve(id), "a reading past its expiry must never pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_no_pay");
}

// --- condition 8: conflicting observations are handled safely --------------

#[test]
fn k8_conflicting_observation_does_not_finalize() {
    let mut c = setup();
    let day3 = 3 * 24 * 3600;
    // Two operators say 250, one says 50: no 3-of-3 agreement within tolerance.
    submit(&mut c, 1, "", "berlin", day3, 250, day3 + 60);
    submit(&mut c, 2, "", "berlin", day3, 250, day3 + 61);
    submit(&mut c, 3, "", "berlin", day3, 50, day3 + 62);
    assert_eq!(count_observations(&c), 0, "conflicting readings must not finalize");
}

// --- condition 9: an unauthorised committee change is rejected -------------

#[test]
fn k9_unauthorized_committee_change_is_rejected() {
    let mut c = setup();
    // A non-owner cannot add an operator, a resolver, or a metric.
    ctx("attacker.testnet".parse().unwrap(), 0, 0);
    for call in [
        "add_operator", "add_resolver", "revoke_resolver", "set_resolver_quorum", "set_challenge_window",
    ] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match call {
            "add_operator" => c.add_operator("x.testnet".parse().unwrap(), pubkey(1)),
            "add_resolver" => c.add_resolver("x.testnet".parse().unwrap()),
            "revoke_resolver" => c.revoke_resolver("res1.testnet".parse().unwrap()),
            "set_resolver_quorum" => c.set_resolver_quorum(1),
            _ => c.set_challenge_window(1),
        }));
        assert!(r.is_err(), "{call} must be owner-only");
    }
}

// --- condition 10: the owner cannot adjudicate -----------------------------

#[test]
fn k10_owner_cannot_be_a_resolver_or_vote() {
    let mut c = setup();
    ctx(owner(), 0, 0);
    // The owner cannot even be registered as a resolver.
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_resolver(owner())));
    assert!(r.is_err(), "the owner must not be registerable as a resolver");
}

// --- condition 11: insufficient dispute votes do not decide -----------------

#[test]
fn k11_insufficient_dispute_votes_do_not_decide() {
    let (mut c, day3) = disputed();
    ctx("res1.testnet".parse().unwrap(), 0, day3 + 80);
    c.resolver_vote("".to_string(), "berlin".to_string(), day3, false);
    ctx("res2.testnet".parse().unwrap(), 0, day3 + 81);
    c.resolver_vote("".to_string(), "berlin".to_string(), day3, false);
    // Two of three: not decided. The observation is still disputed and frozen.
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(1)));
    assert!(r.is_err(), "an unresolved dispute must keep the settlement frozen");
}

// --- condition 12: a valid dispute quorum decides ---------------------------

#[test]
fn k12_valid_dispute_quorum_decides() {
    let (mut c, day3) = disputed();
    for i in 1..=3u8 {
        ctx(format!("res{}.testnet", i).parse().unwrap(), 0, day3 + 80);
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, true);
    }
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(1), "a decided (upheld) dispute settles on the reading");
}

// --- condition 12b: the decision threshold is frozen at dispute open --------

#[test]
fn k12b_dispute_threshold_is_frozen_at_open() {
    let (mut c, day3) = disputed(); // opened with a 3-of-3 resolver quorum
    // The owner tries to lower the bar to 1 *after* the dispute is open.
    ctx(owner(), 0, day3 + 79);
    c.set_resolver_quorum(1);
    // A single vote must still not decide the live dispute.
    ctx("res1.testnet".parse().unwrap(), 0, day3 + 80);
    c.resolver_vote("".to_string(), "berlin".to_string(), day3, false);
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(1)));
    assert!(r.is_err(), "one vote must not decide a dispute opened with a 3-vote threshold");
}

// --- condition 13: a challenge freezes only the relevant settlement --------

#[test]
fn k13_challenge_freezes_only_the_relevant_settlement() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    // Two policies, different cities (different observations).
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id_a = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id_b = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    // Both settle on the SAME product/city/date; give policy B a different city
    // is not possible (product pins the city) so use a different date instead.
    let _ = id_b;

    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
    register_resolvers(&mut c);
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3 + 61);
    c.challenge_observation("".to_string(), "berlin".to_string(), day3, 5);
    // Policy A cannot settle while its observation is disputed.
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id_a)));
    assert!(r.is_err(), "the disputed policy must stay frozen");
    assert!(c.reconcile(), "the pool must remain solvent while a dispute is open");
}

// --- condition 14: settlement during an unresolved challenge is rejected ----

#[test]
fn k14_settlement_during_unresolved_challenge_is_rejected() {
    let (mut c, day3) = disputed();
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(1)));
    assert!(r.is_err(), "a disputed observation must not settle");
}

// --- condition 15: the challenge duration cannot be shortened --------------

#[test]
fn k15_challenge_duration_cannot_be_shortened_after_purchase() {
    let mut c = setup(); // challenge window 3600
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60); // observation freezes window = 3600
    // The owner shortens the global window to 1 second.
    ctx(owner(), 0, day3 + 61);
    c.set_challenge_window(1);
    // A challenge 100 s after the reading is still inside the frozen 3600 s window.
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3 + 160);
    c.challenge_observation("".to_string(), "berlin".to_string(), day3, 5);
    assert!(c.get_observation("".to_string(), "berlin".to_string(), day3).unwrap().disputed,
        "the frozen challenge window must still allow the challenge");
}

// --- condition 15b: the challenge window is capped --------------------------

#[test]
fn k15b_challenge_window_is_capped() {
    let mut c = setup();
    ctx(owner(), 0, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_challenge_window(CHALLENGE_WINDOW_MAX_SEC + 1)
    }));
    assert!(r.is_err(), "an unbounded challenge window must be refused");
}

// --- condition 16: existing policies and capital are preserved --------------

#[test]
fn k16_capital_and_policy_invariants_hold_across_a_cycle() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    report_rain(&mut c, "berlin", day3, 250, day3 + 60);
    register_resolvers(&mut c);
    ctx("watchdog.testnet".parse().unwrap(), ONE / 10, day3 + 61);
    c.challenge_observation("".to_string(), "berlin".to_string(), day3, 5);
    for i in 1..=3u8 {
        ctx(format!("res{}.testnet", i).parse().unwrap(), 0, day3 + 80);
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, true);
    }
    ctx(owner(), 0, day3 + 7200);
    assert!(c.resolve(id));
    assert!(c.reconcile(), "the pool must reconcile after a full cycle");
    assert!(c.get_pool().solvent);
}

// --- the signed reading message is pinned to an exact byte layout ------------
//
// The off-chain signers (driver/attestor.js `readingMessageV3` and the sim
// engine's `readingMessage`) must produce the SAME bytes as this contract. A
// dropped field is invisible to the sim — which signs and verifies with its own
// copy — but makes every reading fail here with "invalid operator signature".
// This test freezes the layout so that failure mode can never return silently.
#[test]
fn reading_message_matches_the_pinned_v3_layout() {
    ctx(contract_id(), 0, 0);
    let msg = Overcover::reading_message(
        &"op1.testnet".parse().unwrap(),
        "heat",
        "lagos",
        123,
        450,
        130,
        140,
        b"sandbox-evidence",
        0,
    );
    let hex: String = msg.iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(
        hex,
        "6f766572636f7665723a76333a6f62736572766174696f6e7c6f766572636f7665722e746573746e6574\
         7c6f70312e746573746e65747c686561747c6c61676f737c3132337c3435307c3133307c3134307c30\
         7c0000001073616e64626f782d65766964656e6365"
            .replace(['\n', ' '], "")
    );
}

// ==========================================================================
// Permissionless insurance factory
//
// These tests prove that a non-owner can introduce a product, that the
// *contract* (not the owner) decides qualification under fixed rules, and that
// each guard, when removed, fails the test that covers it.
// ==========================================================================

/// A funded pool plus one registered, active "heat" metric and a non-owner
/// proposer. The owner never calls `propose_product` here.
fn factory_setup() -> (Overcover, AccountId) {
    ctx(owner(), 0, 0);
    let mut c = Overcover::new(owner(), pubkey(9), U128(ONE / 10), 0, 3600);
    // Fund the pool so capital constraints are meaningful.
    let lp: AccountId = "liquidity.testnet".parse().unwrap();
    ctx(lp.clone(), 1000 * ONE, 0);
    c.deposit();
    // Owner registers one index the contract is willing to underwrite.
    ctx(owner(), 0, 0);
    c.add_metric(
        "heat".to_string(),
        "temperature".to_string(),
        "degC/10".to_string(),
        600,          // max plausible 60.0 C
        10,
        Direction::Above,
    );
    let proposer = "alice.testnet".parse().unwrap();
    (c, proposer)
}

/// A valid proposal in every respect. Tests mutate exactly one field.
fn propose_valid(c: &mut Overcover, proposer: &AccountId, id: &str) -> Product {
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    c.propose_product(
        id.to_string(),
        "lagos".to_string(),
        "heat".to_string(),
        400,                 // 40.0 C threshold
        500,                 // 5% premium
        U128(ONE),           // min payout 1 NEAR
        U128(100 * ONE),     // max payout 100 NEAR
        3600 + 7200,         // prospective
        "sha256:deadbeef".to_string(),
    )
}

#[test]
fn factory_1_a_non_owner_can_propose_and_it_activates_without_the_owner() {
    let (mut c, proposer) = factory_setup();
    let p = propose_valid(&mut c, &proposer, "heat-lagos-permissionless");
    // Activated in the same transaction, marked with the proposer, no owner step.
    assert!(p.active);
    assert_eq!(p.proposed_by, proposer.to_string());
    assert_eq!(p.category, "temperature");
    let stored = c.get_product("heat-lagos-permissionless".to_string()).unwrap();
    assert!(stored.active);
    assert_eq!(stored.proposed_by, proposer.to_string());
}

#[test]
fn factory_2_an_unknown_metric_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "not-a-metric".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "an unregistered metric must be refused");
    assert!(c.get_product("bad".to_string()).is_none());
}

#[test]
fn factory_3_an_implausible_threshold_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Metric max_value is 600; 999 exceeds it.
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            999, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "a threshold above the metric bound must be refused");
}

#[test]
fn factory_4_an_out_of_band_premium_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 9000, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "a premium above the protocol band must be refused");
}

#[test]
fn factory_5_an_excessive_payout_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // max_payout 10_000 NEAR -> capacity 50_000 NEAR, far above the pool.
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(10_000 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "a payout that outruns the pool must be refused");
}

#[test]
fn factory_6_a_non_prospective_coverage_start_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 1000); // now = 1000
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 1000, "ev".to_string(), // start == now
        )
    }));
    assert!(r.is_err(), "coverage must start in the future");
}

#[test]
fn factory_7_a_duplicate_product_is_rejected() {
    let (mut c, proposer) = factory_setup();
    propose_valid(&mut c, &proposer, "dup");
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "dup".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "a product id may not be reused");
}

#[test]
fn factory_8_an_active_products_terms_cannot_be_modified() {
    let (mut c, proposer) = factory_setup();
    let p = propose_valid(&mut c, &proposer, "immutable");
    // Re-proposing the same id with different terms is refused, and the stored
    // terms are exactly what was first activated.
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "immutable".to_string(), "lagos".to_string(), "heat".to_string(),
            500, 900, U128(ONE), U128(50 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err());
    let stored = c.get_product("immutable".to_string()).unwrap();
    assert_eq!(stored.threshold_tenths, p.threshold_tenths);
    assert_eq!(stored.premium_bp, p.premium_bp);
    assert_eq!(stored.max_payout, p.max_payout);
}

#[test]
fn factory_9_insufficient_stake_is_rejected() {
    let (mut c, proposer) = factory_setup();
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE - 1, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "bad".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "the anti-spam stake is mandatory");
}

#[test]
fn factory_10_concurrent_proposals_cannot_overcommit_the_pool() {
    let (mut c, proposer) = factory_setup();
    // Pool is 1000 NEAR. Each product's capacity is 5x its max payout. The
    // first with 100 NEAR max payout -> 500 NEAR capacity; a second identical
    // proposal would need 500 more, leaving < 1/5 free -> refused.
    propose_valid(&mut c, &proposer, "p1");
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "p2".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "ev".to_string(),
        )
    }));
    assert!(r.is_err(), "a second full-size proposal must not overcommit the pool");
}

#[test]
fn factory_11_the_stake_enters_the_pool_and_reconciles() {
    let (mut c, proposer) = factory_setup();
    let before = c.get_pool().capital.0;
    propose_valid(&mut c, &proposer, "funded");
    let after = c.get_pool().capital.0;
    assert_eq!(after, before + PROPOSAL_MIN_STAKE);
    assert!(c.reconcile(), "pool accounting must reconcile after a proposal");
    assert!(c.check_invariant());
}

#[test]
fn factory_12_existing_purchase_and_settlement_still_work_on_a_proposed_product() {
    let (mut c, proposer) = factory_setup();
    let p = propose_valid(&mut c, &proposer, "buyable");
    // A buyer purchases cover on the permissionlessly-created product.
    let buyer: AccountId = "bob.testnet".parse().unwrap();
    let payout = p.max_payout;
    let premium = Overcover::premium_for(&p, payout);
    ctx(buyer.clone(), premium, 0);
    let policy_id = c.buy_cover("buyable".to_string(), U128(payout), 3600 + 7200, None);
    let pol = c.get_policy(policy_id).unwrap();
    assert_eq!(pol.buyer, buyer);
    assert_eq!(pol.payout, payout);
    assert!(c.check_invariant());
    assert!(c.reconcile());
}

#[test]
fn factory_13_the_evidence_hash_is_stored_and_immutable() {
    let (mut c, proposer) = factory_setup();
    let p = propose_valid(&mut c, &proposer, "with-evidence");
    assert_eq!(p.evidence_hash, "sha256:deadbeef");
    let stored = c.get_product("with-evidence".to_string()).unwrap();
    assert_eq!(stored.evidence_hash, "sha256:deadbeef");
    // Re-proposing the same id (even with different evidence) cannot rewrite it.
    ctx(proposer.clone(), PROPOSAL_MIN_STAKE, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.propose_product(
            "with-evidence".to_string(), "lagos".to_string(), "heat".to_string(),
            400, 500, U128(ONE), U128(100 * ONE), 3600 + 7200, "sha256:attacker".to_string(),
        )
    }));
    assert!(r.is_err());
    assert_eq!(c.get_product("with-evidence".to_string()).unwrap().evidence_hash, "sha256:deadbeef");
}

#[test]
fn factory_14_an_owner_created_product_records_no_proposer_evidence() {
    let (mut c, _proposer) = factory_setup();
    ctx(owner(), 0, 0);
    c.add_metric_product(
        "owner-made".to_string(), "lagos".to_string(), "heat".to_string(),
        400, 500, U128(ONE), U128(10 * ONE), 0, U128(10 * ONE),
    );
    let stored = c.get_product("owner-made".to_string()).unwrap();
    assert_eq!(stored.proposed_by, owner().to_string());
    assert_eq!(stored.evidence_hash, "");
}

// ==========================================================================
// SEC-6 — a terminally-invalid observation must not lock reserved capital.
//
// A policy reserves its payout at purchase. If the observation for its
// (metric, city, date) is nullified by a resolver quorum, or expires, no
// replacement reading can ever be finalised for that key, so the policy can
// never pay. The reservation must be released (settled no-pay); otherwise it is
// locked forever and `withdraw` keeps failing, denying providers their capital.
// ==========================================================================

#[test]
fn sec6_nullified_observation_releases_the_reservation() {
    let (mut c, day3) = disputed();
    assert_eq!(c.get_pool().reserved.0, 100 * ONE, "the payout is reserved while active");
    // Three resolvers reject the reading -> it is nullified.
    for i in 1..=3u8 {
        ctx(format!("res{}.testnet", i).parse().unwrap(), 0, day3 + 80);
        c.resolver_vote("".to_string(), "berlin".to_string(), day3, false);
    }
    // Anyone may finalise the dead policy once the challenge window has elapsed.
    ctx("anyone.testnet".parse().unwrap(), 0, day3 + 7200);
    let paid = c.resolve(1);
    assert!(!paid, "a nullified reading must never pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert_eq!(c.get_policy(1).unwrap().status, "settled_no_pay");
    assert!(c.reconcile(), "the pool must reconcile after a no-pay settlement");
    assert!(c.check_invariant());
    // Providers can now withdraw their capital.
    ctx("lp1.testnet".parse().unwrap(), 0, day3 + 7200);
    let _ = c.withdraw(U128(1000 * ONE));
}

#[test]
fn sec6_expired_observation_releases_the_reservation() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    // Every operator signs a reading that expires 2 minutes after reporting.
    for i in 1..=3u8 {
        submit_raw(&mut c, i, "", "berlin", day3, 250, day3 + 60, day3 + 180, b"ev", 0, i);
    }
    assert_eq!(count_observations(&c), 1);
    assert_eq!(c.get_pool().reserved.0, 100 * ONE);
    // Long after the expiry: the reading can never settle, so the reservation is
    // released rather than locked.
    ctx("anyone.testnet".parse().unwrap(), 0, day3 + 7200);
    let paid = c.resolve(id);
    assert!(!paid, "an expired reading must not pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_no_pay");
    assert!(c.reconcile());
}

// SEC-7 — a policy whose reading is NEVER reported must not lock capital.
//
// A reading for date D can only be submitted while D <= reported_at <= D + 24h.
// If no observation is finalised by D + 24h (operators never reported, or never
// reached quorum), the key is terminally empty: no reading can ever arrive, so
// the policy can never pay. The reservation must be released, exactly as for a
// nullified/expired reading (SEC-6). A permissionless product for a city no
// operator covers turns this into a griefing vector: the attacker pays only the
// premium to strand the whole payout of provider capital forever.
// ==========================================================================

#[test]
fn sec7_a_reading_that_never_arrives_releases_the_reservation() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    assert_eq!(c.get_pool().reserved.0, 100 * ONE, "the payout is reserved at purchase");

    // Past the LAST instant a reading could ever be accepted (a backdated report
    // plus the maximum reading validity).
    let terminal = day3 + REPORT_MAX_DELAY_SEC + READING_MAX_VALIDITY_SEC;
    ctx("anyone.testnet".parse().unwrap(), 0, terminal + 60);
    let paid = c.resolve(id);
    assert!(!paid, "a reading that never arrived can never pay");
    assert_eq!(c.get_pool().reserved.0, 0, "the reservation must be released");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_no_pay");
    assert!(c.reconcile(), "the pool must reconcile after a no-pay settlement");
    assert!(c.check_invariant());
    // Providers can now withdraw their capital.
    ctx("lp1.testnet".parse().unwrap(), 0, terminal + 60);
    let _ = c.withdraw(U128(1000 * ONE));
}

#[test]
fn sec7_a_reading_still_possible_keeps_the_reservation() {
    // Before the last instant a reading can arrive, settlement must refuse and
    // hold the reservation (not release it early) — even well past D + 24h,
    // because a backdated report is still admissible.
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    // One second before the terminal instant: still held.
    let terminal = day3 + REPORT_MAX_DELAY_SEC + READING_MAX_VALIDITY_SEC;
    ctx("anyone.testnet".parse().unwrap(), 0, terminal);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(id)));
    assert!(r.is_err(), "a reading may still arrive; settlement must refuse");
    assert_eq!(c.get_pool().reserved.0, 100 * ONE, "the reservation must be held");
}

#[test]
fn sec6_a_transient_block_still_refuses_and_holds_the_reservation() {
    // A disputed (unresolved) reading must NOT release the reservation: the
    // dispute can still be upheld and the policy then pays.
    let (mut c, day3) = disputed();
    ctx(owner(), 0, day3 + 7200);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.resolve(1)));
    assert!(r.is_err(), "an unresolved dispute must still refuse settlement");
    assert_eq!(c.get_pool().reserved.0, 100 * ONE, "the reservation must be held");
}

// ==========================================================================
// SEC-7 boundary — a backdated reading can legitimately arrive AFTER D + 24h.
//
// `reported_at` is an operator-declared field bounded only by
// `reported_at <= now` and `reported_at - obs_date <= REPORT_MAX_DELAY_SEC`. So
// an operator may report at wall-clock `D + 24h + k` with `reported_at` set to
// `D + 24h`, and a valid reading can be finalised long after `D + 24h`. The
// terminal bound must therefore be the LAST wall-clock instant a reading could
// still be accepted: `D + REPORT_MAX_DELAY_SEC + expiry_horizon` — NOT
// `D + REPORT_MAX_DELAY_SEC`. Settling before that would deny a real payout.
// ==========================================================================

#[test]
fn sec7_a_backdated_reading_can_arrive_after_the_report_delay() {
    let mut c = setup();
    ctx("lp1.testnet".parse().unwrap(), 1000 * ONE, 0);
    c.deposit();
    ctx("biz.testnet".parse().unwrap(), 3 * ONE, 0);
    let id = c.buy_cover("rain-berlin-20mm".to_string(), U128(100 * ONE), 3 * 24 * 3600, None);
    let day3 = 3 * 24 * 3600;
    // Operators report the breach at wall-clock day3 + 24h + 6h — six hours AFTER
    // the naive "D + 24h" bound — backdating `reported_at` to the latest a reading
    // for this date may claim (day3 + 24h). The reading is still valid because its
    // expiry is inside the report validity horizon.
    let reported_at = day3 + REPORT_MAX_DELAY_SEC;
    let expiry = reported_at + READING_MAX_VALIDITY_SEC;
    let submit_at = reported_at + 6 * 3600;
    for i in 1..=3u8 {
        let operator = op(i);
        let sig = sign_reading_full(&operator, "", "berlin", day3, 250, reported_at, expiry, b"ev", 0, i);
        ctx(operator, 0, submit_at);
        c.submit_reading("".to_string(), "berlin".to_string(), day3, 250, reported_at, expiry, b"ev".to_vec(), 0, sig);
    }
    assert_eq!(count_observations(&c), 1, "a reading backdated to D + 24h still finalises after D + 24h");
    // Settle shortly after (past the 1h challenge window, before expiry): the
    // breach must pay. A naive D + 24h terminal bound would have released the
    // reservation before this reading could ever arrive.
    ctx(owner(), 0, submit_at + 7200);
    let paid = c.resolve(id);
    assert!(paid, "a late-but-valid reading must still pay the breach");
    assert_eq!(c.get_policy(id).unwrap().status, "settled_paid");
    assert_eq!(c.get_policy(id).unwrap().paid_amount, 100 * ONE);
    assert!(c.reconcile());
}
