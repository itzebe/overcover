# OVERCOVER — an autonomous parametric risk mutual for AI-operated businesses

> **Live on NEAR testnet:** `contract.attestor-overcover.testnet`
> **Console:** `ui/index.html` — deployable as a static site (see [Deploy](#deploy))
> **Tracks:** Business · Swarms · DeFi

## The problem

AI agents are starting to run real businesses — fleets, cold-chain routes, market-making desks,
compute brokers. They can buy, sell, and move money autonomously. What they **cannot** do is buy
insurance. Every insurer underwrites the *legal person* behind the policy: an application, a
signature, an adjuster, a claims queue measured in weeks. An agent that loses a shipment at 03:00
cannot wait for a human adjuster, and it has no legal identity to sign a contract with.

Meanwhile the pool of capital that *would* underwrite these risks has no safe, transparent,
programmatic way to do so: no verifiable oracle, no dispute mechanism, no solvency guarantee.

## What Overcover is

A **parametric risk mutual** — an on-chain pool that writes fully-collateralised, machine-readable
cover against objective public indices, and settles claims autonomously in seconds.

- **The risk is defined, not negotiated.** The contract publishes *products*: a city/index, a
  trigger threshold, a premium rate, payout bounds, a minimum lead time, and a capacity cap.
  Once published, a product is immutable. There is no underwriter to argue with, and no
  discretion at claim time.
- **Cover is a purchase, not an application.** A business calls `buy_cover(product, payout, obs_date)`.
  The premium is fixed by the product (`premium_bp`), the payout is reserved from the pool
  immediately, and the solvency invariant `reserved ≤ capital` holds after every transaction.
- **The index is observed by a signed oracle.** An attestor reports `(city, date, value)` signed
  with ed25519. The contract verifies the signature, the freshness, and a replay nonce before it
  will accept an observation.
- **Anyone can dispute.** A challenger posts a bond; the owner resolves. The loser's bond is
  forfeited into the pool. This is what keeps the oracle honest without a trusted third party.
- **Settlement is deterministic.** Once the challenge window has elapsed, `resolve(policy)` pays
  the beneficiary iff the signed observation meets the threshold. No adjuster, no queue.

## Why NEAR

- **Fast finality** — a claim settles in seconds, which is what an autonomous business needs.
- **Low fees** — small parametric payouts (a missed delivery, a rained-out event) are economic.
- **Account model** — named accounts, ed25519 keys, and a cheap ed25519 verification host
  function (`env::ed25519_verify`) make signed oracles first-class.
- **Free testnet** — the whole product runs on testnet with faucet-funded accounts and a keyless
  public weather API. No paid infrastructure anywhere in the critical path.

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

- **Contract** (`contract/`): Rust, `near-sdk`, legacy `LookupMap`/`UnorderedSet` collections.
  Immutable products; policy issuance with capital reservation; signed-oracle verification;
  bonded disputes with a challenge window; beneficiary payouts; per-product and pool capacity
  caps; provider shares; a `reconcile` view for the solvency identity.
- **Oracle** (`driver/oracle.js`): reads Open-Meteo *current* precipitation and cross-checks it
  against the *hourly* series; refuses to sign if the two disagree by more than 0.5 mm.
- **Attestor** (`driver/attestor.js`): signs the exact message the contract verifies.
- **Driver** (`driver/`): identity graph, deploy with a clean-state reset, high-level actions,
  and the full-cycle demo.
- **Reference model** (`research/model/`): an executable BigInt model of the accounting rules and
  a 31-attack suite that runs *before* the contract (Mission 1).

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

## The console

`ui/index.html` is a zero-dependency live console. It makes direct RPC `view` calls to the
deployed contract and renders the pool, its solvency bar, the products, the policies and the
signed observations — no server, no keys in the browser.

```bash
python3 -m http.server 12000 --directory ui   # then open http://localhost:12000
```

## Verify it

```bash
npm run test:model      # 31 attacks, 31 defended, 0 exploitable  (reference model)
npm run test:contract   # 21 Rust unit tests                      (contract logic)
npm run test:onchain    # 17 adversarial tests against the LIVE contract
```

`npm run test:onchain` sends real attacks to the deployed contract and asserts each one is
**refused with the expected reason** — capacity, premium, lead time, signature, replay, staleness,
bond, challenge window, ownership, provider share. It requires a fresh `npm run deploy` first.

## Deploy

The console is a single static file with no build step. `vercel.json` sets `ui/` as the output
directory and disables the build, so any static host works:

```bash
vercel deploy --prod          # uses vercel.json; serves ui/index.html at /
```

Reads go straight from the browser to public NEAR testnet RPC endpoints — there is no backend, and
no key, token or secret is present in the bundle. The contract is selected with `?contract=<id>`,
defaulting to `contract.attestor-overcover.testnet`.

## 60-second demo script

1. **Open the console** — the header shows the live contract id and a green connection dot; the
   pool panel reads real capital and reserved capital from testnet.
2. **"This is fully-collateralised cover."** Reserved 1.5 of 1.6 NEAR capital — the solvency bar
   fills and `reserved ≤ capital: true` is computed from on-chain state, not asserted.
3. **Scroll to Products** — immutable risk definitions: index, trigger threshold, premium, max
   payout, reserved vs capacity cap.
4. **Scroll to Policies** — cover written, each with payout, premium, beneficiary and status
   (`active` / `settled_paid` / `settled_no_pay`).
5. **Scroll to Observations** — signed index reports, including a **nullified** one that was
   successfully challenged.
6. **Close on the footer** — reads are direct RPC calls to NEAR testnet, no server, no keys in the
   browser. Every number on screen is contract state.

## NEAR integrations and their purpose

| Integration | Purpose |
| --- | --- |
| `env::ed25519_verify` | Verify the oracle's signature on-chain; the trust anchor. |
| `Promise` transfer | Pay the beneficiary and return provider capital. |
| Account model / named accounts | Business, LP, attestor, challenger are distinct testnet accounts. |
| Testnet RPC + faucet | Free infrastructure for the entire lifecycle. |
| `nearblocks.io` explorer | Public, third-party evidence of every transaction. |

## Security model

- **Immutability** — products cannot be changed after publication, so a buyer cannot be re-priced.
- **Reservation accounting** — a payout is reserved at purchase; the pool can never promise more
  than it holds (`reserved ≤ capital`, checked after every mutation).
- **Signed, bound observations** — the signature covers city, date, value, report time, nonce and
  the contract id, so a value cannot be reused, replayed, or moved to another contract.
- **Freshness + replay** — observations must be recent and nonces single-use.
- **Bonded disputes** — the oracle's word is challengeable; a false report is punished.
- **Fail-closed messages** — every refusal aborts with a human-readable reason (`panic_utf8`),
  never a silent trap.

## Honest limitations

- The oracle is a **single trusted attestor** with a bonded dispute path, not yet a decentralised
  oracle. The dispute path is implemented and unit-tested but has not been exercised on the live
  testnet demo end to end (it needs a challenge window to elapse after a dispute).
- The demo uses a **60-second challenge window**; production uses 3600 s.
- The demo reports the **same real Open-Meteo reading** the threshold was derived from, so the
  outcome is deterministic. The reading is genuine; it is pinned, not fabricated.
- Testnet only. No audit. Not for real funds.
