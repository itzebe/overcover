# Overcover — NEAR Hackathon 2026 submission pack

Everything a judge or the AI screener needs, in one place. Facts marked **[verified]** were read
from the live contract or the repository; anything else is labelled.

---

## One-liner

**Overcover is a parametric risk mutual for AI-operated businesses: it prices, writes and settles
cover on NEAR, with no underwriter and no claims queue.**

## The problem

An autonomous business — an agent running a delivery fleet, a cold-chain route, a market-making
desk — can already buy, sell, hold and move money. It cannot buy **insurance**. Underwriting needs
a legal person to assess risk and a human claims process that takes weeks. Both are unavailable to a
process that runs at machine speed, so an agent absorbs every weather, delay and outage loss itself.

## The solution

A mutual that replaces the underwriter with contract rules:

1. **Risk is published, not negotiated.** An owner publishes a *product*: the index, the trigger,
   the premium, the payout bounds and a capacity cap. Once published it is immutable, so cover
   cannot be re-priced after the fact.
2. **Payout is reserved at purchase.** Buying cover locks the payout out of the pool immediately,
   and the invariant `reserved ≤ capital` is re-checked after every state change. The pool can never
   promise more than it holds.
3. **The oracle's word is challengeable.** Readings are ed25519-signed and verified on-chain. Anyone
   can dispute a reading by posting a bond; the loser's bond is forfeited into the pool.

A provider (LP) deposits capital and earns premiums. A business buys cover and is paid automatically
when the index crosses the trigger. Nobody decides whether to pay: the contract does.

## Tracks

Primary: **`business`** — Autonomous Business.
Additional: **`swarms`**, **`defi`**.

## Live contract (NEAR testnet)

```
contract.attestor-overcover.testnet
code_hash 36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R
```

Verify the deployed bytecode is exactly this source:

```bash
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm
# expected: 1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e
```

The RPC returns the same 344857-byte module for `contract.attestor-overcover.testnet`.

## Try it (no install, no keys, no account)

Open the console. It reads the live contract directly from your browser over public NEAR testnet
RPC and shows, right now:

- `Capital backing cover` **9.7500 NEAR**, `Payouts promised` **4.5000 NEAR**
- two green invariants: `reserved ≤ capital` and `reconcile`
- 17 products, 8 policies (6 active, 1 settled paid, 1 settled no pay), 13 observations
  (12 signed, **1 nullified** — a reading successfully challenged on-chain)

Then open the **Proof** panel and run the `curl` it gives you. It returns the same JSON the page
rendered. Nothing on the page has to be taken on trust.

## How it works (30 seconds)

```
Open-Meteo (keyless, free)
      │  current + hourly cross-check
      ▼
attestor key ──▶ driver/oracle.js ──▶ ed25519 sign ──▶ report_observation(city, date, value, sig)
      │                                                        │
      ▼                                                        ▼
business ── buy_cover ──▶ ┌──────────────────────────────────────────────┐
LP ──────── deposit ─────▶ │  Overcover contract (Rust, near-sdk 5)        │
challenger ─ challenge ──▶ │  products · policies · pool · observations    │
owner ───── resolve ─────▶ │  invariant: reserved <= capital               │
                           └──────────────────────────────────────────────┘
```

## Evidence of genuine functionality

| Claim | Evidence |
| --- | --- |
| The contract runs on testnet | `contract.attestor-overcover.testnet`, code hash above |
| Deployed code matches source | wasm sha256 `1f30ccf1…`, byte-identical to the RPC module |
| The full cycle executes | 18 real transactions in `demo-log.json`, all 18 re-verified on-chain |
| Both dispute outcomes work | the log contains `resolve_dispute:true` (uphold, bond forfeited) and `resolve_dispute:false` (nullify) |
| Adversarial resistance | 17 attacks against the live contract, all refused with the expected reason |
| The economics hold | a 31-attack reference model, 0 exploitable |
| The console is not faking | it reads `get_pool`, `list_products`, `list_policies`, `list_observations`, `get_config`, `reconcile`, `check_invariant`, and `view_account` |

Test commands and counts are in the [README](../README.md#verify-it).

## 60-second demo script

1. **0–10s — the problem and the product.** "An autonomous business can buy, sell and move money,
   but it cannot buy insurance — underwriting needs a legal person and a claims queue measured in
   weeks." The console is already showing a live pool with real capital.
2. **10–25s — the pool is provable.** Point at `Capital backing cover`, `Payouts promised` and the
   two green invariants. "This is contract state, read with no server in between."
3. **25–40s — how the promise holds.** Immutable products; payout reserved at purchase; a
   challengeable oracle.
4. **40–55s — the real thing.** Show a settled payout and a **nullified** observation.
5. **55–60s — close on proof.** Copy the `curl`, run it, get the same numbers. "Don't trust the
   page. Reproduce it."

## Reproducing everything from scratch

```bash
npm ci --ignore-scripts
node driver/keys.js     # faucet-funded testnet identity graph
npm run deploy          # deploy the contract
npm run demo            # the full economic cycle, writing demo-log.json
npm run test:onchain    # 17 adversarial tests against the live contract
```

## What is honest about the limits

- **Testnet only.** No real funds move. Eligible for all tracks per the rules (Q-010).
- **The oracle is a demo attestor.** It signs real Open-Meteo data, but the trust model is "a key
  you can challenge with a bond", not a decentralised oracle network. That is the intended MVP
  boundary, not an accident.
- **No audits.** The contract is unit-tested and adversarially tested; it is not formally verified.
- **The payout address is a testnet account.** A mainnet address is supplied separately for prizes.
