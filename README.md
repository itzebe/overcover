# OVERCOVER — programmable insurance for autonomous businesses

> **Live console:** https://overcover.vercel.app/ · https://itzebe.github.io/overcover/
> **Live contract (hardened, default for new cover):** `contract.ovc-v3-ctl-2f6c4c.testnet` (NEAR testnet)
> **Legacy address (original v1 module, read-only in the console):** `contract.attestor-overcover.testnet`
> **Tracks:** Business (primary) · Swarms (agent-operated businesses) · DeFi (underwriting pool)
> **License:** MIT
> **Submission pack:** [`SUBMISSION.md`](SUBMISSION.md) · X demo post in [`docs/DEMO_POST.md`](docs/DEMO_POST.md)
> **Demo video (2:57):** [`video/out/overcover-demo.mp4`](video/out/overcover-demo.mp4) · script in [`docs/JUDGE_DEMO.md`](docs/JUDGE_DEMO.md)

Overcover is a parametric risk mutual on NEAR: capital-backed cover that is defined by a product
rather than negotiated by an underwriter, and settled by contract rules rather than a claims queue.

---

## The problem

An autonomous business — a fleet, a cold-chain route, a market-making desk, a compute broker — can
buy, sell and move money without a person in the loop. It cannot buy insurance. Every insurer
underwrites the *legal person* behind the policy: an application, a signature, an adjuster, a claim
queue measured in weeks. An agent that loses a shipment at 03:00 cannot wait for a human adjuster,
and it has no legal identity to sign with. So a loss is simply absorbed.

The capital that would underwrite those risks has no trustless way in either: no verifiable index,
no dispute mechanism, and no on-chain guarantee that a pool never promises more than it holds.

## What Overcover is

An on-chain pool that writes fully-collateralised, machine-readable cover against objective public
indices and settles it autonomously in seconds.

- **Risk is defined, not negotiated.** A *product* fixes the city/index, the trigger threshold, the
  premium rate, the payout bounds, the minimum lead time and a capacity cap. Once published it is
  immutable, so a buyer cannot be re-priced and there is no discretion at claim time.
- **Cover is a purchase, not an application.** `buy_cover(product, payout, obs_date)` charges the
  premium the product fixes, reserves the payout from the pool immediately, and re-checks the
  solvency invariant `reserved ≤ capital`.
- **The index is observed by a signed oracle.** An attestor reports `(city, date, value)` signed
  with ed25519; the contract verifies the signature, the freshness and a single-use nonce.
- **The oracle's word is challengeable.** Anyone can dispute a reading by posting a bond; the owner
  resolves. The loser's bond is forfeited into the pool.
- **Settlement is deterministic.** Once the challenge window has elapsed, `resolve(policy_id)` pays
  the beneficiary iff the validated reading meets the threshold — once, and only once.
- **Cover is permissionless to create.** A discovery agent reads a real public forecast and prepares
  a *prospective* proposal; anyone — not just the owner — submits it with `propose_product` and a
  small anti-spam stake. The **contract** judges it against fixed underwriting rules (known metric,
  bounded premium, plausible threshold, prospective coverage start, no duplicate id, and a cumulative
  capacity bound so proposals cannot overcommit the pool). A qualifying proposal activates
  immediately as an immutable product, with the proposer and an immutable evidence hash recorded
  on-chain. There is no owner transaction and no discretionary approval in the path.

## Try it in 60 seconds

Open **https://itzebe.github.io/overcover/**. No install, no keys, no account. It reads the live
contract straight from your browser over public NEAR testnet RPC.

The page is written as an insurance product first: it says what is covered and who it is for before
it says how the settlement works.

1. The hero states the promise — *insurance for businesses that cannot afford to wait* — and names
   the covered event. Beside it, an original illustration shows the risk outside and the cover
   inside. A live line reports the pool straight from the contract.
2. A **cover strip** gives the four figures that matter to a policyholder: capital backing policies,
   capital reserved for potential payouts, policies in force, and settlements already paid.
3. **What Overcover covers, and who it is for**, then **From buying cover to getting paid** — the
   eight-step journey, each step naming the actor and the contract method behind it.
4. **Cover available now** shows each product as a coverage card: the covered event, the trigger, the
   premium, the payout bounds, capacity and capacity left, with the parametric limitation stated.
