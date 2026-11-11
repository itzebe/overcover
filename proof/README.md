# Independent proof

These scripts let anyone re-derive Overcover's central claims from public data, without trusting
the console, and without a key of their own. They read only the NEAR testnet JSON-RPC and the
committed artefacts; none of them writes on-chain.

| Command | What it proves |
| --- | --- |
| `npm run verify:proof` | The deployed module is exactly this source; the pool is solvent and reconciles; all 18 `demo-log.json` transactions are real and successful; the agent's purchases are real `buy_cover` calls (each tied to its on-chain policy via the committed `proof/agent-purchases.json`); the settled policies paid what the console says. Exits non-zero on any mismatch. Runs on a clean clone — it needs no local key and no gitignored file. |
| `npm run verify:agent` | The agent's spend-authorization engine refuses an over-limit buy and permits an in-limit one, against the **live** product definition. When a local agent key exists, the shipped `createAgent`/`decide` path is run too and must agree. |
| `npm run verify:connectivity` | The public console works with **no local agent**: it boots the real agent service in dry-run, drives the real page in a browser with all localhost requests blocked, and checks the security boundary (no localhost default, read-only verdict == shared engine on the live quote, invalid bodies rejected, limits enforced, no owner-only method, `buy_cover` the only signing path). Set `LIVE_URL` to run it against production. |
| `npm run verify:upgrade` | The **compiled** v2 wasm closes SEC-1 on a real local `neard` node: a third-party `migrate()` is refused, the owner and state are untouched, a repeat is still refused, and the contract's own self-call `migrate()` (the redeploy path) is accepted. 8/8. |
| `npm run verify:testnet-deploy` | A **real, isolated v2 deployment on NEAR testnet** (faucet-funded): deploys the compiled wasm, initialises it, publishes a product, funds the pool, buys one policy (real `buy_cover`), and then shows a third-party `migrate()` is refused on the live chain. Writes contract id, wasm sha256 and tx hashes to `proof/testnet-v2-deploy.json`. Skips cleanly if the faucet is rate-limited (`REQUIRE_TESTNET=1` to force). |
| `npm run verify:live` | The **live production URL** (`https://overcover.vercel.app/`) loads at 320/390/768/1280/1440 px with zero console errors and zero horizontal overflow. Screenshots land in `proof/shots/`. |

Evidence written by the scripts:

- `proof/verification.json` — the full result of `verify:proof`.
- `proof/agent-policy-evidence.json` — the blocked and permitted decisions plus the real on-chain agent purchases.
- `proof/connectivity.json` — the 12 connectivity + boundary checks and the URL they ran against.
- `proof/shots/live-*.png` — production screenshots per width.

## The shared live contract is read-only here

Every command above is a **read**. Nothing in this directory calls `reset`, `seed`, `deposit`,
`add_product`, `buy_cover`, `report_observation`, `challenge_observation`, `resolve`,
`resolve_dispute`, `set_paused`, `withdraw` or any other state-changing method against
`contract.attestor-overcover.testnet`.

## Isolated fresh deployment

A **fresh, isolated deployment** of the v2 contract is reproducible from a clean clone with network
access and a working testnet faucet:

```bash
npm ci --ignore-scripts
npm run verify:testnet-deploy   # creates a throwaway identity graph, deploys, proves the guard
```

`proof/testnet-v2-deploy.mjs` does exactly that on real testnet: it funds a throwaway root from the
faucet, creates the identity graph, deploys the **compiled** wasm, initialises and configures it,
funds the pool, buys one real policy, and then shows a third-party `migrate()` is refused on the live
chain. The contract id, wasm sha256 and every transaction hash are written to
`proof/testnet-v2-deploy.json`. It is not a unit test — it is a real deployment you can inspect on a
block explorer.

The shared **live** contract `contract.attestor-overcover.testnet` is a separate, earlier deployment
(v1). Closing SEC-1 **on that address** is not something a read-only proof can do: it needs the
contract's full-access key, held only by the operator (`docs/DEPLOY_RUNBOOK.md`, `node
driver/upgrade.js`). The bytecode comparison in `verify:proof` is what ties the running live contract
back to its exact source meanwhile.

If the faucet is rate-limited, the script prints `SKIP` and exits 0; set `REQUIRE_TESTNET=1` to make a
missing faucet a failure.

```bash
npm ci --ignore-scripts
npm run keys        # create the demo identities
npm run deploy      # publish the contract + products (needs the identities funded)
npm run demo        # the full cycle; rewrites demo-log.json
```
