# Agent integration guide

How to give a software agent the ability to buy Overcover cover **without giving
it a blank cheque**. Everything here is implemented in this repository; nothing is
aspirational. Run `npm run test:agent` and `npm run test:agent-eval` to check the
pieces yourself.

## The model in one paragraph

An agent is an ordinary NEAR account that holds exactly one power: it can call
`buy_cover` on the Overcover contract, for an amount its own **spending policy**
allows. The policy is pure logic (`agent/limits.mjs`) that returns allow/deny with
explicit reasons. A refusal happens **before** any network call, so a denied
purchase cannot move funds. The private key stays on the server; the browser
console holds no key and signs nothing.

## 1. Discover what is for sale

Read the machine-readable catalogue, generated from the live contract:

```
GET https://overcover.vercel.app/products.json
GET https://overcover.vercel.app/products.schema.json
```

Only buy a product whose `sellable` is `true` (listed in `offerings`). Every other
entry is a demo fixture or a definition that cannot trigger; the feed marks them
`"not-offered"` so an agent does not buy one by accident.

**Money rule.** All money fields are exact decimal integer strings in yoctoNEAR
(`1 NEAR = 10^24 yoctoNEAR`). Parse them with a big-integer type. A plain
`JSON.parse` silently rounds values above 2^53 — this repository hit that bug and
fixed it in `agent/json.mjs` (`parseBigIntJson`); use it.

The premium the contract will charge is:

```
premium_yocto = ceil(payout_yocto * premium_bp / 10000)
```

Never compute this yourself for the deposit — ask the contract with `quote` and
attach exactly that.

## 2. Run the agent service

The service owns the key and enforces the policy. Start it:

```bash
OVERCOVER_AGENT_ACCOUNT=oc-agent-xxxx.testnet \
OVERCOVER_AGENT_SECRET_KEY=ed25519:... \
OVERCOVER_AGENT_LIMITS='{"maxPremiumPerPolicy":"50000000000000000000000","dailyPremiumBudget":"200000000000000000000000","dailyPolicyLimit":5,"cooldownSec":60}' \
node agent/server.mjs
```

It binds `127.0.0.1:8787` by default. It is **dry-run by default**
(`OVERCOVER_AGENT_DRY_RUN=1`): it evaluates and audits but sends nothing. Set it to
`0` only when you intend real (testnet) purchases.

Environment variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `OVERCOVER_AGENT_ACCOUNT` | the agent's NEAR account id | required |
| `OVERCOVER_AGENT_SECRET_KEY` | the agent's `ed25519:…` key | required |
| `OVERCOVER_AGENT_CONTRACT` | the Overcover contract | `contract.ovc-v3-ctl-2f6c4c.testnet` |
| `OVERCOVER_AGENT_DRY_RUN` | `1` = evaluate only | `1` |
| `OVERCOVER_AGENT_LIMITS` | JSON spending policy (see below) | engine defaults |
| `OVERCOVER_AGENT_AUDIT` | path to the append-only audit log | `agent/audit.log.jsonl` |
| `OVERCOVER_AGENT_ORIGINS` | allowed CORS origins | the public console + localhost |

## 3. The spending policy (the whole security model)

`normalizeLimits` validates the config and refuses anything malformed, so a typo
can never silently widen authority. Every limit is a **hard ceiling**; there is no
override and no `force` flag.

| Limit | Meaning |
| --- | --- |
| `enabled` | the kill switch; `false` denies everything |
| `maxPremiumPerPolicy` | ceiling on a single policy's premium (yocto) |
| `maxPayoutPerPolicy` | ceiling on a single policy's payout (yocto) |
| `dailyPremiumBudget` | rolling-24h premium ceiling (yocto) |
| `dailyPolicyLimit` | rolling-24h policy-count ceiling |
| `cooldownSec` | minimum gap between purchases |
| `allowedProducts` | allow-list; empty = any product |
| `allowedCities` | allow-list; empty = any city |
| `minLeadSec` | extra lead time the agent demands on top of the product's |

