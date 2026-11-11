//! Overcover — an autonomous parametric risk mutual on NEAR.
//!
//! The contract is the financial authority. It:
//!   * lets capital providers deposit and withdraw *unencumbered* NEAR,
//!   * publishes immutable "products" (a risk definition: city, threshold,
//!     premium rate, payout bounds, min lead, capacity),
//!   * issues policies, RESERVING the full payout at issuance,
//!   * verifies an ed25519-signed observation from a registered attestor,
//!   * settles a policy exactly once, paying the beneficiary iff the validated
//!     observation meets the product's threshold,
//!   * enforces a single solvency invariant after every state change:
//!         reserved <= capital
//!
//! The design was adversarially validated before implementation; see
//! `research/OVERcover_ADVERSARIAL_FEASIBILITY.md`. The single most important
//! finding (E1) is why `buy_cover` does NOT accept a caller-supplied threshold
//! or premium: both are owned by the immutable product.

use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::{LookupMap, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

/// Money is yoctoNEAR (u128). Rainfall is tenths of a millimetre (u64).
/// Time is unix seconds (u64).
pub type Yocto = u128;

/// Implausible rainfall is rejected at the contract boundary.
const MAX_RAINFALL_TENTHS: u64 = 5_000; // 500.0 mm
/// A premium rate above 50% is a configuration error.
const MAX_PREMIUM_BP: u32 = 5_000;
/// An observation must be reported within this window after its date.
const REPORT_MAX_DELAY_SEC: u64 = 24 * 3600;
/// Seconds in a nanosecond-epoch conversion.
const NS_PER_SEC: u64 = 1_000_000_000;
/// A dispute is "open" until its `resolved_at` is set to this sentinel.
const DISPUTE_OPEN: u64 = u64::MAX;

/// Abort with a message the NEAR runtime keeps in the receipt. std's wasm panic
/// handler turns panics into a bare `unreachable` trap and discards the message,
/// so every user-facing refusal calls the `panic_utf8` host function directly.
#[cfg(target_arch = "wasm32")]
fn fail(msg: &str) -> ! {
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn panic_utf8(len: u64, ptr: u64) -> !;
    }
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}
#[cfg(not(target_arch = "wasm32"))]
fn fail(msg: &str) -> ! {
    panic!("{}", msg)
}

macro_rules! ensure {
    ($cond:expr, $($arg:tt)*) => {
        if !$cond {
            fail(&format!($($arg)*));
        }
    };
}

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Products,
    ProductIds,
    Policies,
    PolicyIds,
    Providers,
    Observations,
    ObservationIds,
    // ---- v2 (decentralized oracle + disputes + index registry) ----
    Operators,
    OperatorIds,
    Readings,
    // Per-observation sets need a UNIQUE storage prefix, so the key is part of
    // the storage key. Reusing one constant prefix would make every set share
    // the same underlying storage.
    ReadingsByObs { key: Vec<u8> },
    ReadingSigners,
    Metrics,
    MetricIds,
    Disputes,
    DisputeKeys,
    Resolvers,
    ResolverIds,
    DisputeVoters { key: Vec<u8> },
    DisputeVotersMap,
}

/// Direction of a trigger relative to the threshold.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq)]
pub enum Direction {
    /// The event occurs when the measured value is AT OR ABOVE the threshold
    /// (excess rainfall, extreme heat, high wind).
    Above,
    /// The event occurs when the measured value is AT OR BELOW the threshold
    /// (drought / rainfall deficit).
    Below,
}

/// A measurement index the contract is willing to underwrite. This is what
/// removes the rainfall assumption from the product model: a product references
/// a metric, and the metric carries the category, unit, plausibility bounds and
/// trigger direction. Adding a new risk family is a `add_metric` call, not a
/// contract change.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Metric {
    pub id: String,
    /// Coarse family: "precipitation" | "temperature" | "wind" | ...
    pub category: String,
    /// Physical unit the values are encoded in, e.g. "mm/10", "degC/10", "m/s/10".
    pub unit: String,
    /// Highest plausible value (plausibility bound for observations).
    pub max_value: u64,
    /// The scale applied to human units so values stay integers (usually 10).
    pub scale: u32,
    pub direction: Direction,
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Product {
    pub id: String,
    pub city: String,
    /// Metric this product is written against (empty for legacy rainfall products).
    pub metric_id: String,
    /// Metric category, copied at publication for cheap display/filtering.
    pub category: String,
    pub threshold_tenths: u64,
    pub premium_bp: u32,
    pub min_payout: Yocto,
    pub max_payout: Yocto,
    pub min_lead_sec: u64,
    pub max_total_coverage: Yocto,
    /// Outstanding liability currently reserved for this product.
    pub reserved: Yocto,
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    pub id: u64,
    pub buyer: AccountId,
    pub beneficiary: AccountId,
    pub product_id: String,
    pub city: String,
    /// Metric and direction are copied from the product at issuance so
    /// settlement never needs a second lookup and cannot drift.
    pub metric_id: String,
    pub direction: Direction,
    pub threshold_tenths: u64,
    pub payout: Yocto,
    pub premium: Yocto,
    pub obs_date: u64,
    pub issued_at: u64,
    pub status: String, // active | settled_paid | settled_no_pay
    pub paid_amount: Yocto,
    pub observed_value: u64,
    pub settled_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Provider {
    pub deposited: Yocto,
    pub withdrawn: Yocto,
}

/// A registered oracle operator. Each operator has its own account and its own
/// ed25519 key; the account is the identity that registers a reading, and the
/// key is what proves the reading came from that operator.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Operator {
    pub account: AccountId,
    pub public_key: Vec<u8>,
    pub active: bool,
    pub registered_at: u64,
    pub revoked_at: u64,
    /// Number of readings this operator has submitted (monotonic, used as the
    /// per-operator replay nonce).
    pub readings: u64,
}

/// One operator's signed reading for a given (metric, location, date). A
/// quorum of these is what finalizes an observation.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Reading {
    pub operator: AccountId,
    pub value_tenths: u64,
    pub reported_at: u64,
    pub nonce: u64,
}

/// The aggregated, quorum-finalized reading for a (metric, location, date).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Observation {
    /// Metric this reading is for.
    pub metric_id: String,
    /// Location / region identifier (a city for weather indices).
    pub city: String,
    pub obs_date: u64,
    /// Aggregated value: the median of the accepted readings.
    pub value_tenths: u64,
    pub reported_at: u64,
    /// Number of distinct operators whose readings were accepted.
    pub quorum: u32,
    /// Dispute key that finalization produced (empty until first finalized).
    pub dispute_key: Vec<u8>,
    pub disputed: bool,
    pub nullified: bool,
    pub challenger: Option<AccountId>,
    pub counter_value_tenths: u64,
    pub bond: Yocto,
}

