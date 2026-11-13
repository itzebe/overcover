# Verification — reproduce every claim

Nothing in this project asks to be taken on trust. Every claim below has an exact command.

## 1. The deployed bytecode is exactly this source

```bash
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm
```

Expected: `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e` (344857 bytes).

Confirm the chain is running that same module:

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"contract.attestor-overcover.testnet"}}' \
| python3 -c 'import sys,json,base64,hashlib; d=json.load(sys.stdin)["result"]; c=base64.b64decode(d["code_base64"]); print(len(c),"bytes",hashlib.sha256(c).hexdigest())'
```

Expected: `344857 bytes 1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e`.
The RPC `code_hash` is `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` (a different encoding of the
same module).

## 2. The pool is solvent right now

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.attestor-overcover.testnet","method_name":"get_pool","args_base64":"e30="}}'
```

`get_pool` returns `capital`, `reserved`, `available`, `solvent` and the reconciliation counters.
`reserved ≤ capital` and `solvent: true`. `reconcile` returns `true`:

```bash
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.attestor-overcover.testnet","method_name":"reconcile","args_base64":"e30="}}'
```

## 3. Every demo transaction is real

`demo-log.json` holds 18 hashes covering the whole cycle: publish, deposit, buy cover, report,
settle (paid and no-pay), and both dispute outcomes. Each resolves via RPC. (The `tx` method
requires a `sender_account_id`; the node rejects an empty value with HTTP 400 but does not check it
against the transaction, so any valid account id works. Use an **archival** endpoint: the
non-archival ones keep only a recent tx cache and return `NOT_OBSERVED` for these weeks-old txs.)

```bash
python3 - <<'PY'
import json, urllib.request
ENDPOINTS = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"]
for e in json.load(open("demo-log.json")):
    for url in ENDPOINTS:
        try:
            req = urllib.request.Request(url,
                data=json.dumps({"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":e["hash"],"sender_account_id":"contract.attestor-overcover.testnet","wait_until":"FINAL"}}).encode(),
                headers={"Content-Type":"application/json"})
            r = json.load(urllib.request.urlopen(req))
        except Exception as ex:          # 429 rate limit, or NOT_OBSERVED on a non-archival node
            last = ex; continue
        ok = "result" in r and "Failure" not in (r["result"].get("status") or {})
        print(("OK  " if ok else "FAIL"), e["label"]); break
    else:
        print("FAIL", e["label"], "—", last)
PY
```

