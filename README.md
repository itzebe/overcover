# OVERCOVER — programmable insurance for autonomous businesses

> **Live console:** https://itzebe.github.io/overcover/
> **Live contract:** `contract.attestor-overcover.testnet` (NEAR testnet)
> **Tracks:** Business (primary) · Swarms (agent-operated businesses) · DeFi (underwriting pool)
> **License:** MIT
> **Submission pack:** [`SUBMISSION.md`](SUBMISSION.md) · X demo post in [`docs/DEMO_POST.md`](docs/DEMO_POST.md)

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
5. **Price a policy** quotes a live premium from the contract's own `quote` view and is explicit that
   it is read-only.
6. **Can the pool pay what it has promised?** is the live pool with an insurance framing, then
   **Policies written** and **Observations & disputes** — including a **nullified** reading that was
   successfully challenged on-chain.
7. **How this differs from a traditional claim** states the honest comparison and the required
   disclosures; **Check it for yourself** lets you reproduce every figure.

```bash
# the whole pool in one view call — the same read the page makes
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.attestor-overcover.testnet","method_name":"get_pool","args_base64":"e30="}}'
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
   attestor key ──▶ driver/oracle.js ──▶ ed25519 sign ──▶ report_observation(city, date, value, sig)
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
- **Oracle** (`driver/oracle.js`): reads Open-Meteo *current* precipitation and cross-checks it
  against the *hourly* series; refuses to sign if the two disagree by more than 0.5 mm.
- **Attestor** (`driver/attestor.js`): signs the exact message the contract verifies.
- **Driver** (`driver/`): identity graph, deploy with a clean-state reset, high-level actions, and
  the full-cycle demo.
- **Reference model** (`research/model/`): an executable BigInt model of the accounting rules and a
  31-attack suite that runs *before* the contract.

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
`?contract=<id>`; the default is `contract.attestor-overcover.testnet`.

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
npm run test:model      # 31 attacks, 31 defended, 0 exploitable  (reference model)
npm run test:contract   # 21 Rust unit tests                      (contract logic)
npm run test:console    # 29 regression + live-RPC tests          (browser console)
npm run test:onchain    # 17 adversarial tests against the LIVE contract (needs a fresh deploy)
```

`npm run test:onchain` sends real attacks to the deployed contract and asserts each is **refused
with the expected reason** — capacity, premium, lead time, signature, replay, staleness, bond,
challenge window, ownership, provider share. It requires a fresh `npm run deploy` first.

## Verification evidence

Everything below is independently checkable. Nothing here is asserted on trust.

| Claim | How to check |
| --- | --- |
| Deployed bytecode matches this source | `cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release` then compare `sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm` with the module the RPC returns for `contract.attestor-overcover.testnet`. Expected `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e`. |
| The pool is solvent right now | `get_pool` returns `reserved ≤ capital` and `solvent: true`; `reconcile` returns `true`. |
| Every demo transaction is real | `demo-log.json` holds 18 hashes; each resolves via `tx` RPC and on `testnet.nearblocks.io`. |
| The oracle is challengeable, both ways | The log includes `challenge` + `resolve_dispute:true` (report upheld, bond forfeited) **and** `resolve_dispute:false` (report nullified, bond returned). |
| The console is accessible | `axe-core` (WCAG 2.2 AA) reports 0 violations at 360/390/768/1024/1440 px, with no horizontal overflow. |

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

## Honest limitations

- The oracle is a **single trusted attestor** with a bonded dispute path, not yet a decentralised
  oracle. The dispute path is implemented, unit-tested, and has been **exercised on the live demo**
  in both directions (upheld and nullified) — but it still relies on the owner to resolve.
- The demo uses a **60-second challenge window**; production uses 3600 s.
- The demo reports the **same real Open-Meteo reading** the threshold was derived from, so the
  outcome is deterministic. The reading is genuine; it is pinned, not fabricated.
- The live contract carries **17 products**, of which 2 are the canonical named products and 15 are
  demo-generated test rows. The console groups the latter so the real cover stays legible.
- Testnet only. No audit. Not for real funds.

## Deploy

The console is a single static file with no build step, published to **GitHub Pages** from the
`gh-pages` branch by [`.github/workflows/pages.yml`](.github/workflows/pages.yml). The workflow
copies `ui/` to the branch root with a `.nojekyll` marker; the site is
https://itzebe.github.io/overcover/. Any static host works equally well.

Reads go straight from the browser to public NEAR testnet RPC endpoints — there is no backend and
no secret in the bundle.

## Documentation

| Document | Contents |
| --- | --- |
| [`SUBMISSION.md`](SUBMISSION.md) | Competition submission: one-liner, evidence, track fit, demo script |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data flow, trust boundaries |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | Full contract interface and state model |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Security model, threat model, residual risk |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | How to reproduce every claim, with exact commands |
| [`docs/DEMO.md`](docs/DEMO.md) | 60-second judging script and the recorded demo |
| [`docs/FAQ.md`](docs/FAQ.md) | Honest answers to the obvious hard questions |
| [`AGENTS.md`](AGENTS.md) | Orientation for agents and new contributors |
