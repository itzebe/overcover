# Successor architecture and legacy-policyholder continuity — decision

**Question this answers.** What is the successor architecture for Overcover, and what happens to the
policyholders on the legacy contract when it is adopted?

**Method.** Read-only. Every figure was read from NEAR **testnet** public JSON-RPC (`view_code` and
`call_function`) on 2026-11-14 and is reproducible with `scripts/legacy-reconciliation.mjs` plus the
code-hash scan in §1. No key was used, no transaction was sent, no state was changed. This document
makes a **recommendation**; it executes nothing.

**Verdict in one line.** Adopt the hardened module that already exists at HEAD
(`811e0427…`, carrying SEC-1/SEC-6/SEC-7/SEC-9) as the successor, stand it up under a **fresh,
owner-controlled root whose key the owner holds durably**, and run the legacy contract to a **stated
run-off** — no migration, no bulk settlement, and an honest accounting that distinguishes the legacy
policies that can still pay from the ones that are permanently locked.

---

## 1. Live deployment state (the authoritative baseline)

Read from `view_code` over public RPC. `sha256` is computed on the deployed bytecode; it is the
build identity, and the console gates buying on `(address, code_hash)`, not on a label.

| Contract | Role | `code_hash` (base58) | deployed wasm sha256 | bytes | SEC-1 guard | SEC-6/7/9 |
| --- | --- | --- | --- | --- | --- | --- |
| `contract.attestor-overcover.testnet` | **legacy v1** | `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` | `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e` | 344,857 | **absent** | absent |
| `contract.ovc-v3-ctl-2f6c4c.testnet` | **v3 default** (current purchase destination) | `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL` | `a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1` | 500,023 | present | **absent** |
| `contract.ovc-v3-ctl-mwgci3u8.testnet` | **reference** (controlled deploy) | `9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C` | `811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f` | 500,342 | present | **present** |

Guard presence was established by scanning the live bytecode for the contract's own refusal strings
(a string is present only if the code path that emits it is compiled in):

| Refusal string (guard) | legacy v1 | v3 default | reference |
| --- | --- | --- | --- |
| `migrate may only be called by the contract account itself` (SEC-1) | — | HAS | HAS |
| `observation date too far in the future (max lead exceeded)` (SEC-9) | — | — | HAS |
| `no reading was ever reported` (SEC-7 reservation release) | — | — | HAS |
| `observation expired` (SEC-6 terminal release) | — | HAS | HAS |

**Consequence.** The **current purchase destination (v3 default) predates SEC-6/7/9.** It cannot
release a reservation whose reading was never reported, so a policy whose reading never arrives locks
its reservation until the policy is settled — and it can never be settled. The **legacy v1** has no
terminal release path at all. The **reference** (HEAD) has all four. This is a liveness/capital-lock
gap, not a theft path: the invariant `reserved ≤ capital` holds on all three.

---

## 2. The legacy obligations, policy by policy

Source: `list_policies` on `contract.attestor-overcover.testnet` (`proof/legacy-reconciliation.json`).
The legacy module is the original **single-attestor** build: one attestor
(`4dhxyFrsS8y8HhS2CCFYHRbpjTGRudSqPWoHYCRECTxC`), a 60-second challenge window, no operator quorum,
no resolver quorum, no metric registry.

**Pool.** `capital = 14.05`, `reserved = 10.50`, `available = 3.55` NEAR; account balance **18.5473
NEAR**. `reconcile() = true` and `check_invariant() = true`:
`14.05 = 21.00 (deposited) − 6.65 (withdrawn) + 0.60 (premiums) + 0.10 (forfeited bonds) − 1.00 (paid)`.
`reserved (10.50) == Σ payouts of the 13 active policies (10.50)`.

**15 policies, three dispositions.** "Settleable" means a *finalised, undisputed, un-nullified*
reading exists for the policy's `(city, obs_date)`, its challenge window has elapsed, and the value
meets the threshold — so `resolve(policy_id)` is **permissionless** and would succeed right now.

