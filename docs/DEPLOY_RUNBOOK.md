# Deploy runbook — v2 decentralized lifecycle to NEAR testnet

> **Current default.** The console's default purchase destination is now the hardened **v3**
> contract `contract.ovc-v3-ctl-2f6c4c.testnet`. The steps below upgrade the **legacy** address
> `contract.attestor-overcover.testnet` in place (from v1 to v2/v3); they are kept because that
> address still runs the original v1 module and closing SEC-1 there needs the operator's key. A
> fresh controlled v3 deployment is done by `npm run verify:controlled-v3` (see
> `docs/FINAL_RELEASE_READINESS.md`).

This is the exact, ordered set of steps to move the **v2** contract (the branch
`feat/decentralized-insurance-lifecycle`) onto NEAR testnet. It needs the funded operator identity
that the previous deploys used; **no faucet is involved** — the contract sub-account is funded from
the existing `attestor-overcover.testnet` identity.

Do not run these steps until CI on the branch is green. Deploy from the branch **first**, then merge —
that keeps `main` aligned with what is actually on chain (the whole point of the bytecode proof).
Do not run them against mainnet. The console reads whatever contract id it is pointed at, so no UI
change is needed for the deploy itself; the UI is already version-aware.

## 0. Prerequisites

- `keys/identities.json` present (gitignored) and its `attestor` account funded with **≥ 6 NEAR**
  (the deploy funds the contract sub-account with 4.5 NEAR and pays gas). Check the balance with the
  public RPC; do not paste keys anywhere.
  **This file is not in the repository** — it is the funded operator identity. Without it neither
  the fresh deploy nor the in-place upgrade can be signed. The contract's own full-access key is the
  only thing that can authorise the upgrade, and it is held only by the operator.
- Rust with the pinned toolchain (`rust-toolchain.toml`, `1.99.1`) and the `wasm32-unknown-unknown`
  target.
- Node 20+ and `npm ci --ignore-scripts`.

## 1. Build and prove the contract locally (no chain, no funds)

```bash
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
npm test                 # model + sim + contract + console + agent
npm run verify:sandbox   # runs the compiled wasm on a real local neard node — expect 21/21
npm run verify:upgrade   # proves the SEC-1 guard on the compiled wasm — expect 8/8
```

Stop here if `verify:sandbox` is not 21/21 or `verify:upgrade` is not 8/8.

**Rebuild before you deploy.** A previously-built `overcover.wasm` may predate the SEC-1 fix. Both
`driver/deploy.js` and `driver/upgrade.js` refuse to run if the wasm lacks the guard string
(`migrate may only be called by the contract account itself`), so a stale artifact fails closed
instead of silently shipping the vulnerability.

## 2. Record the pre-deploy state

```bash
# the current (v1) deployed module, so the change is auditable
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"contract.attestor-overcover.testnet"}}' \
  | python3 -c 'import sys,json,hashlib,base64;d=json.load(sys.stdin);print(hashlib.sha256(base64.b64decode(d["result"]["code_base64"])).hexdigest(), d["result"]["hash"])'
# expected v1: 1f30ccf1… / 36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R
```

## 3. Deploy

There are two paths. **Prefer the in-place upgrade** when the goal is to close SEC-1 on the existing
contract: it keeps the address, the pool capital and the policies, and costs only the code stake.

### 3a. In-place upgrade (non-destructive — recommended for the SEC-1 fix)

```bash
node driver/upgrade.js --plan   # prints the exact operations + costs; sends nothing
node driver/upgrade.js          # DeployContract + self-call migrate + reconfigure
```

`driver/upgrade.js` deploys the new wasm to the **existing** account and then calls `migrate` as a
**self-call** (`predecessor == current_account_id`), which is the only caller the SEC-1 guard permits.
It then re-applies the owner-side configuration (quorum, resolvers, metrics). It refuses to run if the
wasm lacks the guard. Code stake for ~470 KB is ~4.63 NEAR, refunded on the next upgrade.

**`migrate` preserves the live state.** It reads the v1 blob and re-encodes it in the v2 shape:
pool accounting (`capital`, `reserved`, `premiums_collected`, …), `next_policy_id`, the owner and
protocol config, and every product, policy, provider and observation survive; the only change is that
records gain the v2 fields (legacy products/policies take `metric_id = ""`, `direction = "Above"`) and
observations are re-keyed from `city|date` to `metric|city|date`. `proof/upgrade-state-preservation.mjs`
proves this against the **exact live v1 bytecode** on a real neard sandbox: after `DeployContract(v2)`
+ self-call `migrate()`, capital and reserved are unchanged, the policy and product are still listed,
and the migrated policy still **settles**. (An earlier `migrate` called `new_state`, which zeroed the
scalars and left the collections undecodable — that path is what this fixes.)

`migrate` also **fails closed**: on a state that is not a v1 blob (e.g. a second self-call after the
upgrade) it refuses with `migrate: existing state is not a v1 blob (already migrated?)` and changes
nothing. `proof/upgrade-guard.mjs` proves both the third-party refusal and this fail-closed case.

### 3b. Fresh deploy (destructive — resets all state)

```bash
node driver/keys.js          # reuses the funded identity; creates any missing role accounts
OVERCOVER_DEMO_WINDOW=60 npm run deploy
```

`driver/deploy.js` deletes and recreates the contract sub-account (so near-sdk collection storage is
clean), deploys the new wasm, calls `new(...)`, then registers the metrics, the 3-of-5 operator
quorum and the 3 independent resolvers. The address `contract.attestor-overcover.testnet` is stable,
but the pool, policies and providers are wiped — use this only when a clean state is wanted.

