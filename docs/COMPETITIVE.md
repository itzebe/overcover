# Competitive landscape

How Overcover sits against the alternatives a judge or investor will compare it to.
Sources are primary (official docs/sites), fetched 2026-11-11. Where a claim is
about Overcover it is about the **shipped** product (v1 on testnet) and is backed
by the repository, not asserted.

## The alternatives

### Traditional parametric insurance (e.g. Arbol)

Arbol describes itself as a climate-risk underwriter: *"Arbol is at the forefront
of transforming how the world manages climate risk"* and reports *"$2+ Billion
Notional Risk Transferred"* and *"15+ Countries Utilizing Arbol Products"*
([arbolmarket.com](https://www.arbolmarket.com)). Parametric cover settles on a
measured index, but the contract, the capital and the payout decision live with a
regulated underwriter and its reinsurers — a counterparty a buyer must trust and a
process that is papered, permissioned and slow to onboard.

**Overcover vs this:** same settlement idea (an index, not a loss adjuster), but
the terms, the capital and the settlement rule are all in one auditable contract,
and a policy can be bought by a wallet or a software agent with no application,
no KYC desk and no counterparty relationship.

### On-chain discretionary mutuals (e.g. Nexus Mutual)

Nexus Mutual is *"an on-chain discretionary mutual. Members pool capital, buy
cover against on-chain and real world risks, underwrite that risk by staking NXM,
and decide claims and protocol changes through governance"*
([docs.nexusmutual.io](https://docs.nexusmutual.io)). It is the most mature
on-chain insurance model, but the operative word is **discretionary**: claims are
*decided* by member assessment and governance, and cover is sold under
product-specific wording. That is the opposite of Overcover's premise — Overcover
pays when a reading meets a number the buyer saw before purchase, with no vote.

**Overcover vs this:** parametric and deterministic. A disputed reading is the
only human step (in v1, the owner resolves; in v2, independent resolvers decide),
and even then the payout rule itself never changes.

### Decentralized insurance frameworks (e.g. Etherisc GIF)

Etherisc's *"Generic Insurance Framework (GIF)"* is *"a library of modular,
reusable, and secure smart contracts, written in Solidity"* for building
*"decentralized insurance products"* ([docs.etherisc.com](https://docs.etherisc.com)).
It is a **toolkit** — a builder assembles products on top of it. Overcover is the
opposite shape: one opinionated, small, complete protocol with a fixed lifecycle
and a console, not a framework you assemble.

### Optimistic oracles (e.g. UMA)

UMA is *"an optimistic oracle that resolves wide-ranging requests for information
in a scalable and reliable way"*, with *"two components: the optimistic oracle and
a dispute [resolution mechanism]"* ([docs.uma.xyz](https://docs.uma.xyz/protocol-overview/how-does-uma-work)).
It is general-purpose dispute infrastructure. Overcover does not try to be an
oracle for everything; it uses a **narrow, typed metric** (an index with a unit
and a trigger direction — the shipped default is a temperature trigger) with a
plausibility bound, which makes the reading cheap to verify and hard to game, and
reserves the dispute machinery for the rare challenge. Overcover could adopt an
oracle like UMA for the reading; today it uses a bonded attestor.

### Agent payment rails (e.g. x402)

x402 is *"an open, neutral standard for internet-native payments"*
([x402.org](https://www.x402.org/)) with first-class *"Agentic Accounts"* in the
Coinbase stack ([docs.cdp.coinbase.com/x402/welcome](https://docs.cdp.coinbase.com/x402/welcome)).
These solve **how an agent pays**. They do not solve **what the agent is allowed
to buy, or how a payout is decided**. Overcover's agent model is an
authorization-and-insurance layer above a rail like x402: the agent still needs
a policy that pays out on an objective event.

## Matrix

| Axis | Traditional parametric (Arbol) | Nexus Mutual | Etherisc GIF | UMA | x402 / agent rails | **Overcover** |
| --- | --- | --- | --- | --- | --- | --- |
| Product model | Underwritten policies | Discretionary mutual | Framework for builders | General oracle | Payments | One opinionated parametric protocol |
| Risk model | Index, reinsured | Pooled, member-assessed | Assembled per product | n/a (resolves facts) | n/a | Pooled, reserved per policy |
| Capital model | Insurer balance sheet | Staked NXM pool | Per-product | Bonded disputers | n/a | Single pool, `reserved ≤ capital` on-chain |
| Claims process | File a claim | Vote / assessment | Product-defined | Propose / dispute | n/a | Deterministic rule, optional bonded challenge |
| Settlement | Index reading | Governance decision | Product-defined | Oracle result | n/a | `value ≥ threshold` → reserved payout |
| Oracle assumption | Licensed data | Multiple | Configurable | Optimistic + dispute | n/a | One bonded attestor (v1) → operator quorum (v2) |
| Agent support | None native | None native | None native | None native | Payments only | First-class: own account, hard limits, audit |
| Transparency | Private contracts | On-chain protocol | On-chain contracts | On-chain oracle | On-chain payments | Every figure a live contract read |
| Main weakness | Counterparty, slowness | Discretion ≠ parametric | You must build it | Not a product | Not insurance | Testnet, unaudited, narrow metric |

## Where Overcover is genuinely different

1. **Deterministic + agent-native in one protocol.** No mature alternative pairs
   a parametric payout rule with a first-class, limit-bound autonomous buyer. The
   agent is not a wrapper on a UI; it is an account whose only on-chain power is
   `buy_cover` within limits a human sets.
2. **The honest-read console.** Every number on the page is a live contract read,
   and a failed read is shown as failed — not as a stale "live" figure. This is a
   trust property, and it is enforced by tests.
3. **Small and complete.** One pool, one lifecycle, one metric type. It can be
   read end to end in an afternoon, which is the point for a judge or an auditor.

## Where Overcover is weaker (stated plainly)

- **Scale and track record.** Arbol and Nexus Mutual have years of operation and
  real capital; Overcover is a testnet prototype with test funds.
- **Oracle decentralisation.** v1 has a single attestor. v2 (operator quorum,
  independent resolvers) is built and locally proven but not deployed.
- **Breadth.** A narrow catalogue (one typed metric in one shape; the shipped default is a single
  temperature product) where competitors cover many peril types and jurisdictions.
- **Regulatory posture.** None. It is not an insurance product and says so.

## What the research changes about positioning

- Lead with **deterministic settlement + agent authorization**, because that is
  the combination no incumbent offers, rather than with "insurance on-chain",
  which invites a direct and unfavourable comparison to Nexus Mutual's maturity.
- Frame the oracle roadmap as **v1 attested → v2 quorum**, because the honest
  weakness (one attestor) is also the clearest improvement path.
- Position against agent payment rails as **the layer above them**, not a
  competitor: x402 moves the premium, Overcover decides the payout.
