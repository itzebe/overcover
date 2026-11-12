# Overcover — the pitch

The ten-second version, the investor thesis, and the honest line between what is
proven today and what is still a plan. Every number about the product is a live
read from the testnet contract; every market or business figure is a labelled
assumption, not a claim.

## The ten-second explanation

**Overcover is parametric insurance that a machine can buy on its own terms.**
Cover is defined up front against a public index, the payout is reserved from a
capital pool the moment a policy is written, and settlement follows a signed,
challengeable reading — while the buyer, human or autonomous agent, can only ever
spend within limits it was explicitly granted.

## The problem

Two things changed at once. Objective public data — rainfall, temperature, a chain
rate — is now cheap and high-coverage, so a payout can be decided by a number
instead of an adjuster. And software increasingly acts on its own behalf: an agent
that books, hedges, or rebalances does not wait for a human to file a claim.

Traditional insurance is built around a human claimant and a discretionary claims
process. Neither fits an autonomous buyer. The missing piece is not a payment rail;
it is an **authorization layer** — a way to let an agent buy protection without
handing it a blank cheque.

## The product (live on NEAR testnet)

- A **pool** writes fully-collateralised cover. A product fixes the index, the
  trigger, the premium rate and a capacity cap before anyone buys, and none of it
  can change afterwards.
- A **policy** is bought with a single `buy_cover` call whose deposit must equal the
  contract's own `quote`. The payout is reserved at that instant.
- **Settlement** follows a signed public reading. The reading can be challenged with
  a bond; a disputed reading cannot settle a policy until it is resolved.
- The **console** (https://overcover.vercel.app/) reads the contract directly and
  distinguishes live, stale and failed reads. It holds no key.
- The **agent** is an ordinary NEAR account with one power — `buy_cover` — bounded
  by a spending policy (per-policy caps, a rolling-24h budget, allow-lists, a
  cooldown, a kill switch, and a balance preflight). A refusal happens before any
  network call.

The full, sourced comparison with incumbents is in [`COMPETITIVE.md`](COMPETITIVE.md);
the business model and go-to-market are in [`BUSINESS.md`](BUSINESS.md).

## Target market (initial)

The first market is **small operators whose revenue is exposed to a measurable
public index**, reached through the software they already run:

| Segment | Trigger to cover | Why Overcover |
| --- | --- | --- |
| Event organisers, outdoor retail, logistics | Rainfall on a named date | Fast, deterministic payout; no claim to file |
| Agricultural co-ops and input suppliers | Rainfall below a threshold in a season window | Objective settlement; capacity is visible on-chain |
| Agent and automation builders | Any listed index | A bot can buy cover and still be bounded by explicit limits |
| DeFi treasuries | An on-chain or public rate | A hedge that settles from public data |

**Assumptions, not facts.** These segments are chosen from the shape of the product
and public market structure. Overcover has **no paying customers, no revenue, no
partnerships and no signed pilots** today. Any claim otherwise would be false. The
segment sizing that follows is illustrative arithmetic, not measured demand.

## Business model (design, not yet charged)

No fee is currently taken. The contract records the primitives a fee model needs:

- **Premium margin** — premium is `payout × rate`; the pool keeps premium it does
  not pay out.
- **Capacity fees** — a product caps `max_total_coverage`; capacity can be priced.
- **Data / oracle fees** — the publisher of a settlement-grade reading can take a
  share of premium.

The binding constraint is **capital efficiency**, not demand: the live pool holds
14.05 NEAR with 10.50 NEAR reserved (74.7 % utilisation). Because payouts are fully
collateralised, cover is capped by pool capital. Growth requires more underwriting
capital — which is exactly what a mutual structure exists to aggregate.

## The economics, in the contract's own terms

- Premium: `ceil(payout_yocto × premium_bp / 10000)`. A 1 NEAR payout at 5 % costs
  0.05 NEAR and reserves 1 NEAR.
- Payout: fixed at purchase, reserved from capital, released once the policy
  settles.
- Solvency: the contract re-checks `reserved ≤ capital` and refuses any transaction
  that would promise more than the pool holds. `reconcile()` and
  `check_invariant()` are public views; both currently return true.

## The investor thesis

1. **A real, working primitive, not a deck.** The product runs on testnet: a live
   contract, a live catalogue, human and agent purchases with real transaction
   hashes, and a one-command independent proof (`npm run verify:proof`, 13/13).
2. **The pairing is the moat.** Deterministic parametric settlement *and*
   first-class agent authorization in one protocol. Frameworks make you build the
   first; payment rails move money but decide nothing; mutuals decide claims by
   vote.
3. **The distribution surface is machine-readable.** `products.json` + a published
   schema + a documented HTTP API mean an outside agent can discover, price and buy
   cover with no browser and no hidden knowledge — proven by an independent-client
   test, not asserted.
4. **The hard part is being taken seriously.** Oracle centralisation (one bonded
   attestor in v1) is the honest weakness. The v2 contract adds an operator quorum
   and independent resolvers; it is built and proven locally (21/21) but **not
   deployed**.

## Twelve-month roadmap (realistic)

| Quarter | Goal | Honest dependency |
| --- | --- | --- |
| Q1 | Deploy v2 (operator quorum + resolvers) to testnet; open a public beta with one metric family | Funded operator identity; external review |
| Q2 | Second and third index families (temperature, an on-chain rate); a capacity/fee design | Metric definitions; legal review |
| Q3 | First paid pilot with one operator segment; fee switch behind a governance decision | A paying pilot; a legal wrapper for real money |
| Q4 | Third-party underwriting capital; external settlement oracle evaluation | Capital partners; oracle integration |

Each step past Q1 depends on something Overcover does not control yet. The roadmap
is a plan, not a promise.

## What is proven today (and what is not)

**Proven.** A live testnet contract; a reproducible bytecode ↔ source proof; real
human and agent purchases with on-chain hashes; a spending policy that refuses
before the network; a machine-readable catalogue validated against its schema by an
outside client; an accessible console with an end-to-end wallet-journey test.

**Not proven.** No mainnet deployment, no audit, no paying customer, no revenue, no
partnership, and no live third-party oracle. The one human acceptance step still
outstanding is a real browser-wallet extension approval — every other part of that
journey is tested end to end with the shipped page code.