5. **Price a policy** quotes a live premium from the contract's own `quote` view, and **Buy this
   cover with your own wallet** turns that quote into a real policy: the page re-reads the premium
   from the contract, attaches exactly that as the deposit, and your wallet signs a single
   `buy_cover` call. Overcover never sees your key; if you decline, nothing happens.
6. **Can the pool pay what it has promised?** is the live pool with an insurance framing, then
   **Policies written** and **Observations & disputes** — including a **nullified** reading that was
   successfully challenged on-chain.
7. **An autonomous agent can buy cover too** runs the same contract driven by software. The public
   panel evaluates a purchase with the agent's own **spending-policy engine**, read-only in your
   browser (no key, nothing signed); connect a local agent service you run yourself (see
   [`agent/README.md`](agent/README.md)) to watch it decide against hard spending limits and buy
   within them.
8. **How this differs from a traditional claim** states the honest comparison and the required
   disclosures; **Check it for yourself** lets you reproduce every figure.

```bash
# the whole pool in one view call — the same read the page makes
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"get_pool","args_base64":"e30="}}'
```

## Why NEAR

- **Fast finality** — a claim settles in seconds, which is what an autonomous business needs.
- **Low fees** — small parametric payouts (a missed delivery, a rained-out event) stay economic.
- **Account model** — named accounts, ed25519 keys, and a cheap `env::ed25519_verify` host function
  make a signed oracle a first-class primitive.
- **Free testnet** — the whole product runs on testnet with faucet-funded accounts and a keyless
  public weather API. No paid infrastructure in the critical path.

## Architecture

```
                       Open-Meteo (keyless, free)
                              │  current + hourly cross-check
                              ▼
   operator key ──▶ driver/operator.js ──▶ ed25519 sign ──▶ report_observation(city, date, value, sig)
                              │                                     │
                              ▼                                     ▼
   business ── buy_cover ──▶ ┌─────────────────────────────────────────────┐
   LP ──────── deposit ─────▶ │  Overcover contract (Rust, near-sdk 5)       │
   challenger ─ challenge ──▶ │  products · policies · pool · observations   │
   owner ───── resolve ─────▶ │  invariant: reserved <= capital              │
                              └─────────────────────────────────────────────┘
```

- **Contract** (`contract/`): Rust, `near-sdk`, `LookupMap`/`UnorderedSet` collections. Immutable
  products; policy issuance with capital reservation; signed-oracle verification; bonded disputes
  with a challenge window; beneficiary payouts; per-product and pool capacity caps; provider
  shares; a `reconcile` view for the solvency identity. Full surface in
  [`docs/CONTRACT.md`](docs/CONTRACT.md).
- **Oracle operator** (`driver/operator.js`): one independent operator node — reads a public index
  for a metric/city/date and signs the canonical reading with its own ed25519 key. The contract
  finalises an observation only when a quorum of distinct operators agree within tolerance.
- **Metric adapters** (`driver/adapters.js`): turn a `(metric, city, date)` into a tenths-scaled
  reading from a keyless source (Open-Meteo); adding a risk category is a new adapter, not a
  contract change.
- **Attestor** (`driver/attestor.js`): signs the exact message the contract verifies.
- **Driver** (`driver/`): identity graph, deploy with a clean-state reset, high-level actions, and
  the full-cycle demo.
- **Reference model** (`research/model/`, `sim/`): an executable BigInt model of the accounting rules
  plus the full-lifecycle and adversarial simulation (`npm run simulate:full`, `sim/evidence.json`).
- **Discovery agent** (`agent/discovery.mjs`): a PROPOSER, not a financial authority. It reads a real
  public forecast (Open-Meteo), applies a deterministic risk rule, and emits a structured proposal
  whose coverage start is prospective. It invents nothing: the premium is the contract's own formula,
  a forecast is labelled a forecast (never an observation of an event that occurred), and the evidence
  is preserved with a sha256 that the contract records on-chain when the product activates. The
  console's "Insurance factory" section shows the prepared proposal and marks it ACTIVE only when the
  contract returns an activated product with the matching evidence hash.

## The console

`ui/index.html` is a single, zero-dependency static file. It makes direct RPC `view` calls to the
deployed contract and renders the pool, the products as coverage cards, the policies, the signed
observations and a live quote — no server, and no key, token or secret in the bundle. The hero
illustration is inline SVG, so there is no remote image that can fail in production.

