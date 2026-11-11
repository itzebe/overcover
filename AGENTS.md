# AGENTS.md — working in the Overcover repository

Orientation for any agent or contributor. Read this first, then the document linked for your task.

## What this repository is

**Overcover** is a parametric risk mutual on NEAR: an on-chain pool that writes fully-collateralised
cover against objective public indices and settles it autonomously. It is a competition submission
for NEAR Hackathon 2026 (tracks: Business · Swarms · DeFi) and is deployed to NEAR **testnet**.

- Live console: https://itzebe.github.io/overcover/
- Live contract: `contract.attestor-overcover.testnet`

## Layout

| Path | What it is |
| --- | --- |
| `contract/` | The Rust smart contract (`near-sdk` 5). The product's core. |
| `driver/` | Node scripts: identity graph, deploy, oracle, actions, the full-cycle demo. |
| `ui/` | `index.html` — the entire console. One static file, no build step, no dependencies. |
| `research/model/` | Executable BigInt model of the accounting rules + a 31-attack suite. |
| `tests/` | `console.test.js` (page regressions + live RPC), `adversarial.test.js` (attacks on the live contract). |
| `docs/` | Architecture, contract interface, security, verification, demo, FAQ. |
| `demo-log.json` | 18 real testnet transaction hashes from the recorded demo. |

## Commands

```bash
npm ci --ignore-scripts       # install (near-api-js only)
npm run test:model            # reference model: 31 attacks, 0 exploitable
npm run test:contract         # cargo test — 21 Rust unit tests
npm run test:console          # node --test — page regressions + one live RPC read
npm run test:onchain          # 17 adversarial tests against the LIVE contract (needs fresh deploy)
npm test                      # model + contract + console

node driver/keys.js           # create the testnet identity graph
npm run deploy                # deploy (60s challenge window)
npm run demo                  # run the full economic cycle, write demo-log.json
```

## Conventions and non-negotiables

- **No fabricated data, ever.** Every number in the UI is contract state. Never embed a hash that is
  not in `demo-log.json` (a test enforces this), never invent a metric, never show a success the
  chain did not return.
- **Honest read states.** The console must distinguish loading / live / stale / failed. A failed read
  may never be rendered as live. `tests/console.test.js` asserts the catch path cannot claim live.
- **Fail closed.** Contract refusals abort with a human-readable reason, never a silent trap.
- **The console stays dependency-free.** No framework, no build step, no CDN. Plain HTML/CSS/JS.
  Keep the invariant `main > section { min-width: 0 }` and the `.scroll` table wrappers — tests
  depend on them to prevent mobile overflow.
- **Accessibility is a gate.** WCAG 2.2 AA: run `npm run axe` (axe-core) and keep 0 violations at
  320/360/390/768/1024/1280/1440 px, for the page **and** the wallet dialog. Muted and accent text
  must clear 4.5:1 (a test computes this from the tokens).
- **Keep the console honest about scope.** It reads the contract and, with the user's own wallet,
  signs exactly one `buy_cover` call. It holds no key and never fabricates state: a failed read is
  shown as stale or "no data", never as live. Do not imply it can call an owner-only method.
- **One concern per change.** Do not reformat code you did not need to touch.

## Deploying the console

`.github/workflows/pages.yml` publishes `ui/` to the `gh-pages` branch on every push to `main`
(`force_orphan: true`). GitHub Pages serves that branch at https://itzebe.github.io/overcover/.
There is no build step — the pushed file is the served file.

## Where to read next

- Product and architecture: `docs/ARCHITECTURE.md`
- Every contract method and state field: `docs/CONTRACT.md`
- Trust boundary and residual risk: `docs/SECURITY.md`
- Reproducing every claim: `docs/VERIFICATION.md`
- The judging demo: `docs/DEMO.md`