| Disposition | Count | Reserved | What the chain allows today |
| --- | --- | --- | --- |
| **Settleable → pays** | 4 | 2.00 NEAR | `resolve()` succeeds and pays the beneficiary (policies #2, #6, #8, #10). |
| **Locked (no reading)** | 9 | 8.50 NEAR | `resolve()` reverts `"no observation"`; no reading can ever be produced; the reservation is **locked forever**. |
| **Already settled** | 2 | — | #3 `settled_paid` (1.00 NEAR), #4 `settled_no_pay`. |

Policy-by-policy (all 15; `beneficiary == buyer` on every row):

| # | Buyer / beneficiary | Product | Payout | State | Obs date | Reading |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `grower-overcover.testnet` | `p-1794315395272-3` | 1.00 | active | 2026-11-10 | none → locked |
| 2 | `grower-overcover.testnet` | `p-1794315450827-7` | 0.50 | active | 2026-11-10 | value 1 ≥ thr 1 → **pays** |
| 3 | `grower-overcover.testnet` | `rain-lagos` | 1.00 | settled_paid | 2026-11-10 | paid |
| 4 | `grower-overcover.testnet` | `rain-bergen-dry` | 0.50 | settled_no_pay | 2026-11-10 | no-pay |
| 5 | `grower-overcover.testnet` | `p-1794319206542-3` | 1.00 | active | 2026-11-10 | none → locked |
| 6 | `grower-overcover.testnet` | `p-1794319261805-7` | 0.50 | active | 2026-11-10 | value 1 ≥ thr 1 → **pays** |
| 7 | `grower-overcover.testnet` | `p-1794319315964-3` | 1.00 | active | 2026-11-10 | none → locked |
| 8 | `grower-overcover.testnet` | `p-1794319370961-7` | 0.50 | active | 2026-11-10 | value 1 ≥ thr 1 → **pays** |
| 9 | `grower-overcover.testnet` | `p-1794337387611-3` | 1.00 | active | 2026-11-10 | none → locked |
| 10 | `grower-overcover.testnet` | `p-1794337442850-7` | 0.50 | active | 2026-11-10 | value 1 ≥ thr 1 → **pays** |
| 11 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | active | 2026-11-11 | none → locked |
| 12 | `oc-agent-mwb87z4k.testnet` | `rain-bergen-dry` | 0.50 | active | 2026-11-11 | none → locked |
| 13 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | active | 2026-11-12 | none → locked |
| 14 | `oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | active | 2026-11-13 | none → locked |
| 15 | `human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet` | `rain-lagos` | 1.00 | active | 2026-11-13 | none → locked |

**Correction to the earlier framing.** `LEGACY_POLICYHOLDER_RECONCILIATION.md` says the 13 active
policies "cannot be settled … the payout leg is inert for want of a valid reading." That is **true
for 9 of them and false for 4**: policies #2, #6, #8 and #10 have a matching finalised reading whose
value meets the threshold, so any account can call `resolve()` on them today and 0.50 NEAR will be
paid to each beneficiary (2.00 NEAR in total). This report supersedes that sentence; the settlement
leg is **partly live**, not inert.

### The v3 default carries the same, smaller, lock

`contract.ovc-v3-ctl-2f6c4c.testnet`: `capital = 1.425`, `reserved = 0.20`, `available = 1.225` NEAR;
3 policies (1 `settled_paid`, 2 `active`, each 0.10 NEAR). Both active policies have no reading, and
the deployed module lacks the SEC-7 release — so their 0.20 NEAR is locked in exactly the same way.
The two `active` policies are `heat-lagos-factory` (permissionless factory product) and a
`heat-lagos` policy bought by the agent demo account.

---

## 3. Authority: who can still act, and on what

| Contract | Authority | Held today? | What that means |
| --- | --- | --- | --- |
| legacy v1 | contract-account FullAccess key; owner account key | **No** (lost) | SEC-1 takeover cannot be closed; the account cannot be paused or upgraded. |
| v3 default | contract-account FullAccess key; owner account key | **No** (lost) | SEC-6/7/9 cannot be redeployed onto it. |
| reference | 15 FullAccess keys in `keys/controlled-v3.json` (mode `0600`, gitignored) | **Yes — but sandbox-local** | The only deployment whose authority is held; the key location is exactly the class of place that lost the originals. |

Two facts make the current exposure precise:

1. **Permissionless settlement is available to anyone** on the 4 settleable legacy policies, with no
   key. This is the contract working as designed — but it means the legacy obligations are not
   fully frozen, and a third party can trigger 2.00 NEAR of payout at any time.
2. **SEC-1 remains live and permissionless** on the legacy address. A third party calling
   `migrate()` can replace the owner and attestor and reset pool accounting, stranding the 18.55 NEAR
   balance and the live obligations. Reproduced against the exact deployed bytecode by
   `npm run verify:sec1-takeover` (17/17, sandbox). It cannot be closed without the legacy key.

---

## 4. Continuity options, with trade-offs

The mission asks for at least three paths. They differ on three axes: **who controls the successor's
authority**, **what happens to the legacy obligations**, and **whether the change touches the legacy
account**.

### Option A — Adopt the reference; transfer its authority to the owner

Keep `contract.ovc-v3-ctl-mwgci3u8.testnet` as the successor and hand its key to the owner: the
operator adds the **owner's own** FullAccess key to the owner and contract accounts, the owner stores
it off-platform, then the operator's key is removed.

- **Pros.** Zero new deployment. The reference is byte-identical to HEAD and carries SEC-1/6/7/9.
  Fastest path to a successor with durable authority.
- **Cons.** Depends on the operator's sandbox key surviving long enough to complete the handover; the
  handover itself is a key operation that must be done carefully. The reference's *contract-account*
  key is still the upgrade authority, so the owner must hold it too (or the contract becomes
  unupgradable).
- **Legacy.** Untouched. Legacy runs off exactly as today.

### Option B — Fresh deployment under a root the owner controls *(recommended)*

Create a new root the owner controls, deploy the same HEAD wasm (`811e0427…`) against it, and make
the successor the console's default purchase destination. This is the flow the repository already
plans (`npm run verify:controlled-v3:plan`, `OVERCOVER_USE_FAUCET=0 npm run verify:controlled-v3`).

- **Pros.** The successor's root and authority are generated **for** the owner, so custody is durable
  from day one rather than inherited from a sandbox. Clean separation from every lost key. No
  dependence on the reference's ephemeral file. No legacy interaction.
- **Cons.** A new deployment is a new operation to rehearse and verify (the plan and the on-chain
  evidence harness already exist). Requires the owner to supply a funded testnet root and to store the
  key durably.
- **Legacy.** Untouched. Legacy runs off exactly as today.

### Option C — In-place hardening of an existing contract

Redeploy the hardened wasm onto `contract.ovc-v3-ctl-2f6c4c.testnet` (or the legacy address) via the
state-preserving `migrate`.

- **Cons.** **Not possible for either live address** — it needs the FullAccess key for the target
  account, and neither key is held. Listed only to mark it closed.
- **Legacy.** Would have been the ideal *containment* fix (it closes SEC-1 in place, preserving all
  15 policies); it is blocked purely on the missing key, which is a documented external-authority
  blocker, not an engineering gap.

### Recommendation

**Option B.** It is the only path that ends with the owner holding the successor's authority *by
construction*, which is the one thing that failed originally and the one thing Options A and C leave
to chance or block outright. Option A remains a valid fallback if the owner prefers speed and is
willing to perform the key handover deliberately. In both cases the legacy contract is **not touched**
and its obligations are **not migrated**.

---

## 5. The legacy-policyholder continuity decision

**Decision: run the legacy contract off; do not migrate it; represent it honestly; and make the two
kinds of legacy policy — settleable and locked — visible as the different things they are.**

This follows `LEGACY_CONTAINMENT_AND_MIGRATION_PLAN.md` §5 (no automatic migration) and corrects the
one place where the current documentation over-states the freeze.

**What "run-off" means here, precisely:**

1. **No new cover is steered to legacy.** The console already refuses to sign against it (gated on the
   deployed `code_hash`, verified by `npm run verify:connectivity` 13/13). A third party using raw RPC
   can still call the legacy `buy_cover`, which the project cannot prevent without the key.
2. **The 4 settleable policies are a live obligation, not frozen capital.** They will pay 2.00 NEAR if
   anyone calls `resolve()` on them. The honest positions are (a) let them pay — it is the product
   working, permissionlessly, exactly as designed; or (b) if the project wants them settled on a known
   schedule, settle them itself (permissionless, no key) and record the transaction. Either way the
   documentation must stop calling them inert.
3. **The 9 locked policies stay reserved and unsettleable.** Their 8.50 NEAR of reservation is
   permanently encumbered on the legacy address (v1 has no release path). This is not lost to a
   third party *by the contract's own logic*; it is stranded by the missing reading and the missing
   release code. State it as stranded, not as "held".
4. **No bulk settlement, ever.** Settlement is per-policy and follows the reading. A bulk reassignment
   of payouts would break the immutable-product guarantee.
5. **No successor claims to have assumed the legacy policies.** The console and `llms.txt` present the
   legacy address as legacy and its policies as legacy state.
6. **If the legacy key is ever recovered**, the design in `LEGACY_CONTAINMENT_AND_MIGRATION_PLAN.md` §4
   applies: snapshot, in-place hardening (closes SEC-1), verify preservation, then re-open the
   settlement leg only if an attestor key is also available. Nothing about that changes the successor.

---

## 6. Key lifecycle controls the successor must have

These are the controls that convert "a deployment whose key is held" into "a deployment that cannot
suffer the original failure." They are requirements on the operation, not code.

| Control | Requirement |
| --- | --- |
| **Generation** | The root keypair is generated in a controlled environment for the owner; it is never generated inside a throwaway agent sandbox and left there. |
| **Custody / persistence** | The owner holds the FullAccess key **off-platform** (hardware wallet, or a managed key store the owner controls). It is never committed, never printed, and never the only copy on a machine that can be discarded. |
| **Access separation** | Four distinct roles, four distinct keys: **owner** (products, pause, quorum config), **contract-account** (upgrades only, ideally a cold key), **operator** (signs readings), **resolver** (votes on disputes). No key serves two roles. The contract already enforces the owner/resolver separation in code (`resolver_vote` refuses the owner and the signers). |
| **Backup** | The owner keeps an offline backup of the root and contract-account keys, stored separately from the working copy. Test the backup by restoring onto a throwaway account. |
| **Rotation** | Operators rotate via `rotate_operator_key` (owner-gated; `rot1..rot5`). The **owner** key has no recovery function on NEAR by design; rotation is *add a second FullAccess key, verify, remove the old* — rehearse it on the reference before the successor goes live. |
| **Drills** | Before the successor accepts risk: rehearse a code-only upgrade and an operator-key rotation on the reference, and confirm `npm run verify:preservation` reports "DIFFERENCES: none" except the code hash. |
| **Incident response** | A written path for "a key is suspected compromised": freeze purchases (`set_paused`, owner), rotate the operator keys, and — for the owner key — add/remove FullAccess keys immediately. The legacy failure is the case study. |
| **No secret in the repo** | The CI secret scan (`.github/workflows/ci.yml`) is the enforcement point; it must stay green. Public keys in evidence artifacts are truncated (`scripts/legacy-reconciliation.mjs`) so they do not trip the deliberately fail-closed scanner. |

---

## 7. Capital and entitlement reconciliation — preconditions before any successor accepts risk

Before the successor accepts a single new policy, produce and publish:

1. **A fresh legacy reconciliation** (`node scripts/legacy-reconciliation.mjs`) showing, at that
   instant: `capital`, `reserved`, `available`, `reconcile()`, `check_invariant()`, the 15 policies,
   and the settleable/locked split. This is the "before" snapshot, independently re-derivable.
2. **The identity check** `Σ payouts of active policies == reserved` and `reserved ≤ capital`, on both
   live contracts.
3. **An explicit statement that successor capital is separate.** The successor's `capital`/`reserved`
   are its own; a successor purchase can never move or strand a legacy policy, and no successor
   transaction can reach the legacy account. Verified by the two contracts having distinct
   `capital`/`reserved` and distinct accounts.
4. **A decision, recorded, on the 4 settleable policies** (pay now via permissionless `resolve()`, or
   accept they may be settled by anyone at any time) and on the 9 locked ones (acknowledge them as
   stranded; do not claim to hold them).
5. **No migration.** There is no code path that moves legacy funds or reassigns legacy payouts, and
   none will be added.

---

## 8. Independent checks before release

| Check | Who | Status |
| --- | --- | --- |
| Security review of the successor module | independent reviewer / professional audit | **Outstanding.** The module is unaudited; testnet only, not for real funds. |
| Key-custody review (who holds what, where, backups) | the owner + a second party | **Outstanding** — this is the whole risk. |
| Live human wallet approval against the successor | a human with a funded **testnet** wallet | **Outstanding.** Every browser-wallet behaviour is proven against a mock wallet and by loading the real bundle; no live extension approval has been captured on v3. |
| Independent re-read of the deployed successor bytes | `npm run verify:controlled-v3:evidence` | **Available** — re-reads all four controlled runs from RPC. |
| Legal / regulatory review | qualified counsel | **Outstanding.** Parametric insurance is a regulated activity; the product is testnet-only and must stay so until this is addressed. |

The **only** live human purchase on record (PR #39) was on the **legacy v1** contract and must be
presented as historical and legacy, never as a v3 human purchase.

---

## 9. What this document does not do

- It does **not** deploy anything, migrate anything, settle anything, or touch either live contract.
- It does **not** claim the legacy address is contained. SEC-1 is live and permissionless there; the
  containment options (pause, in-place hardening) are both blocked on the missing key.
- It does **not** claim the successor is production-ready. It is a testnet module, unaudited, and its
  readiness depends on the custody controls in §6 being real, not documented.
- It does **not** claim that fixing SEC-6/7/9 on the *successor* fixes the *legacy* or *v3-default*
  capital locks — those two addresses keep their locked reservations; only the successor is clean.

## 10. Evidence

| Claim | Command / source |
| --- | --- |
| Live code hashes, balances, keys, all views | `node scripts/legacy-reconciliation.mjs` → `proof/legacy-reconciliation.json` |
| Guard presence in live bytecode | §1 scan of `view_code` output (refusal-string match) |
| Legacy pool reconciles | `reconcile()` and `check_invariant()` = `true`; §2 arithmetic |
| SEC-1 reproduced against deployed bytecode | `npm run verify:sec1-takeover` (17/17, sandbox) |
| Successor plan, no key needed | `npm run verify:controlled-v3:plan` |
| Successor on-chain evidence | `npm run verify:controlled-v3:evidence` |
| Reference is HEAD-identical | deployed sha256 `811e0427…` == local `cargo build` output |
| Console refuses the legacy address | `npm run verify:connectivity` (13/13) |