```bash
python3 -m http.server 12000 --directory ui   # then open http://localhost:12000
```

It reads honestly: a failed read shows a **stale** warning with the time of the last good read, or a
**no data** state — never a stale number presented as live. Any contract can be inspected with
`?contract=<id>`; the default is the hardened `contract.ovc-v3-ctl-2f6c4c.testnet`. The original
address `contract.attestor-overcover.testnet` can still be inspected (it is labelled *legacy* and
new purchases are disabled there).

## Buying cover with a wallet, and the autonomous agent

`ui/wallet.js` (bundled to `ui/vendor/wallet-bundle.js` by `npm run build:wallet`) is the only code
that touches a NEAR wallet. It holds **no private key**: it asks the user's wallet to sign one
`buy_cover` call with the contract's own premium attached. Two wallets are supported:

- **HERE Wallet** — signs in with email or a social account inside the HERE app; no browser
  extension needed. This is the email-based onboarding path.
- **Meteor Wallet** — a browser extension.

**MyNearWallet has been removed.** The integration was retired (MyNearWallet no longer accepts new
application connections), so it is gone from the picker, the bundle and the dependency tree rather
than shown as a working option. The site itself does **not** ship an email/MPC embedded wallet: a
frontend MPC provider (evaluated: MetaMask Embedded Wallets, formerly Web3Auth) hands the user's
private key to the page and needs a project client ID, both of which break the guarantee that no key
ever reaches the page — so HERE Wallet's own email sign-in is offered instead (see
[`docs/SECURITY.md`](docs/SECURITY.md)).

The wallet picker is a modal, so it opens where the user clicked — from the header, the hero, or the
buy panel. It closes on the Close button, on Escape, and on a backdrop click, restores focus to the
control that opened it, and locks the page behind it. It states honestly which wallets this browser
can actually complete (a wallet that is not installed is disabled with an install link, not offered
as a flow that dead-ends). A connect attempt is bounded by a timeout, so a wallet that never answers
reports an error instead of hanging.
The console reports a policy as bought only from the wallet's confirmed outcome (it inspects
`status.Failure` and requires a real transaction hash), never optimistically.

`agent/` is a dependency-free autonomous agent: a pure spending-limits policy engine
(`limits.mjs`), the agent core (`agent.mjs`), and a small HTTP API (`server.mjs`). The agent's key
lives in the operator's environment and is never in the browser or this repository. It ships in
**dry-run by default** — it decides and reports, but sends nothing. A denied decision never reaches
the network, so no funds move on a refusal. See [`agent/README.md`](agent/README.md).

The console's agent panel has two modes and **needs no local service for the default**:

- **Public (read-only)** — the default. The page loads the **same** policy engine the service runs
  (`agent/limits.mjs`, bundled to `ui/vendor/policy.js` by `npm run build:wallet`) and evaluates a
  purchase in the browser against the live contract quote, with no key and nothing signed. It shows
  the limits it judged against, so the verdict is auditable. This is what a public visitor gets.
- **Local service** — opt-in. Enter the URL of an agent service you run yourself, and the console
  watches it decide and buy within limits. The page never defaults to `localhost` and never calls
  it unless you choose this mode.

## Run it

```bash
npm install

# 1. create the testnet identity graph (faucet + funded subaccounts)
node driver/keys.js

# 2. deploy the contract (60s challenge window for a live demo)
npm run deploy

# 3. run the complete economic cycle on testnet
npm run demo
```

The demo prints a real NEAR transaction hash for every step and writes `demo-log.json` with
explorer links.

## Verify it

