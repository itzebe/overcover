# Legacy containment and migration plan

Companion to `LEGACY_POLICYHOLDER_RECONCILIATION.md` (the live figures) and
`WALLET-SIGNING-AUTHORITY-RECOVERY.md` (why no key is available). This document states what can and
cannot be done to contain the legacy v1 address, and the design any eventual migration must follow.
**Nothing here has been executed.** No on-chain state was changed.

---

## 1. The two problems, kept separate

1. **The SEC-1 takeover primitive** (a permissionless `migrate()` on the legacy address). It can
   strand the account balance and the live policy obligations, and let an attacker take the owner
   and attestor roles. This is a *security* problem.
2. **The frozen settlement leg** (13 active legacy policies whose payout needs an attestor-signed
   reading, and the attestor key is gone). This is a *lifecycle* problem.

They share one root cause — **the legacy account's authority is not held** — but they have
different fixes and must not be conflated.

## 2. Containment options, and their honest status

| Option | What it would do | Requires | Status |
| --- | --- | --- | --- |
| **A. Contract-level pause** (`set_paused(true)`) | Freeze new `buy_cover` on the legacy address. | Legacy **owner** key. | **BLOCKED** — key not held. |
| **B. In-place hardening** (redeploy the hardened module via the state-preserving `migrate`) | Install the SEC-1 guard on the legacy address, preserving state. | Legacy **contract-account** key. | **BLOCKED** — key not held. |
| **C. Console containment** | Refuse to *sign* against the legacy address; label it *Legacy build*; keep it readable. | None (front-end). | **DONE** — gated on the deployed code hash, verified by `npm run verify:connectivity` (13/13) and `tests/console.test.js`. |
| **D. Disclosure** | State the unremediated status in the console, `llms.txt`, `docs/`, and this report. | None. | **DONE**. |

**What C and D do and do not achieve.** They protect a user who uses the project's console: they
cannot be steered into a purchase on the legacy address, and they are told why. They do **not**
protect against a third party calling the legacy `migrate()` (or `buy_cover`) directly over RPC —
that path is open regardless of what the console does. **No front-end change can close SEC-1; only
A or B can, and both need a key that does not exist.**

## 3. The residual risk, stated plainly

- **Uncontained:** the SEC-1 takeover primitive remains live and permissionless on
  `contract.attestor-overcover.testnet`.
- **Consequence if exercised:** the account balance (18.55 NEAR) and the 10.50 NEAR of live policy
  obligations become controlled by whoever sends the `migrate()` call.
- **Why it cannot be closed from here:** the fix requires signing *as the legacy account*, which
  needs its FullAccess key. NEAR provides no escrow and no keyless owner-recovery path. This is a
  **documented external-authority blocker**, not an engineering gap.
- **What is not at risk:** the project cannot itself move, withdraw or reassign any legacy capital
  (it holds no key), and no action has been taken that changes any policyholder's entitlement.

## 4. Migration design (to be used only if authority is ever restored)

If the legacy account's key were ever recovered, the following sequence preserves every entitlement.
It is a design, not a runbook that has been run.

**Invariants that must hold throughout**

- `reserved ≤ capital` on the legacy account, before and after.
- The 15 policies' `(id, buyer, beneficiary, product_id, payout, premium, obs_date)` are unchanged.
- `capital = deposits − withdrawals + premiums + forfeited bonds − payouts` still balances
  (`reconcile()` and `check_invariant()` both true).

**Sequence**

1. **Snapshot first.** Re-run `scripts/legacy-reconciliation.mjs` and archive the dump; compute the
   exact `Σ active payouts` and `capital`. This is the "before" state, independently re-derivable.
2. **Hardening deploy (Option B).** Redeploy the hardened module to the legacy address with the
   state-preserving `migrate` (the same path proven by `npm run verify:upgrade-preservation`:
   "state PRESERVED, migrated policy settled"). This closes SEC-1 **in place** and keeps the address,
   capital, products and all 15 policies. It does **not** move funds.
3. **Verify preservation.** Re-read the snapshot and assert every field is byte-for-byte identical
   except `code_hash`. The proof harness already asserts exactly this diff ("DIFFERENCES: none").
4. **Re-open the settlement leg (only if the attestor key is also available).** With the owner role
   restored, re-register an attestor/operator key and publish the readings the 13 active policies
   need, so each can `resolve` normally. Until a valid reading exists, a policy is simply
   unsettleable — its reservation stays reserved, it is not lost.
5. **Never bulk-settle.** Settlement is per-policy and follows the reading; a "migration" that
   reassigns payouts in bulk would break the immutable-product guarantee and is out of scope.

**If only the account key is recovered (not the attestor key):** step 2–3 still close SEC-1 and
preserve everything; the 13 policies stay reserved-but-unsettleable, which is the honest current
state and strictly better than an open takeover.

**If no key is recovered:** the only truthful position is the one held today — the legacy address is
unremediated, read-only in the console, and its live obligations are inert for want of a valid
reading. Do not describe it as contained.

## 5. Successor policy (recommended)

Containment of *new* business does not depend on the legacy key. The safe path is:

- **New cover goes to a hardened successor** whose owner/operator authority is durable and held
  (see `SUCCESSOR_DEPLOYMENT_READINESS.md`). The console already defaults to v3 and refuses to sign
  against the legacy address.
- **Legacy obligations are represented honestly, never "migrated".** The console and `llms.txt`
  present the legacy address as legacy and its policies as legacy state; no successor claims to have
  assumed them.
- **No automatic migration of legacy policies or funds** — it is neither possible (no key) nor
  desirable (it would misrepresent entitlements).

## 6. What would change this document

- Recovery of the legacy account key → run §4.
- An owner-approved decision to stand up a fresh contract → see
  `SUCCESSOR_DEPLOYMENT_READINESS.md`; it does not affect the legacy address.