/// A finalized observation that can be contested. Created when the reading
/// reaches quorum; a dispute is opened on it by a bonded challenger and decided
/// by an independent resolver quorum.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Dispute {
    pub key: Vec<u8>,
    pub metric_id: String,
    pub city: String,
    pub obs_date: u64,
    pub value_tenths: u64,
    /// Operators that signed the reading under dispute (they may not resolve it).
    pub signers: Vec<AccountId>,
    pub opened_at: u64,
    pub challenger: AccountId,
    pub counter_value_tenths: u64,
    pub bond: Yocto,
    /// u64::MAX = open.
    pub resolved_at: u64,
    pub uphold: bool,
    pub upheld_votes: u32,
    pub nullified_votes: u32,
}

/// An independent dispute resolver (a human reviewer or an external body).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Resolver {
    pub account: AccountId,
    pub active: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Overcover {
    pub owner: AccountId,
    /// LEGACY single attestor key. Superseded by the operator registry but kept
    /// so pre-upgrade deployments deserialize and `get_config` still reports it.
    pub attestor: Vec<u8>,
    pub paused: bool,
    pub challenge_bond: Yocto,
    pub settle_delay_sec: u64,
    pub challenge_window_sec: u64,

    // ---- v2: decentralized oracle + disputes ----
    /// Operators allowed to sign readings.
    pub operators: LookupMap<AccountId, Operator>,
    /// Ordered set of operator accounts.
    pub operator_ids: UnorderedSet<AccountId>,
    /// One operator's reading, keyed by `reading_key(metric, location, date, operator)`.
    pub readings: LookupMap<Vec<u8>, Reading>,
    /// Distinct operators that have submitted for a given `obs_key`.
    pub reading_signers: LookupMap<Vec<u8>, UnorderedSet<AccountId>>,
    /// Number of distinct operators required to finalize a reading.
    pub quorum: u32,
    /// Registered independent dispute resolvers.
    pub resolvers: LookupMap<AccountId, Resolver>,
    pub resolver_ids: UnorderedSet<AccountId>,
    /// Number of independent resolver votes required to decide a dispute.
    pub resolver_quorum: u32,
    /// How long after a dispute opens before it may be decided by timeout.
    pub dispute_window_sec: u64,
    /// Measurement indices the contract underwrites.
    pub metrics: LookupMap<String, Metric>,
    pub metric_ids: UnorderedSet<String>,
    /// Disputes keyed by their observation key.
    pub disputes: LookupMap<Vec<u8>, Dispute>,
    pub dispute_keys: UnorderedSet<Vec<u8>>,
    /// Which resolvers have voted on which dispute key.
    pub dispute_voters: LookupMap<Vec<u8>, UnorderedSet<AccountId>>,
    /// Policy settlement delay is measured from `obs_date`; unchanged.

    pub products: LookupMap<String, Product>,
    pub product_ids: UnorderedSet<String>,
    pub policies: LookupMap<u64, Policy>,
    pub policy_ids: UnorderedSet<u64>,
    pub providers: LookupMap<AccountId, Provider>,
    pub observations: LookupMap<Vec<u8>, Observation>,
    /// Ordered set of observation keys, so views can enumerate them.
    pub observation_ids: UnorderedSet<Vec<u8>>,

    // ---- pool accounting (all yoctoNEAR) ----
    /// Deposits - withdrawals + premiums - payouts. Excludes held dispute bonds.
    pub capital: Yocto,
    /// Sum of payouts of ACTIVE policies.
    pub reserved: Yocto,
    /// Bonds held for open disputes (not part of `capital`).
    pub held_bonds: Yocto,
    // reconciliation counters
    pub total_deposited: Yocto,
    pub total_withdrawn: Yocto,
    pub premiums_collected: Yocto,
    pub total_paid: Yocto,
    /// Sum of challenge bonds forfeited to the pool (part of `capital`).
    pub bonds_forfeited: Yocto,
    pub next_policy_id: u64,
}

impl Overcover {
    fn new_state(
        owner: AccountId,
        attestor: Vec<u8>,
        challenge_bond: U128,
        settle_delay_sec: u64,
        challenge_window_sec: u64,
        quorum: u32,
        resolver_quorum: u32,
        dispute_window_sec: u64,
    ) -> Self {
        Self {
            owner,
            attestor,
            paused: false,
            challenge_bond: challenge_bond.0,
            settle_delay_sec,
            challenge_window_sec,
            operators: LookupMap::new(StorageKey::Operators),
            operator_ids: UnorderedSet::new(StorageKey::OperatorIds),
            readings: LookupMap::new(StorageKey::Readings),
            reading_signers: LookupMap::new(StorageKey::ReadingSigners),
            quorum,
            resolvers: LookupMap::new(StorageKey::Resolvers),
            resolver_ids: UnorderedSet::new(StorageKey::ResolverIds),
            resolver_quorum,
            dispute_window_sec,
            metrics: LookupMap::new(StorageKey::Metrics),
            metric_ids: UnorderedSet::new(StorageKey::MetricIds),
            disputes: LookupMap::new(StorageKey::Disputes),
            dispute_keys: UnorderedSet::new(StorageKey::DisputeKeys),
            dispute_voters: LookupMap::new(StorageKey::DisputeVotersMap),
            products: LookupMap::new(StorageKey::Products),
            product_ids: UnorderedSet::new(StorageKey::ProductIds),
            policies: LookupMap::new(StorageKey::Policies),
            policy_ids: UnorderedSet::new(StorageKey::PolicyIds),
            providers: LookupMap::new(StorageKey::Providers),
            observations: LookupMap::new(StorageKey::Observations),
            observation_ids: UnorderedSet::new(StorageKey::ObservationIds),
            capital: 0,
            reserved: 0,
            held_bonds: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            premiums_collected: 0,
            total_paid: 0,
            bonds_forfeited: 0,
            next_policy_id: 1,
        }
    }
}

#[near]
impl Overcover {
    #[init]
    pub fn new(
        owner: AccountId,
        attestor: Vec<u8>,
        challenge_bond: U128,
        settle_delay_sec: u64,
        challenge_window_sec: u64,
    ) -> Self {
        ensure!(attestor.len() == 32, "attestor key must be 32 bytes");
        // Sensible v2 defaults: 3-of-5 operator quorum, 3 independent resolvers,
        // a one-hour dispute window. The owner may tune these with setters.
        Self::new_state(owner, attestor, challenge_bond, settle_delay_sec, challenge_window_sec, 3, 3, 3600)
    }

