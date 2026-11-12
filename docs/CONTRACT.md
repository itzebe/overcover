# Contract interface and state model

`contract/src/lib.rs` — Rust, `near-sdk` 5. Money is **yoctoNEAR** (`u128`), an index reading is
stored in **tenths of the metric's unit** (`u64`, e.g. tenths of a millimetre or tenths of a degree
Celsius), time is **unix seconds** (`u64`). Deployed as
`contract.ovc-v3-ctl-2f6c4c.testnet` (the hardened default). The original v1 module at
`contract.attestor-overcover.testnet` is still readable but is no longer a purchase destination.

## State

| Field | Meaning |
| --- | --- |
| `owner` | Account allowed to publish products, set the attestor, pause, and resolve disputes. |
| `attestor` | 32-byte ed25519 public key. The only key whose observations are accepted. |
| `paused` | When true, `buy_cover` refuses. |
| `challenge_bond` | Bond a challenger must attach to dispute a reading. |
| `challenge_window_sec` | Time after `reported_at` during which a reading may be challenged and cannot settle. |
| `settle_delay_sec` | Additional delay before a policy may settle. |
| `products` / `product_ids` | Immutable risk definitions, and their enumeration set. |
| `policies` / `policy_ids` | Issued cover, and their enumeration set. |
| `providers` | Per-account `{ deposited, withdrawn }`. |
| `observations` / `observation_ids` | Signed readings keyed by `city|obs_date`, and their enumeration set. |
| `capital` | Deposits − withdrawals + premiums + forfeited bonds − payouts. Excludes held bonds. |
| `reserved` | Sum of the payouts of **active** policies. |
| `held_bonds` | Bonds for open disputes. Not part of `capital`. |
| `total_deposited`, `total_withdrawn`, `premiums_collected`, `total_paid`, `bonds_forfeited` | Reconciliation counters. |
| `next_policy_id` | Monotonic policy id. |

### Product

`id`, `city`, `metric_id`, `category`, `threshold_tenths`, `premium_bp`, `min_payout`, `max_payout`,
`min_lead_sec`, `max_total_coverage`, `reserved` (outstanding liability for this product), `active`,
`proposed_by` (the account that created it — the owner for the owner path, the proposer for the
permissionless path), `evidence_hash` (immutable reference to the evidence a permissionless proposer
committed to; empty for owner-created products).

### Policy

`id`, `buyer`, `beneficiary`, `product_id`, `city`, `threshold_tenths`, `payout`, `premium`,
`obs_date`, `issued_at`, `status` (`active` | `settled_paid` | `settled_no_pay`), `paid_amount`,
`observed_value`, `settled_at`.

### Observation

`city`, `obs_date`, `value_tenths`, `reported_at`, `nonce`, `disputed`, `nullified`, `challenger`,
`counter_value_tenths`, `bond`.

## Methods

### Lifecycle and administration

| Method | Who | Notes |
| --- | --- | --- |
| `new(owner, attestor, challenge_bond, settle_delay_sec, challenge_window_sec)` | deployer | Initialises state. |
| `migrate()` | owner | State migration hook. |
| `set_attestor(attestor: Vec<u8>)` | owner | Rotate the oracle key. |
| `set_paused(paused: bool)` | owner | Freeze purchases. |

### Products