Or run the whole verification in one command — `npm run verify:proof` re-derives every headline
claim (bytecode, solvency, all 18 hashes, the agent's purchases, the settled outcomes) and exits
non-zero on any mismatch.

The same hashes are linked from the console's Proof section to `testnet.nearblocks.io`.

## 4. The tests

```bash
npm ci --ignore-scripts
npm run test:model      # 74 attacks, 74 defended, 0 exploitable  (reference model)
npm run test:contract   # 88 Rust unit tests (incl. a stateful randomised solvency fuzzer)
npm run test:console    # 116 regression + live-RPC tests (page regressions + end-to-end wallet journey)
npm run test:agent      # 53 limits + API + u128 precision + funds guard + OpenAPI + idempotency tests
npm run test:agent-eval # 33 product-feed schema/premium + agent boundary + independent-client integration
npm run test:factory    # 11 discovery-agent tests (deterministic rule, evidence hash, forecast labelling)
npm run test:onchain    # 17 adversarial tests against the LIVE contract
# v3 lifecycle on a local neard node:
#   npm run verify:sandbox                # 28/28 (compiled v3 wasm, real neard)
#   npm run verify:upgrade-preservation   # in-place upgrade of the live v1 bytecode preserves state
#   npm run verify:controlled-v3:plan     # the controlled v3 testnet deployment plan (sends nothing)
#   npm run verify:controlled-v3          # 40/40 — the controlled v3 deploy on NEAR TESTNET (needs a funded root)
#   npm run verify:controlled-v3:sandbox  # 39/39 — controlled v3 deploy + SEC-1 closure on a real neard
#   npm run verify:factory                # 22/22 — permissionless factory on the COMPILED wasm + a real neard
```

`test:onchain` sends real attacks to the deployed contract and asserts each is **refused with the
expected reason** — capacity, premium, lead time, signature, replay, staleness, bond, challenge
window, ownership, provider share. It needs a fresh `npm run deploy` first, because it relies on a
clean state and a 60 s challenge window.

`test:agent-eval` validates the shipped `ui/products.json` against its schema offline (money as
exact yoctoNEAR strings, one real offering, the premium rule `ceil(payout·bp/10000)`), exercises the
agent's spending-policy boundary cases, and — in `tests/agent-integration.test.mjs` — drives a client
that knows **only** the published catalogue, the published schema and the documented HTTP API
(`agent/sdk.mjs`) through discover → quote → decide → buy (dry run) → over-limit refusal → replay, so
the integration is proven usable by an outside consumer, not merely present. The feed is regenerated
with `npm run products:feed` from the live contract, never hand-written.

`tests/wallet-journey.test.mjs` runs the **real** inline `<script>` from `ui/index.html` in a `vm`
with a DOM shim and a mock wallet, against a frozen contract snapshot
(`tests/fixtures/contract-snapshot.json`, regenerated with `npm run fixture:capture`). It proves the
page builds exactly one `buy_cover`, attaches the contract's own premium as the deposit, passes a
valid beneficiary through, refuses an invalid one before signing, clamps the observation date to the
future, and classifies success/failure/no-hash/rejection honestly. Nothing is broadcast; the wallet
is a stub. A real extension approval is still the one human acceptance step.

## 5. The console is accessible and honest

`tests/console.test.js` asserts the page's honesty rules: distinct loading/live/stale/failed states,
that the catch path cannot claim "live", that every embedded transaction hash is present in
`demo-log.json` (so no fabricated evidence), and that the muted and accent tokens clear 4.5:1
contrast.

Independently, `npm run axe` runs `axe-core` (WCAG 2.2 AA) and reports **0 violations** at
320 / 360 / 390 / 768 / 1024 / 1280 / 1440 px for the page **and** the wallet dialog, with **no
horizontal overflow**, and the failure and stale states were exercised in a real browser (reads
blocked at the network layer).

## 6. The product rules hold

`research/model/` is an executable BigInt model of the accounting rules and a 74-attack suite that
runs **before** the contract. `npm run test:model` prints `74 attacks, 74 defended, 0 exploitable`.
It is the reason the invariant and the reconciliation identity were trusted enough to implement.

## 7. The public console needs no local agent

`npm run verify:connectivity` boots the **real** agent service in dry-run with a throwaway key,
serves the **real** `ui/` files, drives a real Chromium, and blocks every request to the operator's
localhost. It reports **13/13** checks: the page ships no localhost default; the public page loads
with no local agent reachable and no console errors; the read-only evaluation works and its verdict
equals the shared engine's verdict on the live contract quote (and the premium it shows is the
contract's own premium); an unreachable service yields a safe, human message (never `Failed to
fetch`); invalid and oversized bodies are rejected (`413` / `400`); the spending limits are enforced
with reasons before any network call; no public path can call an owner-only method; `buy_cover` is
the only signing capability; a visitor cannot buy without a wallet authorization; and local
development still works. Run it against production with
`LIVE_URL=https://overcover.vercel.app/ npm run verify:connectivity`.

## What is not verified

- **No professional audit.** The contract has not been audited.
- **No mainnet deployment.** Testnet only; not for real funds.
- **Single attestor on the deployed v1 contract.** The oracle on the live address is not
  decentralised; the dispute path mitigates but does not remove that. The **v3** source
  replaces it with a 3-of-5 operator quorum and independent resolvers, proven on a fresh deployment
  by `npm run verify:controlled-v3` (**40/40** against the real testnet contract
  `contract.ovc-v3-ctl-2f6c4c.testnet`; 39/39 in sandbox) — but v3 is not on the *legacy* live address
  (see below).
- **The v3 contract is not deployed to the live address, and the legacy key is unrecoverable.** The
  live `contract.attestor-overcover.testnet` runs **v1**, whose `migrate()` is unauthenticated
  (**SEC-1**). Closing it on that address needs the account's FullAccess private key
  (`ed25519:CwZBmKyV…`), which is **not recoverable from the chain** and not held in this
  environment; the exhaustive search and the on-chain creation trail are recorded in
  [`AUTHORITY_RECOVERY.md`](AUTHORITY_RECOVERY.md). Two supported routes remain: the operator runs
  the state-preserving in-place upgrade (`node driver/upgrade.js`), or the controlled v3 deployment
  (`node proof/controlled-v3-deploy.mjs`) stands up a fresh, SEC-1-closed contract. **Do not claim the
  live address is hardened until one of those has run.**
- **The controlled v3 testnet deployment is complete (2026-11-12).** `npm run verify:controlled-v3`
  passed **40/40** against the **real deployed** contract `contract.ovc-v3-ctl-2f6c4c.testnet` on NEAR
  testnet: deploy + init, the 3-of-5 operator and resolver quorums, the settled-and-paid policy, the
  permissionless factory (a **non-owner** `propose_product` activation and a `buy_cover` on the
  resulting product, policy 2), the adversarial refusals, pool solvency, `reconcile() == true`,
  `check_invariant() == true`, and SEC-1 closure on the deployed bytes. The deployed module is
  byte-identical to the source rebuild (sha256 `a97034e6…`, 500,023 bytes; `code_hash`
  `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL`). Evidence: `proof/controlled-v3-deploy.json` and
  the public, independently re-derivable `proof/controlled-v3-onchain-evidence.json`. The identical
  harness also passes **39/39** on a local `neard` node (`npm run verify:controlled-v3:sandbox`). The
  root that funded it is an operator-supplied account (`keys/controlled-v3-root.json`); see
  [`FACTORY_TESTNET_PREFLIGHT.md`](FACTORY_TESTNET_PREFLIGHT.md).
- **`npm run test:onchain` is not run in this environment.** The 17 live adversarial tests need the
  gitignored operator identities (`keys/identities.json`, `keys/state.json`) and a fresh deploy, so
  they cannot run without a funded operator key. The suite exists and fails cleanly with an
  actionable message; it is **not** part of `npm test`. The same attacks are executed against the
  reference model (`npm run test:model`, 74 attacks, 0 exploitable), which is the offline gate that
  runs everywhere. The list of attacks covered: economics (capacity, premium injection, reserve vs
  withdraw, correlated claims, lead time, early resolve), oracle (wrong signer, stale, out-of-range,
  overwrite, future date, early resolve, bonded dispute both ways), mechanics (double resolve,
  rounding, min/max payout, provider auth, random-operation fuzz) and agents (city rotation, over-
  withdrawal, re-registration, sybil providers, self-attestation).
- **A live HERE/Meteor extension approval is not captured.** See [`JUDGE_DEMO.md`](JUDGE_DEMO.md) §3.