```bash
npm ci --ignore-scripts
npm run test:model      # 74 attacks, 74 defended, 0 exploitable  (reference model)
npm run test:contract   # 88 Rust unit tests (incl. a stateful solvency fuzzer)  (contract logic)
npm run test:console    # 116 regression + live-RPC tests         (browser console + end-to-end wallet journey)
npm run test:agent      # 53 limits + API + u128-precision + funds-guard + OpenAPI + idempotency tests  (autonomous agent)
npm run test:agent-eval # 33 product-feed schema/premium + agent-eval boundary + independent-client integration tests
npm run test:deploy     # 21 deploy/upgrade-path regressions (a stale, guard-less wasm is refused)
npm run test:onchain    # 17 adversarial tests against the LIVE contract (needs a fresh deploy)
npm run products:feed   # regenerate ui/products.json from the live contract
npm run verify:proof    # one-command independent proof of the headline claims (bytecode,
                        #   solvency, all 18 demo txs, the agent's buys, settled outcomes)
npm run verify:migration # SEC-1 proof: the deployed v1 migrate() takeover, and the v2 guard
npm run verify:upgrade  # SEC-1 guard on the COMPILED wasm on a real local neard node (needs neard)
npm run verify:upgrade-preservation  # the in-place upgrade PRESERVES state (real v1 bytecode; needs neard)
npm run verify:controlled-v3:plan    # the controlled v3 testnet deployment plan (sends nothing)
npm run verify:controlled-v3         # the controlled v3 deploy on NEAR TESTNET (40/40; needs a funded root)
npm run verify:controlled-v3:sandbox # controlled v3 deploy + SEC-1 closure + permissionless factory on a real neard (39/39)
npm run verify:controlled-v3:evidence # public on-chain state of the deployed v3 testnet contract (no key)
npm run verify:testnet-deploy  # a real, isolated v2 deploy to NEAR testnet (needs the faucet)
npm run verify:agent    # the agent's spend-authorization engine vs the live product definition
npm run verify:connectivity  # the public console works with no local agent (needs a Chromium)
npm run verify:live     # the LIVE production URL at 320–1440 px (needs a Chromium)
```

`npm run verify:proof` and `npm run verify:agent` read only the public RPC and the committed
artefacts; they need no key and write nothing on-chain. `npm run verify:live` loads
`https://overcover.vercel.app/` (override with `LIVE_URL=…`) at five widths, fails on any console
error or horizontal overflow, and screenshots each width into `proof/shots/`. `npm run
verify:connectivity` boots the real agent service in dry-run and drives the real page in a browser,
asserting the public console needs no local service while the security boundary holds (no localhost
default, no owner-only method reachable, limits enforced, invalid bodies rejected).

 `npm run test:agent` covers the spending-limits policy engine (a denied buy never touches the
network) and the agent HTTP API (strict field validation, `413` on oversized bodies, idempotent
retries). `npm run ui:qa` is an optional Playwright check of the console at 320–1440 px, exercising
the public read-only evaluation and a live dry-run agent round-trip in local mode, plus the wallet
dialog's open/close paths (Close button, Escape, backdrop) and focus restoration; it needs a
Chromium and is not part of `npm test`. `npm run axe` runs axe-core (WCAG 2.2 AA) over the page and
the wallet dialog at 320–1440 px and expects zero violations.

`npm run test:onchain` sends real attacks to the deployed contract and asserts each is **refused
with the expected reason** — capacity, premium, lead time, signature, replay, staleness, bond,
challenge window, ownership, provider share. It requires a fresh `npm run deploy` first.

## Verification evidence

Everything below is independently checkable. Nothing here is asserted on trust.

