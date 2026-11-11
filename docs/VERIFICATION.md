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
npm run test:console    # 66 regression + live-RPC tests
npm run test:onchain    # 17 adversarial tests against the LIVE contract
```

`test:onchain` sends real attacks to the deployed contract and asserts each is **refused with the
expected reason** — capacity, premium, lead time, signature, replay, staleness, bond, challenge
window, ownership, provider share. It needs a fresh `npm run deploy` first, because it relies on a
clean state and a 60 s challenge window.

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

## What is not verified

- **No professional audit.** The contract has not been audited.
- **No mainnet deployment.** Testnet only; not for real funds.
- **Single attestor.** The oracle is not decentralised; the dispute path mitigates but does not
  remove that. See [`SECURITY.md`](SECURITY.md).