**Why `migrate` is a self-call.** The security pre-audit hardened `migrate` so a third party can no
longer overwrite all state (see `docs/SECURITY_PRE_AUDIT.md`, finding SEC-1). A call from any account
other than the contract itself is refused; `proof/upgrade-guard.mjs` proves this on the compiled wasm.

### 3c. Code-only upgrade of the deployed v3 module (SEC-6 / SEC-7 / SEC-9)

The v3 account `contract.ovc-v3-ctl-2f6c4c.testnet` currently runs sha256 `a97034e6…` (500023 bytes).
The SEC-6/SEC-7/SEC-9 fixes change **only** contract logic — `observation_settlement`/`resolve` and the
`buy_cover` lead check — plus a new `const MAX_LEAD_SEC`. **No stored struct changes**, so the state
layout is identical and a plain `DeployContract` preserves the pool, products, policies, providers and
observations. Do **not** call `migrate` here: it is a v1→v2 migrator and will fail closed on the
already-v3 state (that is the safe behaviour, not a bug).

**Prerequisite:** the account's full-access key (operator-held; never committed). This environment has
no key material, so this step is **not** performed here.

**Artifact lineage (verified in this environment, `CARGO_HOME=/home/openhands/.cargo`, rustc 1.99.1).**
The recorded pre-hardening hash `40aa677e…` was not reproducible; the values below were re-derived by
building the exact source of each commit. The wasm embeds source line numbers, so a *comment-only*
edit changes the hash — rebuild from the exact commit you intend to deploy.

| Source commit | What it is | wasm sha256 | size |
| --- | --- | --- | --- |
| `3725f04` (an older `main`) | the **live** v3 module | `a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1` | 500023 |
| `27da91f` | + SEC-6 / SEC-7 | `40aa677e9c646f38cbaf841c53b36b56b377668751aee64289839926e8bb5da8` | 500154 |
| `d7b2074` (HEAD) | + SEC-9 (release build) | `811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f` | 500342 |

Building `3725f04` reproduces the live `a97034e6…` **byte-exactly**, which confirms this environment
matches the deployment build environment. Note the historical record quoted `0fd707e7…` for the SEC-9
build; that value does not reproduce from the committed source (no comment variant reproduces it), so
the verified release artifact is `811e0427…`.

```bash
# 1. Build the fixed wasm with the pinned toolchain (rust-toolchain.toml, 1.99.1).
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm   # expect 811e0427…

# 2. Record the pre-upgrade code hash (for the rollback below).
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet"}}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["hash"])'   # expect CQR8x1kW…

# 3. Deploy the new code to the SAME account (state-preserving; no migrate).
#    `driver/redeploy-v3.mjs` does exactly one DeployContract — no new(), no migrate().
#    It fails closed unless the wasm sha256 matches OVC_EXPECTED_SHA and the wasm
#    contains the SEC-9 guard string. It never prints the key.
node driver/redeploy-v3.mjs --plan          # prints the operation; needs no key, sends nothing
# The operator, holding the v3 account's full-access key, runs the signed step:
OVC_EXPECTED_SHA=811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f \
  OVC_V3_SECRET_KEY=… node driver/redeploy-v3.mjs
# (or put {"account_id","secret_key"} in the gitignored keys/v3-operator.json, mode 0600)

# 4. Re-verify: the new code hash, the unchanged pool, and the SEC-9 refusal.
node proof/controlled-v3-evidence.mjs   # wasmSha256MatchesDeployedCode must become true
```

Until this runs, `npm run verify:proof` correctly reports `SOURCE AHEAD OF DEPLOYMENT`, and the live
contract keeps the capital-lock behaviour. **Rollback:** redeploy the previous module (step 3 with the
recorded `a97034e6…` wasm) — again code-only, state-preserving.

## 4. Verify the deploy

```bash
# the deployed module must be the wasm you just built
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm

# the v2 views must exist and be populated
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.attestor-overcover.testnet","method_name":"list_metrics","args_base64":"e30="}}'
```

Then update the pinned hash and the live-proof expectations, which are the two places the deployed
bytecode is asserted:

- `proof/verify.mjs` — `EXPECTED_SHA` (the new wasm sha256) and the `code_hash` literal.
- `ui/index.html` — the `TRUSTED` approved-build list for `contract.ovc-v3-ctl-2f6c4c.testnet`. It
  already accepts the new build (`9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C`, the code hash of
  `811e0427…`); once the deploy is verified, drop the superseded live hash so only the hardened build
  is accepted. If this list is not updated, the console reads the contract but **locks buying** with
  "its deployed module does not match the approved build".
- `SUBMISSION.md` §"Deployed code hash" and `README.md` "Verification evidence".
- `proof/verification.json` — regenerated by `npm run verify:proof`.

Re-run `npm run verify:proof` (expect 13/13), then `npm run test:onchain` against the fresh deploy
(needs `keys/identities.json` and `keys/state.json`).

## 5. Run the demo

```bash
npm run demo            # full cycle; rewrites demo-log.json with real tx hashes
npm run operator        # drives the operator quorum for one observation, if run separately
```

## 6. Publish

Merge the branch to `main` (the UI is already v2-aware; the deploy above is the contract side). The
Vercel project auto-builds `main`; confirm the production deployment's `meta.githubCommitSha` equals
the merge commit, and that `https://overcover.vercel.app/` loads with 0 console errors.

## Rollback

Re-run steps 2–3 with the previous commit checked out (`git checkout <v1-sha> -- contract`), or
restore the v1 wasm and re-run `npm run deploy`. The sub-account reset makes the rollback clean. If
the deploy script is interrupted between delete and recreate, re-run it — it is idempotent.