| Claim | How to check |
| --- | --- |
| Deployed bytecode matches this source | The repo pins Rust **1.99.1** (`rust-toolchain.toml`). Because the wasm embeds the **absolute cargo registry path**, a byte-identical rebuild also needs the same `CARGO_HOME`. Reproduce exactly: `CARGO_HOME=/home/openhands/.cargo cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release` then compare `sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm` with the module the RPC returns for `contract.attestor-overcover.testnet`. Expected `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e`. CI does the same (`verify:proof`). A different `CARGO_HOME` changes the hash — the match confirms *source ↔ bytecode* under the pinned environment, not byte-reproducibility from an arbitrary one. |
| The pool is solvent right now | `get_pool` returns `reserved ≤ capital` and `solvent: true`; `reconcile` returns `true`. |
| The SEC-1 fix ships safely and the live contract can be upgraded without wiping state | `npm run test:deploy` proves both deploy paths refuse a stale, guard-less wasm. `npm run verify:upgrade` runs the **compiled** wasm on a real `neard` node and shows a third-party `migrate()` is refused while the contract's own self-call is accepted. `npm run verify:controlled-v3:sandbox` deploys the compiled v3 wasm to a fresh account on a real `neard` node, configures a 3-of-5 operator quorum and a 3-of-5 resolver quorum, and asserts 39 properties against the **deployed** module — including a NON-OWNER `propose_product` activation and that a third-party `migrate()` is refused. `node driver/upgrade.js --plan` prints the exact in-place upgrade operations and costs (needs no key). `npm run verify:testnet-deploy` performs a real, isolated v2 deploy to NEAR testnet and buys one policy. |
| The legacy live address can be upgraded, or a fresh contract can replace it | `docs/AUTHORITY_RECOVERY.md` records that the live account's FullAccess private key is **not recoverable from the chain** and not held here; the supported alternative is the controlled v3 deployment (`node proof/controlled-v3-deploy.mjs`), which stands up a fresh, SEC-1-closed contract on a new account the operator controls. |
| Every demo transaction is real | `demo-log.json` holds 18 hashes; each resolves via `tx` RPC and on `testnet.nearblocks.io`. |
| The oracle is challengeable, both ways | The log includes `challenge` + `resolve_dispute:true` (report upheld, bond forfeited) **and** `resolve_dispute:false` (report nullified, bond returned). |
| The console is accessible | `npm run axe` (axe-core, WCAG 2.2 AA) reports 0 violations at 320/360/390/768/1024/1280/1440 px, for the page **and** the wallet dialog, with no horizontal overflow. |
| The wallet picker opens where you click, at every width | `npm run ui:qa` clicks Connect at 320–1440 px and asserts the modal is in-viewport with no overflow; `npm run test:console` covers the installed/not-installed labelling and the connect timeout. |
| The wallet dialog closes on every path | `npm run ui:qa` asserts the Close button, Escape and a backdrop click each close the dialog and restore focus; `npm run test:console` asserts the Close control is a real `method="dialog"` submit and that the valueless `data-wallet-close` attribute is matched with `hasAttribute`, not a falsy `getAttribute`. |
| The console can only sign against a verified hardened module | `ui/index.html` holds a `TRUSTED` allowlist of `(address → module code_hash)` pairs. The security banner and the buy gate are derived from the **contract's own** deployed `code_hash` (`get_account`), not from markup: an unknown address is `untrusted`, the legacy module is `legacy`, and the buy button is enabled only for `hardened`. `doBuy` re-reads the module **immediately before signing** and refuses if the address or its module changed. `npm run verify:connectivity` asserts the allowlist, the default and the pre-sign re-check statically. |
| Search engines and AI crawlers can find and describe the product | `/robots.txt`, `/sitemap.xml`, `/llms.txt` and `/llms-full.txt` ship in `ui/` and are asserted by `npm run test:console`; the head carries canonical, Open Graph, Twitter and JSON-LD metadata in the served HTML. |
| MyNearWallet is gone | `npm run test:console` asserts no `my-near-wallet`/`MyNearWallet` reference remains in the page, `ui/wallet.js`, `package.json` or `package-lock.json`, and that the bundle registers only HERE and Meteor. |

## Security model

- **Immutability** — products cannot be changed after publication.
- **Reservation accounting** — a payout is reserved at purchase; the pool can never promise more
  than it holds (`reserved ≤ capital`, checked after every mutation).
- **Signed, bound observations** — the signature covers city, date, value, report time, nonce and
  the contract id, so a value cannot be reused, replayed or moved to another contract.
- **Freshness + replay** — observations must be recent and nonces single-use.
- **Bonded disputes** — a false report is punished; a nullified reading cannot settle a policy.
- **Fail-closed messages** — every refusal aborts with a human-readable reason, never a silent trap.

Full detail, including the trust boundary and residual risks, in [`docs/SECURITY.md`](docs/SECURITY.md).
An internal security pre-audit — with a reproduced critical finding (an unauthenticated `migrate()` on
the deployed v1 contract, fixed in the v2 source), two agent races fixed under concurrency, and the
service-auth hardening — is in [`docs/SECURITY_PRE_AUDIT.md`](docs/SECURITY_PRE_AUDIT.md).

## Honest limitations

- The oracle is a **single trusted attestor** with a bonded dispute path, not yet a decentralised
  oracle. The dispute path is implemented, unit-tested, and has been **exercised on the live demo**
  in both directions (upheld and nullified) — but it still relies on the owner to resolve.
- The demo uses a **60-second challenge window**; production uses 3600 s.
- The demo reports the **same real Open-Meteo reading** the threshold was derived from, so the
  outcome is deterministic. The reading is genuine; it is pinned, not fabricated.
