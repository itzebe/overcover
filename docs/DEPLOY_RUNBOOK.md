# Deploy runbook — v2 decentralized lifecycle to NEAR testnet

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
wasm lacks the guard. Code stake for ~450 KB is ~4.63 NEAR, refunded on the next upgrade.

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
- `SUBMISSION.md` §"Deployed code hash" and `README.md` "Verification evidence".
- `proof/verification.json` — regenerated by `npm run verify:proof`.

Re-run `npm run verify:proof` (expect 12/12), then `npm run test:onchain` against the fresh deploy
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
