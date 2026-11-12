# Factory testnet deployment — preflight

**As of:** 2026-11-12 · **Repository:** https://github.com/itzebe/overcover · **Branch:** `main`
**Baseline HEAD:** `8f69e97e530c4ed440bd2fc1ec70d10b05ab367a` (matches the expected baseline)
**Status:** preflight complete · **nothing deployed** · awaiting human funding.

This document is the preflight for the **first live controlled-v3 testnet deployment that carries the
permissionless insurance factory**. It contains no secret material — only public on-chain facts,
public keys and arithmetic. Nothing here spends funds or touches any existing account.

---

## 1. Repository state (verified)

| Check | Result |
| --- | --- |
| Branch | `main` |
| HEAD | `8f69e97e530c4ed440bd2fc1ec70d10b05ab367a` — equals the expected baseline |
| Working tree | clean |
| Latest CI on `main` | run `43172950579` — **success** |
| Open PRs | none |
| Local wasm | `contract/target/wasm32-unknown-unknown/release/overcover.wasm` |

## 2. What was inspected

- The factory implementation merged in PR #27 (`contract/src/lib.rs`: `propose_product`,
  `validate_proposal`, `Product.evidence_hash` / `proposed_by`; `contract/src/tests.rs`).
- `proof/controlled-v3-deploy.mjs` (the testnet deployment harness), `proof/gas-budget.mjs`,
  `proof/controlled-v3-evidence.mjs`, `proof/factory-sandbox.mjs`, `scripts/sandbox-bin.mjs`.
- `docs/DEPLOY_RUNBOOK.md`, `docs/AUTHORITY_RECOVERY.md`, `docs/VERIFICATION.md`,
  `docs/FINAL_RELEASE_READINESS.md`, `.github/workflows/ci.yml`.
- The two existing controlled-v3 contract accounts, live over public RPC.

## 3. Existing controlled-v3 accounts — can either be reused?

**No.** Both are unusable for the factory deployment, for two independent reasons:

| Account | Balance | code_hash | Deployed module | Access key |
| --- | --- | --- | --- | --- |
| `contract.ovc-v3-ctl-mwd32f3w.testnet` | 6.511244 NEAR | `6a3DgNG2zWew…` (sha256 `52c11c22…`, 489602 B) | **pre-factory** v3 | FullAccess, **secret lost** |
| `contract.ovc-v3-ctl-mwd3judn.testnet` | 6.496243 NEAR | `6a3DgNG2zWew…` (sha256 `52c11c22…`, 489602 B) | **pre-factory** v3 | FullAccess, **secret lost** |

- **The module predates the factory.** Both run the 489602-byte v3 wasm (sha256 `52c11c22…`).
  A live probe of `propose_product` on each returns **`MethodNotFound`** — they have no permissionless
  path. The factory wasm is 500023 bytes, sha256 `a97034e65fb0c53f…`.
- **The signing keys are gone.** Both accounts hold a FullAccess key whose secret was never persisted
  (`keys/controlled-v3.json` does not exist; `keys/` is empty — the incremental-persistence fix landed
  only after these two runs). Neither account can be upgraded or reconfigured by anyone here.

**Conclusion:** a factory deployment requires a **new, freshly funded account**. Reusing either
address would overwrite evidence and is impossible without its lost key. They must not be touched.

## 4. Recommended deployment account

The deployment harness (`proof/controlled-v3-deploy.mjs`) generates a **fresh, random ed25519 key**,
creates the root account from it, and derives the whole identity graph as sub-accounts:

```
ovc-v3-ctl-<tag>.testnet          <- the funding root (faucet-created)
  ├─ owner.<root>      ├─ buyer.<root>   ├─ attacker.<root>
  ├─ op1..op5.<root>   ├─ res1..res5.<root>
  └─ contract.<root>                <- the contract account (wasm is deployed here)
```

Because the harness keys are random and never printed, the human does not need to know them. Two
viable funding paths:

- **Path A (recommended, self-contained):** the human creates **one** fresh top-level testnet account
  named e.g. `ovc-v3-ctl-<tag>.testnet` (any wallet or the web faucet at https://near-faucet.io/),
  funds it with **≥ 9.6 NEAR**, and the harness runs `bootstrapTestnet()` against it. *(The harness
  currently always faucets its own root — see §7; a one-line change makes it accept this account.)*
- **Path B (no code change):** fund **one** existing testnet account that already holds a FullAccess
  key the operator controls with **≥ 9.6 NEAR**, and point the harness at it.

**Recommended account to fund:** `ovc-v3-ctl-<tag>.testnet` (a new top-level account). The public
address is exactly the account id; it is created and funded by the human, not by this environment.

## 5. Minimum funding requirement

Storage price on testnet is **1 × 10⁻⁵ NEAR per byte** (`storage_amount_per_byte = 10000000000000000000`).
The contract code is **500 023 bytes**, so the code stake is the dominant cost.

| Item | Amount (NEAR) |
| --- | --- |
| Code stake (`500023 × 1e-5`) | **5.0002** |
| Contract state + account storage reserve | ~0.6 |
| `owner` (pool seed + gas float) | 0.8 |
| `buyer` (premium + gas float) | 0.3 |
| `attacker` (challenge bond + gas float) | 0.35 |
| `proposer` (proposal stake + gas float) — *new, for the factory step* | 0.5 |
| `op1…op5` (5 × 0.15, gas float) | 0.75 |
| `res1…res5` (5 × 0.15, gas float) | 0.75 |
| **Subtotal (harness funding map, with proposer)** | **9.45** |
| Safety margin (recoverable; code stake refunded on next upgrade) | +0.55 |
| **Recommended funding** | **≥ 10 NEAR** (hard floor **9.6 NEAR**) |

Notes:
- The free faucet grants up to **10 NEAR** per account, so one faucet account suffices.
- The gas float is small today (gas price `1e8` yocto/Gas → 0.01 NEAR per 100 Tgas call); the harness
  budgets a worst case of `1e9` → 0.1 NEAR per call, which the map already covers.
- The code stake (~5 NEAR) is **refunded** when the account is later upgraded or deleted.

## 6. Faucet status and restrictions (checked now, not assumed)

| Source | Result |
| --- | --- |
| `helper.testnet.near.org/account` | **HTTP 429** — "Rate limit exceeded, retry in 10 hours" |
| `faucet.fastnear.com/account` | unreachable (connection failed) |
| `testnet-faucet.near.org/account` | unreachable (connection failed) |
| `near-faucet.io` API | HTTP 404 (web UI only) |
| Public RPC (`test.rpc.fastnear.com`, `rpc.testnet.fastnear.com`, `near-testnet.drpc.org`, `rpc.testnet.near.org`) | all **healthy**, chain `testnet` |

**Restriction:** the environment's IP is rate-limited on the free faucet, and no funded key exists
locally (`keys/` is empty). The human must fund the account from a **different IP/session** (browser
faucet) or wait out the 10-hour window.

## 7. Readiness gap found (must fix before the funded run)

**The deployment harness does not exercise the factory.** `proof/controlled-v3-deploy.mjs` has **no
`proposer` role and no `propose_product` call** — it proves the v3 operator/resolver lifecycle and the
SEC-1 closure, but not the permissionless path. Running `npm run verify:controlled-v3` as-is would
**deploy the factory wasm and never prove it works.**

Corrective action (small, already templated by `proof/factory-sandbox.mjs`, 22/22):

1. Add a `proposer` sub-account to the identity graph (funded ~0.5 NEAR).
2. After the metrics/products are configured, have the **non-owner** `proposer` call
   `propose_product(...)` with a 0.1 NEAR stake, then assert:
   `get_product(id).active == true`, `proposed_by == proposer`, `evidence_hash` recorded, and the
   product appears in `list_products`.
3. Add one adversarial assertion (e.g. an unknown metric is refused) so the on-chain rules are shown
   refusing on testnet, not only in the sandbox.
4. Record the `propose_product` tx hash in `evidence.txs.propose_product`.

The factory flow itself is already proven on the compiled wasm against a real `neard` node
(`npm run verify:factory` → **22/22**, `proof/factory-sandbox.json`); this change carries the same
assertions onto the testnet deployment. It must be validated in sandbox mode before any funded run.

## 8. Exact commands after funding

```bash
# 0. preconditions: funded root account; pinned toolchain; deps installed
npm ci --ignore-scripts

# 1. build the factory wasm and confirm it is the pinned artifact
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm
#   expected: a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1  (500023 bytes)

# 2. prove the same harness locally first (no funds)
npm run verify:controlled-v3:sandbox     # expect 29/29 (+ the new factory checks)
npm run verify:factory                   # expect 22/22

# 3. print the plan (sends nothing)
npm run verify:controlled-v3:plan

# 4. the live deployment + verification (sends transactions; needs the funded root)
npm run verify:controlled-v3             # REQUIRE_TESTNET=1 to fail loudly instead of SKIP on faucet 429

# 5. read back the public evidence, no key needed
npm run verify:controlled-v3:evidence    # rewrites proof/controlled-v3-onchain-evidence.json
```

## 9. Expected on-chain evidence after a successful run

Independent, re-derivable from public RPC (`proof/controlled-v3-deploy.json` +
`proof/controlled-v3-onchain-evidence.json`):

1. **Deployment.** `contract.<root>.testnet` exists with `code_hash` == the base58 of
   `a97034e65fb0c53f…` (expected `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL`), 500023 bytes,
   SEC-1 guard present, and a recorded `DEPLOY_CONTRACT` tx hash.
2. **Permissionless activation.** A `propose_product` tx **signed by `proposer.<root>`** (not the
   owner), whose receipt shows the product active, `proposed_by == proposer`, and the stake raising
   the pool's `capital`. No owner transaction is in the activation path.
3. **Purchase.** A `buy_cover` tx on the permissionlessly-created product, producing a policy whose
   `buyer` is the buyer account and whose `payout` is reserved against capital; the pool stays solvent
   and `reconcile() == true`.
4. **Security.** The SEC-1 refusal (`migrate` by a third party), the sub-quorum refusal, the forged
   signature refusal, and the factory rule refusals — each with its receipt.

Every item is a real testnet transaction with a hash in the evidence file; none is simulated.

## 10. Remaining blocker

**One item: human funding.** The environment cannot create or fund the root account (faucet 429, no
local funds), and the harness keys are random. No further technical work is blocked — the factory
implementation, the wasm, the sandbox proofs and the CI are all green.

**Stop point:** this preflight performs no deployment. Waiting for human funding authorization.