    /// Re-initialize in place (deploy new wasm, then call this). Overwrites any
    /// previous state, so a redeploy never requires deleting the account.
    #[init(ignore_state)]
    pub fn migrate(
        owner: AccountId,
        attestor: Vec<u8>,
        challenge_bond: U128,
        settle_delay_sec: u64,
        challenge_window_sec: u64,
    ) -> Self {
        Self::new(owner, attestor, challenge_bond, settle_delay_sec, challenge_window_sec)
    }

    // ---------------------------------------------------------------------
    // admin
    // ---------------------------------------------------------------------

    fn assert_owner(&self) {
        ensure!(
            env::predecessor_account_id() == self.owner,
            "only the owner may do this"
        );
    }

    pub fn set_attestor(&mut self, attestor: Vec<u8>) {
        self.assert_owner();
        ensure!(attestor.len() == 32, "attestor key must be 32 bytes");
        self.attestor = attestor;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Register a measurement index. Products reference a metric; the metric
    /// owns the category, unit, plausibility bound and trigger direction, so the
    /// product model has no rainfall assumption baked in.
    pub fn add_metric(
        &mut self,
        id: String,
        category: String,
        unit: String,
        max_value: u64,
        scale: u32,
        direction: Direction,
    ) {
        self.assert_owner();
        ensure!(self.metrics.get(&id).is_none(), "metric already exists");
        ensure!(max_value > 0, "max_value must be > 0");
        ensure!(scale > 0 && scale <= 10_000, "scale out of range");
        let m = Metric { id: id.clone(), category, unit, max_value, scale, direction, active: true };
        self.metrics.insert(&id, &m);
        self.metric_ids.insert(&id);
        log_event("metric_added", &[("id", &id)]);
    }

    pub fn set_metric_active(&mut self, id: String, active: bool) {
        self.assert_owner();
        let mut m = self.metrics.get(&id).unwrap_or_else(|| fail("no such metric"));
        m.active = active;
        self.metrics.insert(&id, &m);
    }

    /// Publish a product written against a metric. The metric must exist and be
    /// active; the threshold is validated against the metric's own bound.
    #[payable]
    pub fn add_metric_product(
        &mut self,
        id: String,
        city: String,
        metric_id: String,
        threshold_tenths: u64,
        premium_bp: u32,
        min_payout: U128,
        max_payout: U128,
        min_lead_sec: u64,
        max_total_coverage: U128,
    ) {
        self.assert_owner();
        let m = self.metrics.get(&metric_id).unwrap_or_else(|| fail("no such metric"));
        ensure!(m.active, "metric is inactive");
        ensure!(threshold_tenths <= m.max_value, "threshold above metric max_value");
        self.insert_product(
            id, city, metric_id, m.category, threshold_tenths, premium_bp,
            min_payout, max_payout, min_lead_sec, max_total_coverage,
        );
    }

    /// LEGACY rainfall product. Kept for backward compatibility with the
    /// deployed product catalogue and the driver. `metric_id` is empty and the
    /// threshold is bounded by the rainfall plausibility window.
    #[payable]
    pub fn add_product(
        &mut self,
        id: String,
        city: String,
        threshold_tenths: u64,
        premium_bp: u32,
        min_payout: U128,
        max_payout: U128,
        min_lead_sec: u64,
        max_total_coverage: U128,
    ) {
        self.assert_owner();
        ensure!(threshold_tenths <= MAX_RAINFALL_TENTHS, "threshold out of range");
        self.insert_product(
            id, city, String::new(), "precipitation".to_string(), threshold_tenths, premium_bp,
            min_payout, max_payout, min_lead_sec, max_total_coverage,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_product(
        &mut self,
        id: String,
        city: String,
        metric_id: String,
        category: String,
        threshold_tenths: u64,
        premium_bp: u32,
        min_payout: U128,
        max_payout: U128,
        min_lead_sec: u64,
        max_total_coverage: U128,
    ) {
        ensure!(self.products.get(&id).is_none(), "product already exists");
        ensure!(premium_bp <= MAX_PREMIUM_BP, "premium_bp too high");
        ensure!(min_payout.0 > 0, "min payout must be > 0");
        ensure!(max_payout.0 >= min_payout.0, "max payout below min");
        ensure!(
            max_total_coverage.0 >= max_payout.0,
            "capacity below a single max payout"
        );
        let p = Product {
            id: id.clone(),
            city,
            metric_id,
            category,
            threshold_tenths,
            premium_bp,
            min_payout: min_payout.0,
            max_payout: max_payout.0,
            min_lead_sec,
            max_total_coverage: max_total_coverage.0,
            reserved: 0,
            active: true,
        };
        self.products.insert(&id, &p);
        self.product_ids.insert(&id);
        log_event("product_added", &[("id", &id)]);
    }

    pub fn set_product_active(&mut self, id: String, active: bool) {
        self.assert_owner();
        let mut p = self.products.get(&id).unwrap_or_else(|| fail("no such product"));
        p.active = active;
        self.products.insert(&id, &p);
    }

    // ---------------------------------------------------------------------
    // oracle operator registry
    // ---------------------------------------------------------------------

    /// Register an oracle operator. The owner registers, but once registered an
    /// operator acts with its own key: it signs readings that only its own
    /// account can submit, and it cannot be impersonated.
    pub fn add_operator(&mut self, account: AccountId, public_key: Vec<u8>) {
        self.assert_owner();
        ensure!(public_key.len() == 32, "operator key must be 32 bytes");
        ensure!(self.operators.get(&account).is_none(), "operator already registered");
        let op = Operator {
            account: account.clone(),
            public_key,
            active: true,
            registered_at: now_sec(),
            revoked_at: 0,
            readings: 0,
        };
        self.operators.insert(&account, &op);
        self.operator_ids.insert(&account);
        log_event("operator_added", &[("account", &account.to_string())]);
    }

    /// Revoke an operator. Past readings remain valid evidence, but the operator
    /// can no longer submit.
    pub fn revoke_operator(&mut self, account: AccountId) {
        self.assert_owner();
        let mut op = self.operators.get(&account).unwrap_or_else(|| fail("no such operator"));
        ensure!(op.active, "operator already revoked");
        op.active = false;
        op.revoked_at = now_sec();
        self.operators.insert(&account, &op);
        log_event("operator_revoked", &[("account", &account.to_string())]);
    }

    /// Rotate an operator's key. The account stays the same; the new key takes
    /// over for all future readings.
    pub fn rotate_operator_key(&mut self, account: AccountId, new_public_key: Vec<u8>) {
        self.assert_owner();
        ensure!(new_public_key.len() == 32, "operator key must be 32 bytes");
        let mut op = self.operators.get(&account).unwrap_or_else(|| fail("no such operator"));
        op.public_key = new_public_key;
        self.operators.insert(&account, &op);
        log_event("operator_key_rotated", &[("account", &account.to_string())]);
    }

    pub fn set_quorum(&mut self, quorum: u32) {
        self.assert_owner();
        ensure!(quorum >= 1, "quorum must be >= 1");
        self.quorum = quorum;
    }

    // ---- dispute resolver registry ----

    pub fn add_resolver(&mut self, account: AccountId) {
        self.assert_owner();
        ensure!(self.resolvers.get(&account).is_none(), "resolver already registered");
        self.resolvers.insert(&account, &Resolver { account: account.clone(), active: true });
        self.resolver_ids.insert(&account);
        log_event("resolver_added", &[("account", &account.to_string())]);
    }

    pub fn revoke_resolver(&mut self, account: AccountId) {
        self.assert_owner();
        let mut r = self.resolvers.get(&account).unwrap_or_else(|| fail("no such resolver"));
        r.active = false;
        self.resolvers.insert(&account, &r);
        log_event("resolver_revoked", &[("account", &account.to_string())]);
    }

    pub fn set_resolver_quorum(&mut self, quorum: u32) {
        self.assert_owner();
        ensure!(quorum >= 1, "resolver quorum must be >= 1");
        self.resolver_quorum = quorum;
    }

    pub fn set_dispute_window(&mut self, secs: u64) {
        self.assert_owner();
        self.dispute_window_sec = secs;
    }

    // ---------------------------------------------------------------------
    // capital
    // ---------------------------------------------------------------------

    /// Deposit NEAR into the pool. The attached deposit is the amount.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        ensure!(amount > 0, "deposit must be > 0");
        let who = env::predecessor_account_id();
        let mut pr = self.providers.get(&who).unwrap_or(Provider {
            deposited: 0,
            withdrawn: 0,
        });
        pr.deposited = pr.deposited.checked_add(amount).unwrap_or_else(|| fail("overflow"));
        self.providers.insert(&who, &pr);
        self.capital = self.capital.checked_add(amount).unwrap_or_else(|| fail("overflow"));
        self.total_deposited = self.total_deposited.checked_add(amount).unwrap_or_else(|| fail("overflow"));
        self.check_invariant_or_panic();
        log_event("deposit", &[("account", &who.to_string()), ("amount", &amount.to_string())]);
        U128(pr.deposited - pr.withdrawn)
    }

    /// Withdraw only your own, unencumbered capital. Fails closed if the pool
    /// would no longer cover every outstanding liability.
    pub fn withdraw(&mut self, amount: U128) -> U128 {
        let amount = amount.0;
        ensure!(amount > 0, "withdraw must be > 0");
        let who = env::predecessor_account_id();
        let mut pr = self.providers.get(&who).unwrap_or_else(|| fail("not a provider"));
        let own = pr.deposited - pr.withdrawn;
        ensure!(amount <= own, "withdraw exceeds your own capital");
        // Solvency gate: after paying out, capital must still cover reserved.
        ensure!(
            self.capital.checked_sub(amount).map_or(false, |c| c >= self.reserved),
            "withdraw would break solvency (funds are reserved)"
        );
        pr.withdrawn = pr.withdrawn.checked_add(amount).unwrap_or_else(|| fail("overflow"));
        self.providers.insert(&who, &pr);
        self.capital -= amount;
        self.total_withdrawn = self.total_withdrawn.checked_add(amount).unwrap_or_else(|| fail("overflow"));
        self.check_invariant_or_panic();
        let _ = Promise::new(who.clone()).transfer(NearToken::from_yoctonear(amount));
        log_event("withdraw", &[("account", &who.to_string()), ("amount", &amount.to_string())]);
        U128(pr.deposited - pr.withdrawn)
    }

    // ---------------------------------------------------------------------
    // policies
    // ---------------------------------------------------------------------

    fn premium_for(p: &Product, payout: Yocto) -> Yocto {
        // ceil(payout * bp / 10000) — never zero for a positive payout.
        let num = (payout as u128)
            .checked_mul(p.premium_bp as u128)
            .unwrap_or_else(|| fail("overflow"));
        num.div_ceil(10_000)
    }

    pub fn quote(&self, product_id: String, payout: U128) -> U128 {
        let p = self.products.get(&product_id).unwrap_or_else(|| fail("no such product"));
        U128(Self::premium_for(&p, payout.0))
    }

    /// Buy cover. The premium is computed by the contract and must equal the
    /// attached deposit. The payout is reserved; the product's capacity cap and
    /// the pool's available capital are both enforced.
    #[payable]
    pub fn buy_cover(
        &mut self,
        product_id: String,
        payout: U128,
        obs_date: u64,
        beneficiary: Option<AccountId>,
    ) -> u64 {
        ensure!(!self.paused, "contract is paused");
        let p = self.products.get(&product_id).unwrap_or_else(|| fail("no such product"));
        ensure!(p.active, "product is inactive");
        let payout = payout.0;
        ensure!(
            payout >= p.min_payout && payout <= p.max_payout,
            "payout outside product bounds"
        );
        let now = now_sec();
        ensure!(
            obs_date >= now.saturating_add(p.min_lead_sec),
            "observation date too soon (min lead not met)"
        );
        ensure!(
            p.reserved.checked_add(payout).map_or(false, |r| r <= p.max_total_coverage),
            "product capacity exceeded"
        );
        let premium = Self::premium_for(&p, payout);
        ensure!(
            env::attached_deposit().as_yoctonear() == premium,
            "attached deposit must equal the quoted premium"
        );
        ensure!(
            self.available().checked_sub(payout).is_some(),
            "insufficient available capital to underwrite"
        );

        // Premium enters the pool first, then the payout is reserved.
        self.premiums_collected = self.premiums_collected.checked_add(premium).unwrap_or_else(|| fail("overflow"));
        self.capital = self.capital.checked_add(premium).unwrap_or_else(|| fail("overflow"));

        let id = self.next_policy_id;
        self.next_policy_id += 1;
        let buyer = env::predecessor_account_id();
        // Direction is a property of the index. Legacy rainfall products carry
        // an empty metric_id and are always "Above" (excess rainfall).
        let direction = self.product_direction(&p);
        let pol = Policy {
            id,
            buyer: buyer.clone(),
            beneficiary: beneficiary.unwrap_or(buyer),
            product_id: product_id.clone(),
            city: p.city.clone(),
            metric_id: p.metric_id.clone(),
            direction,
            threshold_tenths: p.threshold_tenths,
            payout,
            premium,
            obs_date,
            issued_at: now,
            status: "active".to_string(),
            paid_amount: 0,
            observed_value: 0,
            settled_at: 0,
        };
        self.policies.insert(&id, &pol);
        self.policy_ids.insert(&id);
        self.reserved = self.reserved.checked_add(payout).unwrap_or_else(|| fail("overflow"));
        let mut p2 = p;
        p2.reserved = p2.reserved.checked_add(payout).unwrap_or_else(|| fail("overflow"));
        self.products.insert(&product_id, &p2);
        self.check_invariant_or_panic();
        log_event(
            "policy_issued",
            &[
                ("id", &id.to_string()),
                ("buyer", &pol.buyer.to_string()),
                ("payout", &payout.to_string()),
                ("premium", &premium.to_string()),
            ],
        );
        id
    }

    // ---------------------------------------------------------------------
    // oracle (multi-operator, quorum-finalized)
    // ---------------------------------------------------------------------

    /// Observation key: binds metric, location and date. A reading for a
    /// different metric/location/date lands in a different slot, so a signature
    /// cannot be replayed across products.
    fn obs_key(metric_id: &str, city: &str, obs_date: u64) -> Vec<u8> {
        format!("{}|{}|{}", metric_id, city, obs_date).into_bytes()
    }

    fn reading_key(metric_id: &str, city: &str, obs_date: u64, operator: &AccountId) -> Vec<u8> {
        format!("{}|{}|{}|{}", metric_id, city, obs_date, operator).into_bytes()
    }

    /// The signed message binds the contract, the metric, the location, the
    /// date, the value, the report time and the operator's monotonic nonce. This
    /// is what makes a reading unforgeable and un-replayable: change any field
    /// and the signature no longer verifies.
    #[allow(clippy::too_many_arguments)]
    fn reading_message(
        operator: &AccountId,
        metric_id: &str,
        city: &str,
        obs_date: u64,
        value_tenths: u64,
        reported_at: u64,
        nonce: u64,
    ) -> Vec<u8> {
        format!(
            "overcover:v2|{}|{}|{}|{}|{}|{}|{}|{}",
            operator,
            metric_id,
            city,
            obs_date,
            value_tenths,
            reported_at,
            nonce,
            env::current_account_id()
        )
        .into_bytes()
    }

    fn metric_or_fail(&self, metric_id: &str) -> Metric {
        self.metrics.get(&metric_id.to_string()).unwrap_or_else(|| fail("no such metric"))
    }

    /// The (max_value, scale, direction) that governs a metric id. An empty id
    /// is the LEGACY rainfall product: it keeps the historical plausibility
    /// bound and "Above" direction, so pre-upgrade rainfall products settle
    /// exactly as before.
    fn metric_spec(&self, metric_id: &str) -> (u64, u32, Direction) {
        if metric_id.is_empty() {
            (MAX_RAINFALL_TENTHS, 10, Direction::Above)
        } else {
            let m = self.metric_or_fail(metric_id);
            ensure!(m.active, "metric is inactive");
            (m.max_value, m.scale, m.direction)
        }
    }

    /// Direction of a product's trigger. Metric products read it from the
    /// metric; legacy products default to "Above".
    fn product_direction(&self, p: &Product) -> Direction {
        self.metric_spec(&p.metric_id).2
    }

    /// Submit one operator's signed reading. The caller must be the operator,
    /// the signature must verify against that operator's registered key, and the
    /// value/freshness/range/nonce are all validated. The reading is stored; the
    /// observation is only finalized (and only becomes settle-able) once
    /// `quorum` distinct operators agree on a value within tolerance.
    pub fn submit_reading(
        &mut self,
        metric_id: String,
        city: String,
        obs_date: u64,
        value_tenths: u64,
        reported_at: u64,
        nonce: u64,
        signature: Vec<u8>,
    ) -> u32 {
        let caller = env::predecessor_account_id();
        let mut op = self.operators.get(&caller).unwrap_or_else(|| fail("caller is not a registered operator"));
        ensure!(op.active, "operator is revoked");
        ensure!(signature.len() == 64, "signature must be 64 bytes");

        // Resolve the index's plausibility bound and scale. A legacy (empty)
        // metric id keeps the rainfall spec; a named metric must exist+active.
        let (max_value, _scale, _dir) = self.metric_spec(&metric_id);
        let msg = Self::reading_message(&caller, &metric_id, &city, obs_date, value_tenths, reported_at, nonce);
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| fail("signature must be 64 bytes"));
        let pk: [u8; 32] = op.public_key.as_slice().try_into().unwrap_or_else(|_| fail("operator key must be 32 bytes"));
        ensure!(env::ed25519_verify(&sig, &msg, &pk), "invalid operator signature");

        // Per-operator monotonic nonce: an operator's reading counter is the
        // expected nonce, so an old signature cannot be replayed.
        ensure!(nonce == op.readings, "stale operator nonce (replay)");

        let now = now_sec();
        ensure!(obs_date <= now, "cannot observe a future date");
        ensure!(reported_at >= obs_date, "observation predates its date");
        ensure!(
            reported_at.saturating_sub(obs_date) <= REPORT_MAX_DELAY_SEC,
            "observation reported too late (stale)"
        );
        ensure!(reported_at <= now, "observation reported in the future");
        ensure!(value_tenths <= max_value, "value above metric plausibility bound");

        let okey = Self::obs_key(&metric_id, &city, obs_date);
        let rkey = Self::reading_key(&metric_id, &city, obs_date, &caller);
        ensure!(self.readings.get(&rkey).is_none(), "operator already reported for this date");

        op.readings = op.readings.checked_add(1).unwrap_or_else(|| fail("overflow"));
        self.operators.insert(&caller, &op);
        self.readings.insert(&rkey, &Reading {
            operator: caller.clone(),
            value_tenths,
            reported_at,
            nonce,
        });
        let mut signers = self
            .reading_signers
            .get(&okey)
            .unwrap_or_else(|| UnorderedSet::new(StorageKey::ReadingsByObs { key: okey.clone() }));
        signers.insert(&caller);
        self.reading_signers.insert(&okey, &signers);

        let count = signers.len() as u32;
        log_event(
            "reading_submitted",
            &[
                ("metric", &metric_id),
                ("city", &city),
                ("obs_date", &obs_date.to_string()),
                ("operator", &caller.to_string()),
                ("count", &count.to_string()),
            ],
        );

        // Try to finalize when enough distinct operators have reported.
        let mut finalized = 0u32;
        if self.observations.get(&okey).is_none() && count >= self.quorum {
            finalized = self.try_finalize(&metric_id, &city, obs_date, &okey);
        } else if let Some(o) = self.observations.get(&okey) {
            finalized = o.quorum;
        }
        finalized
    }

    /// Aggregate the readings for an observation key and, if a quorum of values
    /// agree within tolerance, store the finalized observation. Returns the
    /// quorum size that was reached (0 if it did not finalize).
    fn try_finalize(&mut self, metric_id: &str, city: &str, obs_date: u64, okey: &Vec<u8>) -> u32 {
        let signers = match self.reading_signers.get(okey) {
            Some(s) => s,
            None => return 0,
        };
        let (_max_value, scale, _dir) = self.metric_spec(metric_id);
        // Values are the scale applied to human units; one unit of tolerance is
        // 1/scale of the base unit (e.g. 0.1 mm, 0.1 degC, 0.1 m/s).
        let tolerance = scale.max(1) as u64;
        // The finalized value is the reading with the most support within
        // tolerance; ties go to the lower value (deterministic).
        let mut best: Option<(u64, u32)> = None;
        for acct in signers.iter() {
            let r = match self.readings.get(&Self::reading_key(metric_id, city, obs_date, &acct)) {
                Some(r) => r,
                None => continue,
            };
            let mut support = 0u32;
            for other in signers.iter() {
                if let Some(or) = self.readings.get(&Self::reading_key(metric_id, city, obs_date, &other)) {
                    let diff = if or.value_tenths >= r.value_tenths { or.value_tenths - r.value_tenths } else { r.value_tenths - or.value_tenths };
                    if diff <= tolerance {
                        support += 1;
                    }
                }
            }
            let better = match best {
                None => true,
                Some((bv, bs)) => support > bs || (support == bs && r.value_tenths < bv),
            };
            if better {
                best = Some((r.value_tenths, support));
            }
        }

        let (value, support) = match best {
            Some(v) => v,
            None => return 0,
        };
        if support < self.quorum {
            return 0; // readings conflict; no quorum on a single value yet
        }

        // reported_at = the latest report time among the supporting readings.
        let mut reported_at = 0u64;
        let mut confirmed: Vec<AccountId> = Vec::new();
        for acct in signers.iter() {
            if let Some(or) = self.readings.get(&Self::reading_key(metric_id, city, obs_date, &acct)) {
                let diff = if or.value_tenths >= value { or.value_tenths - value } else { value - or.value_tenths };
                if diff <= tolerance {
                    reported_at = reported_at.max(or.reported_at);
                    confirmed.push(acct.clone());
                }
            }
        }

        let dkey = Self::dispute_key(okey);
        self.disputes.insert(&dkey, &Dispute {
            key: dkey.clone(),
            metric_id: metric_id.to_string(),
            city: city.to_string(),
            obs_date,
            value_tenths: value,
            signers: confirmed,
            opened_at: 0,
            challenger: env::current_account_id(),
            counter_value_tenths: 0,
            bond: 0,
            resolved_at: DISPUTE_OPEN,
            uphold: false,
            upheld_votes: 0,
            nullified_votes: 0,
        });
        self.dispute_keys.insert(&dkey);

        let obs = Observation {
            metric_id: metric_id.to_string(),
            city: city.to_string(),
            obs_date,
            value_tenths: value,
            reported_at,
            quorum: support,
            dispute_key: dkey,
            disputed: false,
            nullified: false,
            challenger: None,
            counter_value_tenths: 0,
            bond: 0,
        };
        self.observations.insert(okey, &obs);
        self.observation_ids.insert(okey);
        log_event(
            "observation_finalized",
            &[
                ("metric", metric_id),
                ("city", city),
                ("obs_date", &obs_date.to_string()),
                ("value", &value.to_string()),
                ("quorum", &support.to_string()),
            ],
        );
        support
    }

    /// Dispute key is derived from the observation key.
    fn dispute_key(okey: &Vec<u8>) -> Vec<u8> {
        let mut k = b"dispute|".to_vec();
        k.extend_from_slice(okey);
        k
    }

    /// Open a bonded dispute against a finalized observation. Anyone may
    /// challenge; the attached deposit is the bond and must be at least the
    /// configured minimum. A disputed observation cannot settle.
    #[payable]
    pub fn challenge_observation(
        &mut self,
        metric_id: String,
        city: String,
        obs_date: u64,
        counter_value_tenths: u64,
    ) -> Vec<u8> {
        let bond = env::attached_deposit().as_yoctonear();
        ensure!(bond >= self.challenge_bond, "challenge bond too small");
        let okey = Self::obs_key(&metric_id, &city, obs_date);
        let mut o = self.observations.get(&okey).unwrap_or_else(|| fail("no such observation"));
        ensure!(!o.disputed, "observation already disputed");
        ensure!(!o.nullified, "observation already nullified");
        let now = now_sec();
        ensure!(
            now < o.reported_at.saturating_add(self.challenge_window_sec),
            "challenge window has elapsed"
        );

        let dkey = o.dispute_key.clone();
        let mut d = self.disputes.get(&dkey).unwrap_or_else(|| fail("no dispute slot"));
        ensure!(d.resolved_at == DISPUTE_OPEN, "dispute already resolved");
        let challenger = env::predecessor_account_id();
        d.challenger = challenger.clone();
        d.counter_value_tenths = counter_value_tenths;
        d.bond = bond;
        d.opened_at = now;
        self.disputes.insert(&dkey, &d);

        o.disputed = true;
        o.challenger = Some(challenger);
        o.counter_value_tenths = counter_value_tenths;
        o.bond = bond;
        self.observations.insert(&okey, &o);
        self.held_bonds = self.held_bonds.checked_add(bond).unwrap_or_else(|| fail("overflow"));
        log_event("observation_challenged", &[("metric", &metric_id), ("city", &city), ("obs_date", &obs_date.to_string())]);
        okey
    }

    /// An independent resolver votes on an open dispute. The operators that
    /// signed the reading may NOT vote (they cannot decide their own dispute),
    /// and neither may the challenger. Once `resolver_quorum` distinct active
    /// resolvers agree, the dispute is decided: upholding keeps the reading and
    /// forfeits the challenger's bond to the pool; nullifying voids the reading
    /// and refunds the bond. Resolvers are independent accounts, so no single
    /// owner can silently override the outcome.
    pub fn resolver_vote(&mut self, metric_id: String, city: String, obs_date: u64, uphold: bool) {
        let caller = env::predecessor_account_id();
        let r = self.resolvers.get(&caller).unwrap_or_else(|| fail("not a registered resolver"));
        ensure!(r.active, "resolver is revoked");

        let okey = Self::obs_key(&metric_id, &city, obs_date);
        let dkey = Self::dispute_key(&okey);
        let mut d = self.disputes.get(&dkey).unwrap_or_else(|| fail("no dispute slot"));
        ensure!(d.resolved_at == DISPUTE_OPEN, "dispute already resolved");
        ensure!(d.opened_at > 0, "no open dispute");
        ensure!(
            !d.signers.iter().any(|s| s == &caller),
            "an operator that signed the reading may not resolve it"
        );
        ensure!(d.challenger != caller, "the challenger may not resolve their own dispute");

        let mut voters = self.dispute_voters.get(&dkey).unwrap_or_else(|| {
            UnorderedSet::new(StorageKey::DisputeVoters { key: dkey.clone() })
        });
        ensure!(!voters.contains(&caller), "resolver already voted");
        voters.insert(&caller);
        self.dispute_voters.insert(&dkey, &voters);

        if uphold {
            d.upheld_votes += 1;
        } else {
            d.nullified_votes += 1;
        }
        log_event(
            "dispute_vote",
            &[
                ("city", &city),
                ("obs_date", &obs_date.to_string()),
                ("resolver", &caller.to_string()),
                ("uphold", if uphold { "true" } else { "false" }),
            ],
        );

        if d.upheld_votes >= self.resolver_quorum || d.nullified_votes >= self.resolver_quorum {
            self.finalize_dispute(&okey, &dkey, d.upheld_votes >= self.resolver_quorum);
        } else {
            self.disputes.insert(&dkey, &d);
        }
    }

    /// Close a dispute after its window has elapsed without a resolver quorum,
    /// so it cannot freeze a policy forever. The reading is VOIDED (fail closed
    /// — no payout) and the challenger's bond is refunded: honest disagreement
    /// is never slashed. Anyone may call this.
    pub fn timeout_dispute(&mut self, metric_id: String, city: String, obs_date: u64) {
        let okey = Self::obs_key(&metric_id, &city, obs_date);
        let dkey = Self::dispute_key(&okey);
        let d = self.disputes.get(&dkey).unwrap_or_else(|| fail("no dispute slot"));
        ensure!(d.resolved_at == DISPUTE_OPEN, "dispute already resolved");
        ensure!(d.opened_at > 0, "no open dispute");
        let now = now_sec();
        ensure!(
            now >= d.opened_at.saturating_add(self.dispute_window_sec),
            "dispute window has not elapsed"
        );
        self.finalize_dispute(&okey, &dkey, false);
        log_event("dispute_timed_out", &[("city", &city), ("obs_date", &obs_date.to_string())]);
    }

    /// Apply the decision of a dispute (uphold=true keeps the reading, false
    /// voids it) and settle the held bond.
    fn finalize_dispute(&mut self, okey: &Vec<u8>, dkey: &Vec<u8>, uphold: bool) {
        let mut d = self.disputes.get(dkey).unwrap_or_else(|| fail("no dispute slot"));
        let bond = d.bond;
        let now = now_sec();
        d.resolved_at = now;
        d.uphold = uphold;
        self.disputes.insert(dkey, &d);

        let mut o = self.observations.get(okey).unwrap_or_else(|| fail("no observation"));
        if uphold {
            // Reading stands. Challenger forfeits the bond to the pool.
            o.disputed = false;
            o.bond = 0;
            self.capital = self.capital.checked_add(bond).unwrap_or_else(|| fail("overflow"));
            self.bonds_forfeited = self.bonds_forfeited.checked_add(bond).unwrap_or_else(|| fail("overflow"));
        } else {
            // Reading voided (fail closed). Challenger refunded.
            o.nullified = true;
            o.disputed = false;
            o.bond = 0;
            let to = d.challenger.clone();
            if bond > 0 {
                let _ = Promise::new(to).transfer(NearToken::from_yoctonear(bond));
            }
        }
        self.held_bonds = self.held_bonds.checked_sub(bond).unwrap_or_else(|| fail("bond underflow"));
        self.observations.insert(okey, &o);
        self.check_invariant_or_panic();
        log_event("dispute_resolved", &[("uphold", if uphold { "true" } else { "false" })]);
    }

    fn observation_valid(&self, metric_id: &str, city: &str, obs_date: u64, at: u64) -> Result<u64, &'static str> {
        let o = self
            .observations
            .get(&Self::obs_key(metric_id, city, obs_date))
            .ok_or("no observation")?;
        if o.nullified {
            return Err("observation nullified");
        }
        if o.disputed {
            return Err("observation disputed (unresolved)");
        }
        if at < o.reported_at.saturating_add(self.challenge_window_sec) {
            return Err("challenge window not elapsed");
        }
        Ok(o.value_tenths)
    }