- The legacy v1 address carries **22 products** (2 canonical named products — `rain-lagos`,
  `rain-bergen-dry` — plus 20 demo-generated test rows); the hardened default
  `contract.ovc-v3-ctl-2f6c4c.testnet` carries 2 named products (`heat-lagos`,
  `heat-lagos-factory`). The console groups demo rows so the real cover stays legible.
- The **autonomous agent** ships in dry-run and is run by the operator, not hosted by Overcover: a
  public endpoint that signed with a funded key would let any visitor spend that balance. The
  console's public agent panel is therefore **read-only** (it evaluates with the same policy engine
  in the browser and signs nothing); buying through the agent requires a service you run yourself.
- **Rate limits and single-flight locks in the agent service are per-instance**, not global across
  processes. They reduce accidental double-spends; they are not a distributed lock.
- Testnet only. No audit. Not for real funds.

## Discoverability

The public console is built to be found and understood by search engines and AI
answer engines:

- `/robots.txt` allows all crawlers (and names GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended and Applebot-Extended) and points at the sitemap.
- `/sitemap.xml` lists the canonical URL `https://overcover.vercel.app/`.
- `/llms.txt` and `/llms-full.txt` describe the product, the economic loop, the
  wallet and security model, the agent architecture and the honest limitations in
  plain text for language models.
- The head carries a canonical link, Open Graph and Twitter card metadata (with a
  real 1200×630 `og.png`), a theme colour and a language declaration, all in the
  served HTML rather than injected after JavaScript runs.
- Truthful JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`, `WebPage`)
  describes the product without invented ratings, reviews or pricing.

These files state only what the application actually does.

## Deploy

The console is a single static file with no build step, published two ways:

- **Vercel** (Hobby plan, free) from the repository root, `outputDirectory: ui` — the production
  console is https://overcover.vercel.app/. See [`vercel.json`](vercel.json).
- **GitHub Pages** from the `gh-pages` branch by
  [`.github/workflows/pages.yml`](.github/workflows/pages.yml) — https://itzebe.github.io/overcover/.

Reads go straight from the browser to public NEAR testnet RPC endpoints — there is no backend and
no secret in the bundle. The agent service is not deployed publicly; run it locally (see
[`agent/README.md`](agent/README.md)). The public console does not need it: the default agent mode
is read-only and runs the same policy engine in the browser.

## Documentation

| Document | Contents |
| --- | --- |
| [`SUBMISSION.md`](SUBMISSION.md) | Competition submission: one-liner, evidence, track fit, demo script |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data flow, trust boundaries |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | Full contract interface and state model |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Security model, threat model, residual risk |
| [`docs/SECURITY_PRE_AUDIT.md`](docs/SECURITY_PRE_AUDIT.md) | Internal pre-audit: reproduced findings, fixes and residual risk |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | How to reproduce every claim, with exact commands |
| [`docs/DEMO.md`](docs/DEMO.md) | 60-second judging script and the recorded demo |
| [`docs/JUDGE_DEMO.md`](docs/JUDGE_DEMO.md) | 2–3 minute judge demonstration, checklist and backup plan |
| [`docs/AGENT_INTEGRATION.md`](docs/AGENT_INTEGRATION.md) | How an agent discovers cover, the spending policy, the HTTP API |
| [`docs/BUSINESS.md`](docs/BUSINESS.md) | Market, model and economics grounded in the real contract rules |
| [`docs/PITCH.md`](docs/PITCH.md) | Ten-second explanation, investor thesis, target market and an honest proven/not-proven line |
| [`docs/COMPETITIVE.md`](docs/COMPETITIVE.md) | How Overcover compares with on-chain and parametric incumbents |
| [`docs/BASELINE_REPORT.md`](docs/BASELINE_REPORT.md) | Ground-truth snapshot of what is deployed, tested and unverified |
| [`docs/FINAL_RELEASE_READINESS.md`](docs/FINAL_RELEASE_READINESS.md) | Fixed / not-fixed register with evidence and honest gaps |
| [`docs/FAQ.md`](docs/FAQ.md) | Honest answers to the obvious hard questions |
| [`AGENTS.md`](AGENTS.md) | Orientation for agents and new contributors |
