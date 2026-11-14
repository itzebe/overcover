# Legacy policyholder and capital reconciliation

**Method:** read-only. Every figure below was read from NEAR **testnet** public JSON-RPC
(`call_function` views) on 2026-11-14 by `scripts/legacy-reconciliation.mjs`; the raw dump is
`proof/legacy-reconciliation.json`. No key was used, no transaction was sent, and no method that
requires authority was called. Nothing on either contract was modified.

**Scope:** the two live Overcover contracts, and every policy either one holds.

| Contract | Role | code_hash | Deployed wasm sha256 | Balance |
| --- | --- | --- | --- | --- |
| `contract.attestor-overcover.testnet` | **Legacy v1** (original module) | `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` | `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e` | 18.5473 NEAR |
| `contract.ovc-v3-ctl-2f6c4c.testnet` | **v3** (current default purchase destination) | `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL` | `a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1` | 6.6212 NEAR |

Each account has **exactly one** FullAccess key and no other. Those keys are **not held** (see
`WALLET-SIGNING-AUTHORITY-RECOVERY.md`). The `owner` of each is a separate account
(`owner.<contract>.testnet`) whose key is likewise not held.

---

## 1. Legacy v1 — `contract.attestor-overcover.testnet`

Config (read live): `owner = owner.attestor-overcover.testnet`,
`attestor = 4dhxyFrsS8y8HhS2CCFYHRbpjTGRudSqPWoHYCRECTxC`, `challenge_bond = 0.1 NEAR`,
`challenge_window_sec = 60`, `settle_delay_sec = 0`. The module exposes **no** `paused` getter, no
metric/oracle-quorum surface, and no `list_metrics` — it is the original single-attestor build.

Pool: `capital = 14.05 NEAR`, `reserved = 10.50 NEAR`, `available = 3.55 NEAR`;
`reconcile() = true`, `check_invariant() = true`, `solvent = true`.

**15 policies**, in three lifecycle states:

| State | Count | Obligation |
| --- | --- | --- |
| `active` (in force, settleable) | **13** | 10.50 NEAR reserved |
| `settled_paid` | 1 | 1.00 NEAR already paid (policy #3) |
| `settled_no_pay` | 1 | 0 (policy #4) |

`reserved (10.50) == Σ payouts of active policies (10.50)`, and `reserved ≤ capital` holds.

### Policy-by-policy

| # | Buyer / beneficiary | Product | Payout | Premium | State | Obs date (unix) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `grower-overcover.testnet` | `p-1794315395272-3` | 1.00 | 0.05 | active | 1794315429 |
| 2 | `grower-overcover.testnet` | `p-1794315450827-7` | 0.50 | 0.025 | active | 1794315460 |
| 3 | `grower-overcover.testnet` | `rain-lagos` | 1.00 | 0.05 | **settled_paid** | 1794315524 |
| 4 | `grower-overcover.testnet` | `rain-bergen-dry` | 0.50 | 0.025 | **settled_no_pay** | 1794315524 |
| 5 | `grower-overcover.testnet` | `p-1794319206542-3` | 1.00 | 0.05 | active | 1794319240 |
| 6 | `grower-overcover.testnet` | `p-1794319261805-7` | 0.50 | 0.025 | active | 1794319271 |
| 7 | `grower-overcover.testnet` | `p-1794319315964-3` | 1.00 | 0.05 | active | 1794319350 |
| 8 | `grower-overcover.testnet` | `p-1794319370961-7` | 0.50 | 0.025 | active | 1794319381 |
| 9 | `grower-overcover.testnet` | `p-1794337387611-3` | 1.00 | 0.05 | active | 1794337421 |
| 10 | `grower-overcover.testnet` | `p-1794337442850-7` | 0.50 | 0.025 | active | 1794337453 |
| 11 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | 0.05 | active | 1794355321 |
| 12 | `oc-agent-mwb87z4k.testnet` | `rain-bergen-dry` | 0.50 | 0.025 | active | 1794355564 |
| 13 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | 0.05 | active | 1794522722 |
| 14 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | 0.05 | active | 1794609217 |
| 15 | `human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | 0.05 | active | 1794609443 |

Buyer accounts are the demo identities the project created (`grower-overcover`, the agent account,
and one human-demo sub-account). Every policy's beneficiary equals its buyer.

### What can still change, and by whom

- **Buying new cover.** The v1 `buy_cover` is permissionless and the contract is **not paused**
  (the module has no pause surface at all). In principle a new policy could be written against the
  legacy address. **In practice the console refuses to sign against it** (its buy panel is blocked
  and labelled *Legacy build*, gated on the deployed code hash), so no purchase is steered there by
  the project's own UI. A third party using a raw RPC call could still buy.
- **Settlement (`resolve`, permissionless).** A policy can settle only against a valid,
  undisputed, non-nullified reading for its `(city, obs_date)` whose challenge window has elapsed.
  **4 of the 13 active policies already have such a reading** — #2, #6, #8 and #10, each `value 1 ≥
  threshold 1` — so **any account can call `resolve()` on them today and each pays 0.50 NEAR** to its
  beneficiary (2.00 NEAR in total). The other **9 active policies have no reading** and, because a
  reading can no longer be produced for their `(city, obs_date)`, `resolve()` reverts `"no
  observation"` and their **8.50 NEAR of reservation is stranded** on this address. Reproduced
  read-only by `npm run verify:settleability` (`proof/legacy-settleability.json`).
- **Disputes (`resolve_dispute`, owner).** Owner-gated; the owner key is not held.
- **`withdraw`, owner-only methods.** Gated; keys not held.

### The material risk: SEC-1 is live and unguarded on this address

The v1 module's `migrate()` is `#[init(ignore_state)]` with **no authorization guard**. This is a
**permissionless** takeover primitive: an attacker needs only to send a transaction (they do not
need any key on the account). Reproduced end-to-end against the **exact deployed v1 bytecode** by
`npm run verify:sec1-takeover` (**17/17**, sandbox):

1. a third party calls `migrate()` with itself as `owner` and **succeeds** — owner and attestor are
   replaced and the pool accounting (`capital`, `reserved`) is reset to zero;
2. the original provider can then no longer withdraw (the solvency gate fails closed) — their
   capital is **stranded**;
3. the attacker, now `owner`, can call owner-only methods (`add_product`);
4. the attacker, now `attestor`, can **forge observations** with their own key;
5. after the account is redeployed with the hardened module the same call is refused.

Because the attacker would control the attestor and owner, they could then (a) forge readings to
settle the 13 active policies to a beneficiary they choose, and (b) write products and take
deposits. The `reserved ≤ capital` invariant bounds the **internal** accounting, but a takeover
resets it — the real exposure is the account's **18.55 NEAR balance** and the 10.50 NEAR of live
policy obligations.

**This is the single most important open risk on the legacy address.** It is the exact risk SEC-1
fixes, and it cannot be closed without the legacy account's key (see §3).

---

## 2. v3 — `contract.ovc-v3-ctl-2f6c4c.testnet` (current default)

Config: `owner = owner.ovc-v3-ctl-2f6c4c.testnet`, `quorum = 3`, `resolver_quorum = 3`,
`challenge_window_sec = 3600`, `dispute_window_sec = 3600`, `challenge_bond = 0.1 NEAR`.
5 operators, 5 resolvers, 1 metric (`heat`). `reconcile() = true`, `check_invariant() = true`.

Pool: `capital = 1.4250 NEAR`, `reserved = 0.2000 NEAR`, `available = 1.2250 NEAR`.

**3 policies:**

| # | Buyer / beneficiary | Product | Payout | Premium | State |
| --- | --- | --- | --- | --- | --- |
| 1 | `buyer.ovc-v3-ctl-2f6c4c.testnet` | `heat-lagos` | 0.30 | 0.015 | settled_paid |
| 2 | `buyer.ovc-v3-ctl-2f6c4c.testnet` | `heat-lagos-factory` | 0.10 | 0.005 | active |
| 3 | `oc-agent-demo.ovc-v3-ctl-2f6c4c.testnet` | `heat-lagos` | 0.10 | 0.005 | active |

Two active policies hold 0.20 NEAR of reservation. **v3 is not affected by SEC-1** (its `migrate()`
is guarded — see the guard scan in `OVERCOVER-FINALIZATION-AND-HUMAN-TEST-READINESS.md`).

---

## 3. Exposure to ongoing loss or unauthorised action

| Contract | Ongoing-loss exposure | Can the project contain it? |
| --- | --- | --- |
| Legacy v1 | **Yes** — SEC-1 takeover is permissionless and would strand the 18.55 NEAR balance and the 10.50 NEAR of live obligations. | **No** — containment (`set_paused`) needs the legacy owner key, which is not held. |
| v3 | Low — SEC-1 closed; SEC-6/7/9 not deployed (a liveness/termination gap, not a theft path). | Partly — a redeploy needs the v3 key, which is not held. |

No policyholder on either contract is exposed to a *fund-moving* action the project can perform: the
project holds neither contract's key and therefore cannot withdraw, settle, or reassign anything.

## 4. Honest status

- **Nothing has been migrated or paused.** This report is read-only evidence; no on-chain state
  changed. The 15 legacy policies and the 3 v3 policies are exactly as the chain reports them.
- **The legacy address is not remediated.** `docs/AUTHORITY_RECOVERY.md` and the console both say
  so; this report confirms it with current figures.
- **The residual risk is real and is an external-authority blocker**, not a code gap: the fix
  exists (the hardened module), but applying it to the legacy address requires a key that no longer
  exists. See `LEGACY_CONTAINMENT_AND_MIGRATION_PLAN.md` for the containment options and their
  honesty constraints.