    // ---------------------------------------------------------------------
    // settlement
    // ---------------------------------------------------------------------

    /// Settle a policy exactly once. Pays iff the validated observation meets
    /// the product's threshold. Releases the reservation in both outcomes.
    pub fn resolve(&mut self, policy_id: u64) -> bool {
        let mut pol = self.policies.get(&policy_id).unwrap_or_else(|| fail("no such policy"));
        ensure!(pol.status == "active", "policy not active");
        let now = now_sec();
        ensure!(
            now >= pol.obs_date.saturating_add(self.settle_delay_sec),
            "too early to settle"
        );
        let value = match self.observation_valid(&pol.metric_id, &pol.city, pol.obs_date, now) {
            Ok(v) => v,
            Err(e) => fail(&format!("cannot settle: {}", e)),
        };

        // Release the reservation exactly once.
        self.reserved = self.reserved.checked_sub(pol.payout).unwrap_or_else(|| fail("reserved underflow"));
        let mut p = self.products.get(&pol.product_id).unwrap_or_else(|| fail("product"));
        p.reserved = p.reserved.checked_sub(pol.payout).unwrap_or_else(|| fail("product reserved underflow"));
        self.products.insert(&pol.product_id, &p);

        let triggered = match pol.direction {
            Direction::Above => value >= pol.threshold_tenths,
            Direction::Below => value <= pol.threshold_tenths,
        };
        if triggered {
            ensure!(pol.payout <= self.capital, "payout exceeds capital");
            self.capital -= pol.payout;
            self.total_paid = self.total_paid.checked_add(pol.payout).unwrap_or_else(|| fail("overflow"));
            pol.status = "settled_paid".to_string();
            pol.paid_amount = pol.payout;
            let _ = Promise::new(pol.beneficiary.clone())
                .transfer(NearToken::from_yoctonear(pol.payout));
        } else {
            pol.status = "settled_no_pay".to_string();
            pol.paid_amount = 0;
        }
        pol.observed_value = value;
        pol.settled_at = now;
        self.policies.insert(&policy_id, &pol);
        self.check_invariant_or_panic();
        log_event(
            "policy_settled",
            &[
                ("id", &policy_id.to_string()),
                ("triggered", if triggered { "true" } else { "false" }),
                ("paid", &pol.paid_amount.to_string()),
                ("value_tenths", &value.to_string()),
            ],
        );
        triggered
    }

