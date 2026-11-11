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
against the transaction, so any valid account id works.)

```bash
python3 - <<'PY'
import json, urllib.request
for e in json.load(open("demo-log.json")):
    req = urllib.request.Request("https://test.rpc.fastnear.com",
        data=json.dumps({"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":e["hash"],"sender_account_id":"contract.attestor-overcover.testnet","wait_until":"FINAL"}}).encode(),
        headers={"Content-Type":"application/json"})
    r = json.load(urllib.request.urlopen(req))
    ok = "result" in r and "Failure" not in (r["result"].get("status") or {})
    print(("OK  " if ok else "FAIL"), e["label"])
PY
```

Or run the whole verification in one command — `npm run verify:proof` re-derives every headline
claim (bytecode, solvency, all 18 hashes, the agent's purchases, the settled outcomes) and exits
non-zero on any mismatch.

The same hashes are linked from the console's Proof section to `testnet.nearblocks.io`.

## 4. The tests

```bash
npm ci --ignore-scripts
npm run test:model      # 31 attacks, 31 defended, 0 exploitable  (reference model)
npm run test:contract   # 21 Rust unit tests
npm run test:console    # 78 regression + live-RPC tests
npm run test:agent      # 36 limits + API + u128 precision + idempotency tests
npm run test:agent-eval # 22 product-feed schema/premium + agent boundary + live read
npm run test:onchain    # 17 adversarial tests against the LIVE contract
```

`test:onchain` sends real attacks to the deployed contract and asserts each is **refused with the
expected reason** — capacity, premium, lead time, signature, replay, staleness, bond, challenge
window, ownership, provider share. It needs a fresh `npm run deploy` first, because it relies on a
clean state and a 60 s challenge window.

`test:agent-eval` validates the shipped `ui/products.json` against its schema offline (money as
exact yoctoNEAR strings, one real offering, the premium rule `ceil(payout·bp/10000)`), exercises the
agent's spending-policy boundary cases, and re-reads the live product from the contract. The feed is
regenerated with `npm run products:feed` from the live contract, never hand-written.

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

`research/model/` is an executable BigInt model of the accounting rules and a 31-attack suite that
runs **before** the contract. `npm run test:model` prints `31 attacks, 31 defended, 0 exploitable`.
It is the reason the invariant and the reconciliation identity were trusted enough to implement.

## 7. The public console needs no local agent

`npm run verify:connectivity` boots the **real** agent service in dry-run with a throwaway key,
serves the **real** `ui/` files, drives a real Chromium, and blocks every request to the operator's
localhost. It reports **12/12** checks: the page ships no localhost default; the public page loads
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
- **Single attestor.** The oracle is not decentralised; the dispute path mitigates but does not
  remove that. See [`SECURITY.md`](SECURITY.md).
- **`npm run test:onchain` is not run in this environment.** The 17 live adversarial tests need the
  gitignored operator identities (`keys/identities.json`, `keys/state.json`) and a fresh deploy, so
  they cannot run without a funded operator key. The suite exists and fails cleanly with an
  actionable message; it is **not** part of `npm test`. The same attacks are executed against the
  reference model (`npm run test:model`, 31 attacks, 0 exploitable), which is the offline gate that
  runs everywhere. The list of attacks covered: economics (capacity, premium injection, reserve vs
  withdraw, correlated claims, lead time, early resolve), oracle (wrong signer, stale, out-of-range,
  overwrite, future date, early resolve, bonded dispute both ways), mechanics (double resolve,
  rounding, min/max payout, provider auth, random-operation fuzz) and agents (city rotation, over-
  withdrawal, re-registration, sybil providers, self-attestation).
- **A live HERE/Meteor extension approval is not captured.** See [`JUDGE_DEMO.md`](JUDGE_DEMO.md) §3.
