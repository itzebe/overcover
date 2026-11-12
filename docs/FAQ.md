# FAQ — honest answers to the hard questions

## Is this just a weather bet?

No. A bet lets either side choose the terms to gamble. Here the **product** — set by the pool owner,
not the buyer — fixes the index, the trigger and the payout, and it is immutable. A buyer can only
choose a payout within the product's bounds and an observation date. Parametric insurance is a
standard category: cover pays on an objective index rather than on an assessed loss, precisely
because it needs no adjuster. The demo uses rainfall on the legacy address and a temperature
trigger on the hardened default; both are free, public and verifiable, and the
mechanism is index-agnostic.

## Who is the buyer?

A business whose revenue or cost is tied to a public index, and which is operated by software: a
delivery or cold-chain fleet, an event organiser, an energy or compute broker. The point is not that
these businesses are exotic — it is that an **autonomous** operator cannot complete a traditional
insurance application, and cannot wait weeks for an adjuster.

## Why would anyone underwrite?

A provider deposits NEAR and earns the premiums. Their capital is only reserved while a policy is
active, and they can withdraw any capital that is **not** reserved (`withdraw` refuses only when it
would break `reserved ≤ capital`). The upside is premium yield; the risk is that a covered event
occurs, and that risk is capped because every payout is fully collateralised and reserved up front.

## What if the oracle lies?

Anyone can challenge a reading with a bond (`challenge_observation`). A disputed reading **cannot
settle a policy**. The owner resolves (`resolve_dispute`): upholding the reading forfeits the
challenger's bond into the pool; rejecting it nullifies the reading and returns the bond. Both
outcomes are in the live demo. This is a bonded mechanism, not a trust assumption — though it still
relies on the owner to resolve, which is the centralisation we would remove next (see the roadmap).

## What if the owner is malicious?

The owner can publish products, rotate the attestor, pause purchases, and resolve disputes. The owner
has **no method to move pool capital**. The only payout path is `resolve`, which pays iff a valid,
undisputed, non-nullified signed reading meets the immutable product's threshold. So the worst a
malicious owner can do is stop new business and decide disputes — not drain the pool.

## Is the index real?

The driver reads **Open-Meteo** (a free, keyless public API), cross-checks the current reading
against the hourly series, and refuses to sign if they differ by more than 0.5 mm. The signed value
is what the contract verifies. In the recorded demo the reading is genuine but **pinned** to the
value the threshold was derived from, so the outcome is deterministic — that is stated openly, not
hidden.

## Why NEAR?

Fast finality (a claim settles in seconds), low fees (small parametric payouts stay economic), a
cheap `env::ed25519_verify` host function (a signed oracle is a first-class primitive), and a free
testnet with faucet-funded accounts. None of the critical path needs paid infrastructure.

## Isn't parametric insurance / on-chain insurance already a thing?

Yes — parametric insurance exists off-chain, and discretionary-claims mutuals exist on-chain. What
is less common, and what this project argues for, is the **combination**: fully-collateralised
reserves, **immutable** product terms (no discretion at claim time), and a **bonded, challengeable**
oracle — so neither the operator nor the oracle can quietly decide an outcome. Whether that
combination is genuinely novel in the market is a claim a judge should test; what is verifiable here
is that the mechanism works end to end on-chain.

## What is the business model?

Not implemented. The natural one is a small protocol fee on premium, paid to the pool operator.
Being honest: there is no fee mechanism in the contract today, and no token.

## Roadmap, in priority order

1. **Decentralise the attestor** — replace the single key with a threshold of independent signers,
   and replace owner-resolved disputes with a bonded resolution rule.
2. **Multiple index sources** — median across independent feeds before signing.
3. **More index types** — temperature, wind, air quality, and non-weather feeds (network uptime,
   price feeds) as new immutable products, without changing the contract.
4. **Mainnet + audit** — the contract is unaudited and testnet-only today.

## Which track does this fit?

**Business** (primary) — a business that an autonomous operator can buy. **Swarms** — the buyer is an
agent-operated business, and cover is machine-readable end to end. **DeFi** — an underwriting pool
with an enforced solvency invariant.

## What is deliberately *not* built?

A token, a governance module, a UI wallet, and a fee. Each would add surface without strengthening
the central claim: that a pool can write and settle cover with no underwriter and no claims queue,
and prove it.