    // ---------------------------------------------------------------------
    // views
    // ---------------------------------------------------------------------

    pub fn available(&self) -> Yocto {
        self.capital.saturating_sub(self.reserved)
    }

    pub fn get_pool(&self) -> PoolView {
        PoolView {
            capital: U128(self.capital),
            reserved: U128(self.reserved),
            available: U128(self.available()),
            held_bonds: U128(self.held_bonds),
            premiums_collected: U128(self.premiums_collected),
            total_paid: U128(self.total_paid),
            total_deposited: U128(self.total_deposited),
            total_withdrawn: U128(self.total_withdrawn),
            bonds_forfeited: U128(self.bonds_forfeited),
            policy_count: self.policy_ids.len(),
            solvent: self.reserved <= self.capital,
            paused: self.paused,
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            attestor: bs58_encode(&self.attestor),
            challenge_bond: U128(self.challenge_bond),
            challenge_window_sec: self.challenge_window_sec,
            settle_delay_sec: self.settle_delay_sec,
            quorum: self.quorum,
            resolver_quorum: self.resolver_quorum,
            dispute_window_sec: self.dispute_window_sec,
        }
    }

    pub fn get_product(&self, id: String) -> Option<Product> {
        self.products.get(&id)
    }

    pub fn list_products(&self) -> Vec<Product> {
        self.product_ids.iter().filter_map(|id| self.products.get(&id)).collect()
    }

