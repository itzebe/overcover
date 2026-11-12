# Factory testnet deployment — preflight

**As of:** 2026-11-12 · **Repository:** https://github.com/itzebe/overcover · **Branch:** `main`
**Baseline HEAD:** `93bbecaacd855f52a043c8a21e2c7f554cbafde7`
**Status:** ✅ **DEPLOYED AND VERIFIED (2026-11-12)** — `npm run verify:controlled-v3` passed **40/40**
against the live contract `contract.ovc-v3-ctl-2f6c4c.testnet` on NEAR testnet, including the
permissionless factory path (non-owner proposal → automatic activation → factory purchase). Evidence:
`proof/controlled-v3-deploy.json` and `proof/controlled-v3-onchain-evidence.json`.

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
ovc-v3-ctl-<tag>.testnet          <- the funding root (created + funded by the human)
  ├─ owner.<root>      ├─ buyer.<root>   ├─ attacker.<root>   ├─ proposer.<root>
  ├─ op1..op5.<root>   ├─ res1..res5.<root>
  └─ contract.<root>                <- the contract account (wasm is deployed here)
```

The harness derives the whole graph from **one operator-supplied root** and never invents it. Supply it
either as environment variables (`OVERCOVER_ROOT_ACCOUNT_ID` + `OVERCOVER_ROOT_SECRET_KEY`) or as a
gitignored file `keys/controlled-v3-root.json` (`{ "accountId": "...", "secretKey": "..." }`, mode
0600). The sub-account keys are random and never printed. Two viable funding paths:

- **Path A (recommended, self-contained):** the human creates **one** fresh top-level testnet account
  named e.g. `ovc-v3-ctl-<tag>.testnet` (any wallet or the web faucet at https://near-faucet.io/),
  funds it with **≥ 10 NEAR**, and passes it to the harness via the env vars above.
- **Path B:** fund **one** existing testnet account that already holds a FullAccess key the operator
  controls with **≥ 10 NEAR**, and point the harness at it the same way.

(The root must be a **named** account, e.g. `*.testnet`; an implicit 64-hex account cannot host the
sub-accounts the harness creates, and is refused early.)

**Recommended account to fund:** `ovc-v3-ctl-<tag>.testnet` (a new top-level account). The public
address is exactly the account id; it is created and funded by the human, not by this environment.

### Prepared identity (autonomous run, 2026-11-12)

A fresh keypair and its gitignored credential file are already in place, so the run needs **funding
only** — no further setup:

| Item | Value |
| --- | --- |
| Account id (public) | `ovc-v3-ctl-2f6c4c.testnet` (**created + funded 2026-11-12**, balance 10.000000 NEAR) |
| Funding | official helper faucet, one request; tx `67m4ApUC58zkFiNxP31e4Za3ZbwU5NrK5RFd2KbRDi4q` (signer `testnet`) |
| Keypair | generated; the secret lives only in `keys/controlled-v3-root.json` (mode 0600, gitignored) — never printed, never committed |

The harness loads it automatically (it is the default `ROOT_FILE`). The live run is a single command
with no arguments. To use a different account, overwrite that file (or set the two env vars); the
generated keypair is disposable.

## 5. Minimum funding requirement

Storage price on testnet is **1 × 10⁻⁵ NEAR per byte** (`storage_amount_per_byte = 10000000000000000000`).
The contract code is **500 023 bytes**, so the code stake is the dominant cost.

| Item | Amount (NEAR) |
| --- | --- |
| Code stake (`500023 × 1e-5`) | **5.0002** |
| Contract state + account storage reserve | ~0.2 |
| `owner` (pool seed 1.5 + gas float) | 1.8 |
| `buyer` (premium + gas float) | 0.3 |
| `attacker` (challenge bond + gas float) | 0.3 |
| `proposer` (0.1 NEAR proposal stake + gas float) | 0.4 |
| `op1…op5` (5 × 0.15, gas float) | 0.75 |
| `res1…res5` (5 × 0.15, gas float) | 0.75 |
| **Subtotal (harness funding map)** | **9.50** |
| Safety margin (recoverable; code stake refunded on next upgrade) | +0.30 |
| **Recommended funding** | **≥ 10 NEAR** (hard floor **9.8 NEAR**) |

The harness enforces the floor: before it spends anything it reads the root balance and **fails closed**
with the exact shortfall if the root holds less than `subtotal + 0.3`.

Notes:
- The pool seed is 1.5 NEAR (not 0.5) because the factory product's declared capacity is checked
  against `capital − capital/5`; a small pool cannot host two products. See §7.
- The gas float is small today (gas price `1e8` yocto/Gas → 0.01 NEAR per 100 Tgas call); the harness
  budgets a worst case of `1e9` → 0.1 NEAR per call, which the map already covers.
- The code stake (~5 NEAR) is **refunded** when the account is later upgraded or deleted.

## 6. Faucet status and restrictions (resolved 2026-11-12)

| Source | Result |
| --- | --- |
| `helper.testnet.near.org/account` | **Working again** — the earlier 429 cooldown elapsed; granted **10 NEAR** for one account. Used for `ovc-v3-ctl-2f6c4c.testnet`. |
| `faucet.fastnear.com/account`, `testnet-faucet.near.org/account` | proxy the same helper backend (not independent) |
| `faucet.zalalena.com/near/` | online but only **0.005 NEAR/claim** and gated by hCaptcha + Cloudflare Turnstile |
| `near-faucet.io` | a NEAR contract `near_faucet` call via a wallet selector; **2 NEAR max**, requires wallet signing |
| `docs.near.org/getting-started/faucet` | confirms `helper.testnet.near.org` is the canonical programmatic faucet |
| Public RPC (`rpc.testnet.near.org`, fastnear, drpc) | all **healthy**, chain `testnet` |

**Resolution:** the helper faucet's IP rate limit cleared, so the prepared root was funded with a single
request (no identity rotation, no retries). The account and its funding tx are recorded in §4.
(`OVERCOVER_USE_FAUCET=1` remains available for a self-contained smoke run once the faucet recovers.)

## 7. Factory path in the harness (gap found, now closed)

**Original gap:** `proof/controlled-v3-deploy.mjs` had **no `proposer` role and no `propose_product`
call** — it proved the v3 operator/resolver lifecycle and the SEC-1 closure, but not the permissionless
path. A funded run would have deployed the factory wasm and never exercised it.

**Fix (this branch):** the harness now proves the whole factory lifecycle:

1. Creates an **independent `proposer`** sub-account, asserted distinct from the owner.
2. Has the **proposer (never the owner)** sign `propose_product(...)` with the 0.1 NEAR stake, then
   asserts `get_product(id).active == true`, `proposed_by == proposer`, `evidence_hash` recorded, the
   product appears in `list_products`, and the stake raised the pool's `capital`.
3. Asserts an adversarial proposal (unknown metric) is **refused on chain**.
4. Buys cover on the permissionlessly-created product and asserts the policy belongs to the buyer on
   that product, its payout is **reserved**, the pool stays **solvent**, and `reconcile() == true`.
5. Records the `propose_product` tx hash and the factory policy id in the evidence file.

The factory block runs **after** the operator/resolver lifecycle settles, so it cannot be satisfied by
the owner's own purchase; the pool's `reserved` is back to 0 by then.

**Discovery while wiring it up:** the owner product originally declared `max_total_coverage = 20 NEAR`.
The contract sums every product's declared capacity and refuses any change that pushes the total above
`capital − capital/5`; with the small pool that made *any* second product impossible
(`product capacity exceeds available capital`), and the owner product itself failed
(`capacity below a single max payout`). The harness now uses a self-consistent configuration: a 1.5
NEAR pool, the owner product at `max_payout 0.3` / `max_total_coverage 0.4`, and the factory product at
`max_payout 0.1` (capacity 0.5). After the lifecycle settles, `capital = 1.315`, the ceiling is `1.052`,
and the committed total is `0.9` — so both products are valid and both are proven live.

The factory flow is also proven on the compiled wasm against a real `neard` node
(`npm run verify:factory` → **22/22**). The full harness is validated in sandbox mode:
`npm run verify:controlled-v3:sandbox` → **39/39**.

## 8. Exact commands after funding

```bash
# 0. preconditions: funded root account; pinned toolchain; deps installed
npm ci --ignore-scripts

# 1. build the factory wasm and confirm it is the pinned artifact
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm
#   expected: a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1  (500023 bytes)

# 2. prove the same harness locally first (no funds)
npm run verify:controlled-v3:sandbox     # expect 39/39
npm run verify:factory                   # expect 22/22

# 3. print the plan (sends nothing)
npm run verify:controlled-v3:plan

# 4. the live deployment + verification (sends transactions; needs the funded root)
#    Provide the root via env (or keys/controlled-v3-root.json, gitignored):
OVERCOVER_ROOT_ACCOUNT_ID=ovc-v3-ctl-<tag>.testnet \
OVERCOVER_ROOT_SECRET_KEY=<secret-key> \
REQUIRE_TESTNET=1 npm run verify:controlled-v3   # REQUIRE_TESTNET=1 fails loudly instead of SKIP

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
local funds). The harness now takes an operator-supplied root (§4), so the human funds **one** account
with **≥ 10 NEAR** and passes its id + key to the harness — no further code change is needed. No
technical work remains blocked: the factory implementation, the wasm, the harness factory path, the
sandbox proofs (39/39) and the CI are all green.

**Stop point:** this preflight performs no deployment. Waiting for human funding authorization.
