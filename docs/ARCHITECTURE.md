# Architecture

Overcover is four small parts. There is no backend and no database.

```
                         Open-Meteo (keyless, free)
                                │  current + hourly cross-check
                                ▼
     operator key ──▶ driver/operator.js ──▶ ed25519 sign ──▶ report_observation(...)
                                │                                  │
                                ▼                                  ▼
     business ── buy_cover ──▶ ┌──────────────────────────────────────────────┐
     LP ──────── deposit ─────▶ │  Overcover contract (Rust, near-sdk 5)        │
     challenger ─ challenge ──▶ │  products · policies · pool · observations    │
     owner ───── resolve ─────▶ │  invariant: reserved <= capital               │
                                └──────────────────────────────────────────────┘
                                                   ▲
                                                   │  call_function views over public RPC
                                                   │
                                        ui/index.html (static console, no keys)
```

## Components

### 1. Contract — `contract/` (Rust, `near-sdk` 5)

The financial authority and the only source of truth. It holds capital, publishes immutable
products, issues policies while reserving the payout, verifies signed observations, runs bonded
disputes, settles policies exactly once, and enforces `reserved ≤ capital` after every mutation.
Interface and state model: [`CONTRACT.md`](CONTRACT.md).

### 2. Driver — `driver/` (Node, `near-api-js`)

Operational scripts, not part of the product's runtime:

| File | Role |
| --- | --- |
| `keys.js` | Creates the testnet identity graph (owner, attestor, providers, business, challenger) via faucet-funded subaccounts. |
| `deploy.js` | Deploys the wasm and resets to a clean state (60 s challenge window for a live demo). |
| `operator.js` | One independent oracle operator node: reads a public index for a metric/city/date and signs the canonical reading with its own ed25519 key. The contract finalises only when a quorum of distinct operators agree within tolerance. |
| `adapters.js` | Turns a `(metric, city, date)` into a tenths-scaled reading from a keyless source (Open-Meteo). |
| `attestor.js` | Signs the exact message the contract verifies. |
| `actions.js` | High-level calls (`deposit`, `buyCover`, `report`, `challenge`, `resolve`, …). |
| `demo.js` | Runs the full economic cycle and writes `demo-log.json`. |
| `near.js` | Shared RPC/connection helpers. |

### 3. Console — `ui/index.html`

A single static file with **no dependencies and no build step**. It makes direct
`call_function` view calls to public NEAR testnet RPC endpoints (three, with failover) and renders
the pool, the products as coverage cards, the policies, the signed observations and a live quote.
The hero artwork is inline SVG, so there is no remote image dependency.

It holds **no wallet, no key, and no server**. It is read-only, and it says so on the page. It
distinguishes four states honestly — loading, live, stale, failed — and never presents a failed
read as live. Published to GitHub Pages by `.github/workflows/pages.yml`.

Its **agent panel** has a public, read-only mode and an opt-in local mode. The public mode loads the
same spending-policy engine the agent service runs (`agent/limits.mjs`, bundled to
`ui/vendor/policy.js` by `npm run build:wallet`) and evaluates a purchase in the browser against the
live contract quote — no key, nothing signed. The page never defaults to `localhost` and never
contacts a local service unless the visitor chooses local mode, so the public site has no dependency
on the operator's machine.

### 4. Reference model — `research/model/`

An executable BigInt model of the accounting rules (`sim/engine.mjs`) driven by a
**74-attack suite** (`research/model/attacks.mjs`) that runs before the contract. It is a design
instrument: it proved the accounting identities and the solvency invariant before any Rust was
written. Run it with `npm run test:model`; the full lifecycle simulation is `npm run simulate:full`.

## Data flow — a full cycle

1. **Owner** calls `add_product` — an immutable risk definition is published.
2. **Providers** call `deposit` — capital enters the pool.
3. **Business** calls `quote`, then `buy_cover` with exactly the quoted premium. The payout is
   reserved immediately; capacity and availability are enforced.
4. **Operators** each read a public index and sign `(city, date, value, reported_at, nonce,
   contract_id)` with their own key, then call `report_observation`. The contract verifies each
   signature, freshness, range and replay nonce, and finalises only once a **quorum** of distinct
   operators agree within tolerance.
5. **Challenger** (optionally) calls `challenge_observation` with a bond. The reading is frozen.
6. **Owner** calls `resolve_dispute(uphold)`. Upheld → bond forfeited to the pool. Rejected →
   reading nullified, bond returned.
7. **Anyone** calls `resolve(policy_id)`. The beneficiary is paid iff the validated reading meets
   the threshold; the reservation is released either way; the policy settles once.
8. **Anyone** reads `get_pool` / `reconcile` / `check_invariant` and reproduces every figure.

## Trust boundaries

| Boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| NEAR testnet | Consensus and finality | — |
| Contract | All accounting, all rule enforcement | External truth |
| Attestor key | Reporting an index reading | Anything else; it is bonded and challengeable |
| Owner | Publishing products, resolving disputes | Touching pool funds; it has no withdrawal path |
| Open-Meteo | The underlying weather value | It is cross-checked and signed, and disputes are possible |
| Public RPC endpoints | Serving reads | Correctness — the console reads three, and a test reads the chain directly |

The only value the system imports from outside the chain is the index reading, and that path is
signature-verified, freshness-checked, nonce-protected and **challengeable with a bond**.

## Why this shape

- **No database.** All state is contract state. There is nothing to keep in sync, and nothing a
  judge has to trust the team to operate.
- **No backend.** The console is static; the chain is the API.
- **Small surface.** One contract, one static page, a handful of driver scripts — small enough for
  a solo builder to hold in their head and for a reviewer to audit in an afternoon.