    // ---- metrics ----

    pub fn get_metric(&self, id: String) -> Option<Metric> {
        self.metrics.get(&id)
    }

    pub fn list_metrics(&self) -> Vec<Metric> {
        self.metric_ids.iter().filter_map(|id| self.metrics.get(&id)).collect()
    }

    // ---- operators ----

    pub fn get_operator(&self, account: AccountId) -> Option<Operator> {
        self.operators.get(&account)
    }

    pub fn list_operators(&self) -> Vec<Operator> {
        self.operator_ids.iter().filter_map(|a| self.operators.get(&a)).collect()
    }

    /// Count of active operators — the ceiling on the achievable quorum.
    pub fn active_operator_count(&self) -> u32 {
        self.operator_ids
            .iter()
            .filter_map(|a| self.operators.get(&a))
            .filter(|o| o.active)
            .count() as u32
    }

    // ---- resolvers ----

    pub fn list_resolvers(&self) -> Vec<Resolver> {
        self.resolver_ids.iter().filter_map(|a| self.resolvers.get(&a)).collect()
    }

    // ---- disputes ----

    pub fn get_dispute(&self, metric_id: String, city: String, obs_date: u64) -> Option<Dispute> {
        let okey = Self::obs_key(&metric_id, &city, obs_date);
        self.disputes.get(&Self::dispute_key(&okey))
    }

