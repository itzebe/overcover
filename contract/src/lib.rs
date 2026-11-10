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
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Product {
    pub id: String,
    pub city: String,
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

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Observation {
    pub city: String,
    pub obs_date: u64,
    pub value_tenths: u64,
    pub reported_at: u64,
    pub nonce: u64,
    pub disputed: bool,
    pub nullified: bool,
    pub challenger: Option<AccountId>,
    pub counter_value_tenths: u64,
    pub bond: Yocto,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Overcover {
    pub owner: AccountId,
    /// 32-byte ed25519 public key of the observation attestor.
    pub attestor: Vec<u8>,
    pub paused: bool,
    pub challenge_bond: Yocto,
    pub settle_delay_sec: u64,
    pub challenge_window_sec: u64,

    pub products: LookupMap<String, Product>,
    pub product_ids: UnorderedSet<String>,
    pub policies: LookupMap<u64, Policy>,
    pub policy_ids: UnorderedSet<u64>,
    pub providers: LookupMap<AccountId, Provider>,
    pub observations: LookupMap<Vec<u8>, Observation>,

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
        Self {
            owner,
            attestor,
            paused: false,
            challenge_bond: challenge_bond.0,
            settle_delay_sec,
            challenge_window_sec,
            products: LookupMap::new(StorageKey::Products),
            product_ids: UnorderedSet::new(StorageKey::ProductIds),
            policies: LookupMap::new(StorageKey::Policies),
            policy_ids: UnorderedSet::new(StorageKey::PolicyIds),
            providers: LookupMap::new(StorageKey::Providers),
            observations: LookupMap::new(StorageKey::Observations),
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
        ensure!(self.products.get(&id).is_none(), "product already exists");
        ensure!(premium_bp <= MAX_PREMIUM_BP, "premium_bp too high");
        ensure!(threshold_tenths <= MAX_RAINFALL_TENTHS, "threshold out of range");
        ensure!(min_payout.0 > 0, "min payout must be > 0");
        ensure!(max_payout.0 >= min_payout.0, "max payout below min");
        ensure!(
            max_total_coverage.0 >= max_payout.0,
            "capacity below a single max payout"
        );
        let p = Product {
            id: id.clone(),
            city,
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
        let pol = Policy {
            id,
            buyer: buyer.clone(),
            beneficiary: beneficiary.unwrap_or(buyer),
            product_id: product_id.clone(),
            city: p.city.clone(),
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
    // oracle
    // ---------------------------------------------------------------------

    fn obs_key(city: &str, obs_date: u64) -> Vec<u8> {
        format!("{}|{}", city, obs_date).into_bytes()
    }

    /// The signed message binds city, date, value, report time, a nonce and
    /// THIS contract, so a signature cannot be replayed on another contract or
    /// reused for a different observation.
    fn obs_message(city: &str, obs_date: u64, value_tenths: u64, reported_at: u64, nonce: u64) -> Vec<u8> {
        format!(
            "overcover:v1|{}|{}|{}|{}|{}|{}",
            city,
            obs_date,
            value_tenths,
            reported_at,
            nonce,
            env::current_account_id()
        )
        .into_bytes()
    }

    /// Register a signed observation. Only a valid ed25519 signature from the
    /// registered attestor is accepted. Value, freshness, range and replay are
    /// all validated here.
    pub fn report_observation(
        &mut self,
        city: String,
        obs_date: u64,
        value_tenths: u64,
        reported_at: u64,
        nonce: u64,
        signature: Vec<u8>,
    ) -> Vec<u8> {
        ensure!(signature.len() == 64, "signature must be 64 bytes");
        let msg = Self::obs_message(&city, obs_date, value_tenths, reported_at, nonce);
        let sig: [u8; 64] = signature.as_slice().try_into().unwrap_or_else(|_| fail("signature must be 64 bytes"));
        let pk: [u8; 32] = self.attestor.as_slice().try_into().unwrap_or_else(|_| fail("attestor key must be 32 bytes"));
        ensure!(
            env::ed25519_verify(&sig, &msg, &pk),
            "invalid attestor signature"
        );

        let now = now_sec();
        ensure!(obs_date <= now, "cannot observe a future date");
        ensure!(reported_at >= obs_date, "observation predates its date");
        ensure!(
            reported_at.saturating_sub(obs_date) <= REPORT_MAX_DELAY_SEC,
            "observation reported too late (stale)"
        );
        ensure!(reported_at <= now, "observation reported in the future");
        ensure!(value_tenths <= MAX_RAINFALL_TENTHS, "implausible rainfall value");

        let key = Self::obs_key(&city, obs_date);
        ensure!(self.observations.get(&key).is_none(), "observation already reported");
        let o = Observation {
            city: city.clone(),
            obs_date,
            value_tenths,
            reported_at,
            nonce,
            disputed: false,
            nullified: false,
            challenger: None,
            counter_value_tenths: 0,
            bond: 0,
        };
        self.observations.insert(&key, &o);
        log_event(
            "observation_reported",
            &[
                ("city", &city),
                ("obs_date", &obs_date.to_string()),
                ("value_tenths", &value_tenths.to_string()),
            ],
        );
        key
    }

    /// Bonded dispute. The attached deposit is the bond; it must be at least the
    /// configured minimum. A disputed observation cannot settle.
    #[payable]
    pub fn challenge_observation(
        &mut self,
        city: String,
        obs_date: u64,
        counter_value_tenths: u64,
    ) -> Vec<u8> {
        let bond = env::attached_deposit().as_yoctonear();
        ensure!(bond >= self.challenge_bond, "challenge bond too small");
        let key = Self::obs_key(&city, obs_date);
        let mut o = self.observations.get(&key).unwrap_or_else(|| fail("no such observation"));
        ensure!(!o.disputed, "observation already disputed");
        ensure!(!o.nullified, "observation already nullified");
        o.disputed = true;
        o.challenger = Some(env::predecessor_account_id());
        o.counter_value_tenths = counter_value_tenths;
        o.bond = bond;
        self.observations.insert(&key, &o);
        self.held_bonds = self.held_bonds.checked_add(bond).unwrap_or_else(|| fail("overflow"));
        log_event("observation_challenged", &[("city", &city), ("obs_date", &obs_date.to_string())]);
        key
    }

    /// Owner resolves a dispute. `uphold = true` keeps the observation and the
    /// challenger forfeits the bond to the pool; `uphold = false` nullifies the
    /// observation and refunds the bond. An unresolved dispute fails closed.
    pub fn resolve_dispute(&mut self, city: String, obs_date: u64, uphold: bool) {
        self.assert_owner();
        let key = Self::obs_key(&city, obs_date);
        let mut o = self.observations.get(&key).unwrap_or_else(|| fail("no such observation"));
        ensure!(o.disputed, "no open dispute");
        let bond = o.bond;
        if uphold {
            o.disputed = false;
            o.bond = 0;
            self.capital = self.capital.checked_add(bond).unwrap_or_else(|| fail("overflow"));
            self.bonds_forfeited = self.bonds_forfeited.checked_add(bond).unwrap_or_else(|| fail("overflow"));
        } else {
            o.nullified = true;
            o.disputed = false;
            o.bond = 0;
            let to = o.challenger.clone().unwrap_or_else(|| fail("challenger"));
            let _ = Promise::new(to).transfer(NearToken::from_yoctonear(bond));
        }
        self.held_bonds = self.held_bonds.checked_sub(bond).unwrap_or_else(|| fail("bond underflow"));
        self.observations.insert(&key, &o);
        self.check_invariant_or_panic();
        log_event("dispute_resolved", &[("city", &city), ("uphold", if uphold { "true" } else { "false" })]);
    }

    fn observation_valid(&self, city: &str, obs_date: u64, at: u64) -> Result<u64, &'static str> {
        let o = self
            .observations
            .get(&Self::obs_key(city, obs_date))
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
        let value = match self.observation_valid(&pol.city, pol.obs_date, now) {
            Ok(v) => v,
            Err(e) => fail(&format!("cannot settle: {}", e)),
        };

        // Release the reservation exactly once.
        self.reserved = self.reserved.checked_sub(pol.payout).unwrap_or_else(|| fail("reserved underflow"));
        let mut p = self.products.get(&pol.product_id).unwrap_or_else(|| fail("product"));
        p.reserved = p.reserved.checked_sub(pol.payout).unwrap_or_else(|| fail("product reserved underflow"));
        self.products.insert(&pol.product_id, &p);

        let triggered = value >= pol.threshold_tenths;
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
        }
    }

    pub fn get_product(&self, id: String) -> Option<Product> {
        self.products.get(&id)
    }

    pub fn list_products(&self) -> Vec<Product> {
        self.product_ids.iter().filter_map(|id| self.products.get(&id)).collect()
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

    pub fn get_observation(&self, city: String, obs_date: u64) -> Option<Observation> {
        self.observations.get(&Self::obs_key(&city, obs_date))
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
}

#[cfg(test)]
mod tests;
