# Overcover — product, business and go-to-market

A working, honest account of what Overcover is, who pays for it, and how it grows.
Figures about Overcover come from the shipped product and the live contract.
Figures about the market come from the cited sources; nothing is invented.

## The problem

Two problems meet.

**1. Slow, discretionary protection.** Arbol, a climate-risk underwriter, reports
that *"In 2023, the world faced 398 natural disasters, causing $380 billion in
losses, revealing a 69% global protection gap"* and that *"Traditional insurance
struggles to scale coverage for climate risks"*
([arbolmarket.com](https://www.arbolmarket.com)). A protection gap that large is a
process problem: cover is papered, permissioned and adjudicated, so it cannot
reach small, fast, objective risks.

**2. Agents can pay, but they cannot be trusted to spend.** Standards like x402 —
*"an open, neutral standard for internet-native payments"*
([x402.org](https://www.x402.org/)) — and Coinbase's *"Agentic Accounts"*
([docs.cdp.coinbase.com](https://docs.cdp.coinbase.com/x402/welcome)) let software
pay. They do not decide **what** it may buy or **whether a payout is due**. An
operator who hands an agent a funded key has handed it unlimited authority.

Overcover answers both with one primitive: a parametric cover whose payout rule is
fixed at purchase and enforced by a contract, and an autonomous buyer whose
spending is bounded by hard, human-set limits.

## The product

A single pool writes fully-collateralised cover against an objective public index
and settles it without a claim. In the shipped product the index is **rainfall in
a named city on a named date**:

- The contract computes the premium: `ceil(payout × premium_bp / 10 000)`.
- On purchase it **reserves the payout** in the pool, so a promise is always
  backed by capital (`reserved ≤ capital` holds on chain).
- An observation is published for the city and date. If the reading is **at or
  above the product's threshold**, the payout is released to the beneficiary; if
  not, the reserve is released back to the pool.
- A published reading can be **challenged** within a bond-backed window; the
  challenge is what makes a single attestor tolerable.

The buyer is either a person with a wallet or an autonomous agent with an account.
Both end in the same object: an on-chain policy anyone can read.

## Who pays, and why

| Segment | Job to be done | Why Overcover |
| --- | --- | --- |
| Small operators exposed to weather (farms, event organisers, logistics, outdoor retail) | Get paid fast when the index hits a number, without an adjuster | Deterministic settlement; no claim to file |
| Agent / automation builders | Let a bot buy protection without giving it a blank cheque | Hard limits, allow-lists, audit, kill switch |
| DeFi treasuries and market makers | Hedge an objective, public risk | On-chain, auditable, capital visible |
| Index providers and data vendors | Monetise a reading as a settlement source | A narrow, typed metric with a bond and a challenge |

## How it makes money (design, not yet charged)

The contract already records the primitives a fee model needs; **no fee is
currently taken** and this document does not claim revenue.

- **Premium margin.** Premium is `payout × rate`; the pool keeps premium it does
  not pay out. With the live catalogue's rates (1 %, 5 %, 10 %), a 1 NEAR payout
  at 5 % costs 0.05 NEAR and reserves 1 NEAR — so capital, not revenue, is the
  binding constraint.
- **Capacity fees.** A product can cap `max_total_coverage`; capacity can be
  priced or auctioned.
- **Data / oracle fees.** The party that publishes the reading can be paid a share
  of premium for a settlement-grade metric.

The honest constraint today is **capital efficiency**: the live pool has 14.05 NEAR
capital, 10.50 NEAR reserved (74.7 % utilisation) and 3.55 NEAR available. Growth
requires more underwriting capital, which is exactly what a mutual structure is
for.

## Go-to-market

1. **Prove the loop in public (now).** One real product, real policies, a
   one-command independent proof. Done: `rain-lagos` is live, policies 13 and 15
   exist on testnet, `npm run verify:proof` re-derives every headline claim.
2. **Publish the feed (this release).** `products.json` + schema make Overcover
   readable by an agent without a browser. This is the distribution surface.
3. **Land agent builders.** The value to an agent builder is the *authorization*
   layer: they can let a bot buy protection and still bound its spend. The
   `agent/sdk.mjs` client is the integration point.
4. **Widen the metric set.** Rainfall is one typed metric. The v2 model is
   metric-agnostic; each new index (temperature, wind, an on-chain rate) is a
   product definition, not a rewrite.
5. **Decentralise the oracle.** v1 is one bonded attestor. v2 adds an operator
   quorum and independent resolvers — the change that turns "trust one reporter"
   into "trust a quorum".

## Moat

- **The pairing, not either half.** Deterministic parametric settlement *and*
  first-class agent authorization in one protocol. Frameworks (Etherisc GIF) make
  you build it; mutuals (Nexus) decide claims by vote; payment rails (x402) move
  money but decide nothing.
- **Honest-read architecture.** Every displayed figure is a live contract read and
  a failed read is shown as failed. Trust of the interface is a product property.
- **Small, auditable surface.** One pool, one lifecycle, one metric type.

## Roadmap

| Phase | What | State |
| --- | --- | --- |
| v1 | Single-attestor parametric cover, human + agent purchase, honest console | **Live on testnet** |
| Feed | Machine-readable catalogue + agent evaluation tests | **This release** |
| v2 | Operator quorum, per-operator nonces, independent resolvers, generic metrics | Built, locally proven (21/21), **not deployed** |
| v3 | External settlement oracle (e.g. UMA-style dispute), capacity market, fee switch | Design only |

## Risks (honest)

- **Oracle centralisation (v1).** One bonded attestor. Mitigated by the bond and
  challenge window; solved only by v2.
- **Capital.** Payouts are fully collateralised, so cover is capped by pool
  capital, not demand.
- **Narrow demand.** One peril, one city shape; the metric model must generalise
  before the market does.
- **Regulatory.** Not an insurance product; no licence. Any real-world scale needs
  a legal wrapper.
- **Unaudited.** Testnet and unaudited; every claim in this repository is a claim
  about code and on-chain state, not about safety of funds.

## Why now

Two curves crossed: objective, cheap, high-coverage public data (weather, chain
state) is abundant, and software that acts on its own behalf is becoming normal.
Data plus autonomous buyers is exactly the shape Overcover was built for — and the
authorization layer, not the payment layer, is the missing piece.