A live (non-dry-run) buy also passes a **funds preflight** before it signs: the
agent reads its own account balance and refuses if it cannot cover the premium
**plus a gas buffer** (`GAS_BUFFER_YOCTO`, 0.05 NEAR). An unfunded agent therefore
refuses with `403` and a `balance … below premium + gas buffer` reason rather than
building a transaction the network rejects. The check is pure
(`fundsShortfall` in `agent/limits.mjs`) and is covered by tests.

## 4. Decide, then buy

```js
import { AgentClient } from "./agent/sdk.mjs";
const c = new AgentClient({ baseUrl: "http://127.0.0.1:8787" });

// 1. ask the policy — this never touches the network
const verdict = await c.decide({ productId: "rain-lagos", payoutYocto: "1000000000000000000000000", obsDateSec: 1794000000 });
// verdict: { allow: true|false, reasons: [...], premiumYocto }

// 2. only buy if allowed; the idempotency key makes a retry safe
const res = await c.buy({ productId: "rain-lagos", payoutYocto: "1000000000000000000000000", obsDateSec: 1794000000, idempotencyKey: "order-42" });
// res: { hash, premiumYocto, explorer }
```

A refused `buy` throws `AgentClientError` with `status: 403`, `code: "denied"` and
the `reasons` array — **and no transaction was sent**. Reuse the same
`idempotencyKey` and the service returns the original result instead of buying
again. This holds even when two requests with the same key arrive at the same
instant: the service reserves the key before it does any work, so the second
request waits for the first and replays its result (`tests/agent-api.test.mjs`,
"concurrent buys with the same idempotency key execute exactly once"). Buys are
also serialized inside the agent, so overlapping requests with *different* keys
cannot both pass the same spending check and jointly exceed a daily limit.

## 5. HTTP API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | — | `{ ok, service, accountId, contractId, dryRun, enabled }` |
| GET | `/api/v1/agent` | — | status, limits, history, live balance |
| GET | `/api/v1/agent/audit` | — | the last 50 audit entries |
| POST | `/api/v1/agent/quote` | `{ productId, payoutYocto }` | `{ premiumYocto }` |
| POST | `/api/v1/agent/decide` | `{ productId, payoutYocto, obsDateSec }` | `{ allow, reasons, premiumYocto }` |
| POST | `/api/v1/agent/buy` | `{ productId, payoutYocto, obsDateSec, beneficiary?, idempotencyKey? }` | `{ hash, premiumYocto, explorer }` |
| POST | `/api/v1/agent/control` | `{ enabled }` | `{ enabled }` (the kill switch) |

Errors: `403` policy denial (with `reasons`), `400` bad request, `413` oversized
body, `502` chain error. The service never returns `ok:true` for a purchase that
did not settle.

The same interface is described as an OpenAPI 3.1 document at
[`agent/openapi.json`](../agent/openapi.json); `tests/agent-openapi.test.mjs`
fails the build if the spec and the running routes ever disagree.

## 6. Verify a purchase independently

The audit log is append-only JSONL (`kind`: `buy`, `denied`, `refused`, `error`,
`dry_run`, `control`). Every settled `buy` carries a real transaction hash. Confirm
it yourself against the chain:

```
https://testnet.nearblocks.io/txns/<hash>
```

and read the resulting policy with a keyless contract view:

```bash
near view contract.ovc-v3-ctl-2f6c4c.testnet get_policy '{"id": <policy_id>}'
```

`npm run verify:proof` re-derives the headline claims (bytecode == source, pool
solvent, every demo transaction real) without trusting the console.

## 7. What the agent cannot do

- It cannot call any method other than `buy_cover` on the contract.
- It cannot spend beyond the policy's ceilings; a refusal is pre-network.
- It cannot be tricked into a second purchase by a retried request (idempotency).
- It cannot move pool capital; `deposit`/`withdraw`/`resolve` are owner- or
  provider-only and the agent has no such key.
- Its key never leaves the server; the browser console is read-only.

## Honest limitations

- The service binds localhost by default and is **not hosted publicly**. The public
  console evaluates with the *same* engine in the browser, read-only, and says so.
- Testnet only, unaudited.
- The oracle is a single bonded attestor in v1 (a quorum in the unshipped v2).