| Method | Who | Notes |
| --- | --- | --- |
| `add_product(id, city, threshold_tenths, premium_bp, min_payout, max_payout, min_lead_sec, max_total_coverage)` | owner | Publishes an immutable product. `premium_bp` ≤ 5000 (50%). |
| `add_metric_product(id, city, metric_id, category, threshold_tenths, premium_bp, min_payout, max_payout, min_lead_sec, max_total_coverage)` | owner | Publishes an immutable product against a registered metric. |
| `propose_product(id, city, metric_id, threshold_tenths, premium_bp, min_payout, max_payout, coverage_start, evidence_hash)` | **anyone** (payable) | Permissionless path. Requires an attached stake ≥ `PROPOSAL_MIN_STAKE` (0.1 NEAR), which enters the pool (anti-spam, not refunded). The contract validates the proposal against fixed rules: non-empty id/city, no duplicate id, the metric must be registered **and active**, `threshold_tenths ≤ metric.max_value`, `premium_bp ∈ [1, 5000]`, `min_payout > 0`, `max_payout ≥ min_payout` and `max_payout ≥ 10 × min_premium`, `coverage_start ≥ now + 3600s` (prospective), product capacity `max_payout × 5 ≤ available`, and a cumulative bound so that `Σ all product capacity ≤ capital × (1 − 1/5)` (20% headroom held back). A qualifying proposal activates immediately with no owner transaction and records `proposed_by` and `evidence_hash`. |
| `set_product_active(id, active)` | owner | Withdraw a product from sale without changing its terms. |

### Capital

| Method | Who | Notes |
| --- | --- | --- |
| `deposit() -> U128` | anyone (payable) | Adds to `capital`; returns the provider's net position. |
| `withdraw(amount) -> U128` | provider | Refused if it would break solvency (`capital − amount ≥ reserved`) or exceed the provider's own capital. |
| `available() -> U128` | view | `capital − reserved`, saturating at 0. |

### Cover

| Method | Who | Notes |
| --- | --- | --- |
| `quote(product_id, payout) -> U128` | view | `ceil(payout × premium_bp / 10_000)`. |
| `buy_cover(product_id, payout, obs_date, beneficiary?) -> u64` | anyone (payable) | Deposit must **equal** the quote. Payout reserved; product capacity and pool availability enforced. Returns the policy id. |

### Oracle and disputes

| Method | Who | Notes |
| --- | --- | --- |
| `report_observation(city, obs_date, value_tenths, reported_at, nonce, signature: Vec<u8>)` | anyone, with a valid attestor signature | Verifies the signature, freshness (within `REPORT_MAX_DELAY_SEC` = 24 h of `obs_date`), range (`value ≤ 5000` tenths), and single-use `nonce`. |
| `challenge_observation(city, obs_date, counter_value_tenths)` | anyone (payable) | Requires exactly `challenge_bond`. Marks the reading disputed; a disputed reading cannot settle. |
| `resolve_dispute(city, obs_date, uphold)` | owner | `uphold = true` forfeits the bond into the pool; `uphold = false` nullifies the reading and returns the bond. |

The signed message is `overcover:v1|{city}|{obs_date}|{value_tenths}|{reported_at}|{nonce}|{contract_id}`,
so a signature cannot be replayed onto another contract or reused for a different observation.

### Settlement

| Method | Who | Notes |
| --- | --- | --- |
| `resolve(policy_id) -> bool` | anyone | Requires the challenge window to have elapsed and a valid, undisputed, non-nullified reading. Pays the beneficiary iff `value_tenths ≥ threshold_tenths`. Releases the reservation in **both** outcomes. Settles exactly once. |

### Views

`get_pool`, `get_config`, `get_product`, `list_products`, `get_policy`, `list_policies`,
`get_provider`, `get_observation`, `list_observations`, `available`, `quote`, `reconcile`,
`check_invariant`.

## The invariant

After **every** state-changing method the contract calls `check_invariant_or_panic()`:

```
reserved ≤ capital
```

If a transaction could violate it, the transaction is rejected instead of the pool becoming
insolvent. `check_invariant()` and `reconcile()` expose this to any observer.

`reconcile()` recomputes:

```
capital == total_deposited − total_withdrawn + premiums_collected + bonds_forfeited − total_paid
```

## Error behaviour

Every user-facing refusal calls the `panic_utf8` host function with a human-readable reason (for
example `"attached deposit must equal the quoted premium"`, `"product capacity exceeded"`,
`"withdraw would break solvency (funds are reserved)"`). std's wasm panic handler discards the
message, so the contract calls the host function directly — a reviewer can always see **why** a
transaction was refused in the receipt.