    pub fn get_policy(&self, id: u64) -> Option<Policy> {
        self.policies.get(&id)
    }

    pub fn list_policies(&self) -> Vec<Policy> {
        self.policy_ids.iter().filter_map(|id| self.policies.get(&id)).collect()
    }

    pub fn get_provider(&self, account_id: AccountId) -> Provider {
        self.providers.get(&account_id).unwrap_or(Provider {
            deposited: 0,
            withdrawn: 0,
        })
    }

    /// All observations reported so far (most recent first is the caller's job).
    pub fn list_observations(&self) -> Vec<Observation> {
        self.observation_ids
            .iter()
            .filter_map(|k| self.observations.get(&k))
            .collect()
    }

    pub fn get_observation(&self, metric_id: String, city: String, obs_date: u64) -> Option<Observation> {
        self.observations.get(&Self::obs_key(&metric_id, &city, obs_date))
    }

    /// True iff the pool's running totals reconcile with `capital`.
    /// capital == deposited - withdrawn + premiums - paid
    pub fn reconcile(&self) -> bool {
        let expected = self
            .total_deposited
            .wrapping_sub(self.total_withdrawn)
            .wrapping_add(self.premiums_collected)
            .wrapping_add(self.bonds_forfeited)
            .wrapping_sub(self.total_paid);
        expected == self.capital
    }

