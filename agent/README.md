# The Overcover agent

An autonomous agent that buys parametric cover on its own, under hard limits
that a human sets in advance. It is the second half of Overcover: a person buys
cover through their own wallet; an agent buys cover through this service.

## What the agent is

A normal NEAR account with its own ed25519 key. It can do exactly two things
on-chain:

1. **Read** the contract (quotes, products, policies).
2. **Call `buy_cover`** with a deposit equal to the contract's own `quote`.

It cannot call any owner-only method. It holds no owner key, and the contract
would reject it if it tried. Its authority is bounded by the contract, not by
this code.

## Safety model

- **Key in the environment only.** `OVERCOVER_AGENT_SECRET_KEY` is read at
  start-up and never written to disk, logged, or returned by any endpoint.
- **Policy first, network second.** Every buy passes through
  [`limits.mjs`](./limits.mjs). A refusal returns before any RPC call, so **no
  funds move on a denied proposal** (see `tests/agent-limits.test.mjs` and
  `tests/agent-api.test.mjs`).
- **Kill switch.** `POST /api/v1/agent/control {"enabled":false}` stops all
  buying immediately; the state is also persisted to the audit log.
- **Idempotency.** A retried buy with the same `Idempotency-Key` returns the
  original result instead of buying twice.
- **Audit log.** Every decision, refusal, dry run and buy is appended to
  `agent/audit.log.jsonl` (no key material in it).
- **Strict input boundary.** Bodies are size-capped (8 KB), must be JSON, and
  must contain only known fields; anything else is a 4xx before execution.
- **No anonymous public signer.** The service binds to `127.0.0.1` by default.
  Running it on a public host with a funded key would let any visitor spend that
  key's balance, so the honest configuration is local, or public behind the
  operator's own authentication.

## Spending limits

Set with `OVERCOVER_AGENT_LIMITS` (JSON). Defaults are deliberately small.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `maxPremiumPerPolicy` | `0.05 NEAR` | ceiling on one policy's premium |
| `maxPayoutPerPolicy` | `1 NEAR` | ceiling on one policy's payout |
| `dailyPremiumBudget` | `0.2 NEAR` | rolling 24h premium budget |
| `dailyPolicyLimit` | `5` | rolling 24h policy count |
| `cooldownSec` | `60` | minimum gap between buys |
| `allowedProducts` | `[]` | empty = any product the contract exposes |
| `allowedCities` | `[]` | empty = any city |
| `minLeadSec` | `0` | extra lead time on top of the product's |

## Running it

```bash
export OVERCOVER_AGENT_ACCOUNT=agent.yourname.testnet
export OVERCOVER_AGENT_SECRET_KEY=ed25519:...        # never commit this
export OVERCOVER_AGENT_DRY_RUN=1                     # decide, never send
node agent/server.mjs
```

Then, from another shell:

```bash
curl -s localhost:8787/api/v1/health
curl -s localhost:8787/api/v1/agent
curl -s localhost:8787/api/v1/agent/quote -H 'content-type: application/json' \
  -d '{"productId":"rain-lagos","payoutYocto":"1000000000000000000000000"}'
```

Or with the SDK:

```js
import { AgentClient } from "./agent/sdk.mjs";
const c = new AgentClient({ baseUrl: "http://127.0.0.1:8787" });
console.log(await c.decide({ productId: "rain-lagos", payoutYocto: "1000000000000000000000000", obsDateSec: 1794000000 }));
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | liveness + identity (no secrets) |
| `GET` | `/api/v1/agent` | account, limits, balance, spend history |
| `GET` | `/api/v1/agent/audit` | last 50 audit entries |
| `POST` | `/api/v1/agent/quote` | contract quote for a product + payout |
| `POST` | `/api/v1/agent/decide` | policy verdict **without** buying |
| `POST` | `/api/v1/agent/buy` | policy-checked purchase |
| `POST` | `/api/v1/agent/control` | enable / disable the agent |

## What is *not* claimed

- Spend history is per-process. Running several copies of the service does not
  share the rolling budget. A multi-instance deployment must centralise it.
- Rate limiting here is per-process and is not a global guarantee.
- The agent's on-chain authority is whatever its key can do; the limits in this
  service are a *policy*, not a contract rule. Point the agent at a dedicated,
  low-balance account so a bug cannot spend more than that account holds.
