# Independent proof

These scripts let anyone re-derive Overcover's central claims from public data, without trusting
the console, and without a key of their own. They read only the NEAR testnet JSON-RPC and the
committed artefacts; none of them writes on-chain.

| Command | What it proves |
| --- | --- |
| `npm run verify:proof` | The deployed module is exactly this source; the pool is solvent and reconciles; all 18 `demo-log.json` transactions are real and successful; the agent's purchases are real `buy_cover` calls (each tied to its on-chain policy via the committed `proof/agent-purchases.json`); the settled policies paid what the console says. Exits non-zero on any mismatch. Runs on a clean clone — it needs no local key and no gitignored file. |
| `npm run verify:agent` | The agent's spend-authorization engine refuses an over-limit buy and permits an in-limit one, against the **live** product definition. When a local agent key exists, the shipped `createAgent`/`decide` path is run too and must agree. |
| `npm run verify:connectivity` | The public console works with **no local agent**: it boots the real agent service in dry-run, drives the real page in a browser with all localhost requests blocked, and checks the security boundary (no localhost default, read-only verdict == shared engine on the live quote, invalid bodies rejected, limits enforced, no owner-only method, `buy_cover` the only signing path). Set `LIVE_URL` to run it against production. |
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

## Isolated fresh deployment — blocked, and why

The strongest possible proof would be a **fresh, isolated deployment** of the contract that anyone
can reproduce end-to-end without touching the shared town. That is not possible from this
environment right now, for a funding reason that is worth stating plainly:

- Deploying the contract and running the full cycle needs roughly **3.5–3.7 NEAR** of testnet
  storage and gas. Testnet accounts must be created and funded through the NEAR testnet faucet.
- The faucet is rate-limited (`429 Rate limit exceeded, retry in 8 hours`) and the only funded
  account available holds about **0.84 NEAR** — far below what a fresh deployment costs.
- No other free faucet accepted the request (`helper.testnet.near.org` 429; the historical
  `testnet-faucet.near.org` no longer resolves).

So the reproducible proof here rests on the **already-deployed** contract, whose entire history is
on-chain and independently checkable — which is the point. The bytecode comparison in
`verify:proof` is what ties the running contract back to this exact source.

If you have a funded testnet account, you can run the isolated cycle yourself from a clean clone:

```bash
npm ci --ignore-scripts
npm run keys        # create the demo identities
npm run deploy      # publish the contract + products (needs the identities funded)
npm run demo        # the full cycle; rewrites demo-log.json
```