    pub fn check_invariant(&self) -> bool {
        self.reserved <= self.capital
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    fn check_invariant_or_panic(&self) {
        ensure!(self.reserved <= self.capital, "INVARIANT: reserved > capital");
    }
}

fn now_sec() -> u64 {
    env::block_timestamp() / NS_PER_SEC
}

/// Minimal base58 (Bitcoin alphabet) encoder for the 32-byte attestor key.
fn bs58_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![0];
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    // leading zero bytes -> leading '1'
    let mut out = String::new();
    for &b in bytes {
        if b == 0 {
            out.push('1');
        } else {
            break;
        }
    }
    for &d in digits.iter().rev() {
        out.push(ALPHABET[d as usize] as char);
    }
    out
}

fn log_event(kind: &str, fields: &[(&str, &str)]) {
    let mut s = String::from("EVENT_JSON:{\"standard\":\"overcover\",\"version\":\"1.0.0\",\"event\":\"");
    s.push_str(kind);
    s.push_str("\",\"data\":[");
    for (i, (k, v)) in fields.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{{\"{}\":\"{}\"}}", k, v.replace('"', "")));
    }
    s.push_str("]}");
    env::log_str(&s);
}

// ---- view structs ---------------------------------------------------------

#[near(serializers = [json])]
pub struct PoolView {
    pub capital: U128,
    pub reserved: U128,
    pub available: U128,
    pub held_bonds: U128,
    pub premiums_collected: U128,
    pub total_paid: U128,
    pub total_deposited: U128,
    pub total_withdrawn: U128,
    pub bonds_forfeited: U128,
    pub policy_count: u64,
    pub solvent: bool,
    pub paused: bool,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub attestor: String,
    pub challenge_bond: U128,
    pub challenge_window_sec: u64,
    pub settle_delay_sec: u64,
    pub quorum: u32,
    pub resolver_quorum: u32,
    pub dispute_window_sec: u64,
}

#[cfg(test)]
mod tests;
