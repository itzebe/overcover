# Ecosystem funding — verified programs and drafted application

> Status: **research + draft**. Nothing here has been submitted. Submitting an
> application is an externally-visible action that requires the founder's
> authority (personal details, contact handles, a NEAR wallet for airdrops, and
> file uploads). The draft below is prepared so submission is a copy-paste.

## Verified programs

| Program | What it offers | How to apply | Verified |
| --- | --- | --- | --- |
| **NEAR Agentic Accelerator** (via NEAR Founder Hub) | Cohort-based program: education, product iteration, storytelling, token design; technical support; founder-friendly terms | Airtable form `airtable.com/appc0ZVhbKj8hMLvH/pagVX3hSxzIj4Y680/form` | 2026-11-13 |
| **NEAR Protocol Rewards** | Merit-based, on-chain builder incentives; **up to $10,000 / month** during the program; mentorship; visibility | Airtable form `airtable.com/appFoIqAoY0ikoVIb/shr4u30KcGeNJwhKu`; criteria doc `docs.google.com/document/d/17ebf1XHaiXAK13zO7JPZ2NrL2WVKZzZd1ZL321SxdFc` | 2026-11-13 |
| **NEAR Founder Hub** | Hub linking both of the above plus hackathons and Horizon | `near.org/founder-hub` | 2026-11-13 |
| **NEAR Horizon / Builder Perks** | Program hub and perks | `near-horizon.notion.site/Builder-Perks-cb5e5f55870c4c5da6bf9f72fbae35a9` | 2026-11-13 |
| **NEAR Protocol Rewards repo** | Program mechanics, on-chain scoring | `github.com/near-horizon/near-protocol-rewards` | 2026-11-13 |

Notes:
- `neartreasury.com` is **no longer actively maintained** (redirects to Trezu). Not a funding route.
- `dev.near.org` is DNS-dead. Do not cite it.

### Protocol Rewards scoring (100 pts, threshold 70)

| Category | Weight |
| --- | --- |
| Idea Potential & Development | 60 |
| Developer Skills & Experience | 20 |
| Referrals & Stakeholder Endorsements | 10 |
| History of Participation & Contributions | 10 |

Stage scoring rewards a **fully functional product with users** (16–20 of 20 in
"Feasibility & Development Stage"). Overcover is a live testnet product with a
passing verification suite; that is the honest stage to claim.

---

## Draft: NEAR Agentic Accelerator application

Fields marked **[human]** need the founder's own words or details and must not be
invented. Everything else is grounded in the repository and the live deployment.

**Cohort:** 2025 NEAR Agentic Accelerator

**Applicant / Founder Information** — *[human]*: First name, Last name, Email,
LinkedIn, Telegram, Twitter, and a NEAR wallet address for any airdrop.

### Tell us more about yourself and your journey to date

**Roles of each team member and backgrounds** — *[human]* (personal history).

**Most impressive things built/achieved** — candidate, grounded:

> Built Overcover, a parametric risk mutual on NEAR: a `near-sdk` 5 smart
> contract with multi-operator oracle quorum, bonded disputes with an independent
> resolver, and deterministic settlement; an executable reference model that
> defends **74/74** adversarial scenarios with **0 exploitable**; **83** Rust
> contract unit tests; a dependency-free browser console; and a reproducible
> on-chain evidence chain (**13/13** proof checks over 18 real testnet
> transactions). Added an attested-observation POC that binds an external
> reading to a pinned WASM build executed in an **Intel TDX** enclave, verified
> with the official `dcap-qvl` verifier.

**Outside-of-work deep-dive** — *[human]*.

**Turned-around dead end** — *[human]*.

### Crypto / AI interest

**Why crypto/AI** — *[human]* (must be personal).

**Most bullish project / bearish take** — candidate, grounded:

> Bullish on NEAR's intent- and agent-centric stack: verifiable off-chain
> execution (TEE-shielded agents) plus cheap on-chain settlement is the
> combination autonomous commerce needs. Bearish on parametric "insurance"
> products that settle on an operator's say-so rather than on objective,
> independently verifiable data — which is exactly the failure mode Overcover is
> built to avoid.

**Most proud of in crypto/AI** — candidate:

> Building and independently verifying Overcover's accounting invariants (reserved
> capital can never exceed available backing) and reproducing the whole insurance
> lifecycle on testnet with real transaction hashes rather than mockups.

### Project Information

**Project name:** Overcover

**Stage:** Live-no-users (live on NEAR testnet; verified end to end; no paying users yet)

**Website:** https://overcover.vercel.app/

**What are you building:**

> Overcover is programmable **parametric insurance** for autonomous businesses,
> on NEAR. An on-chain pool writes fully-collateralised cover against objective
> public indices (e.g. weather) and settles it autonomously. Coverage is an
> immutable, machine-readable product: contract-enforced premium, reserved
> payout capital, and deterministic settlement. Readings come from a
> multi-operator oracle quorum that signs external observations; a bonded
> challenge window and an independent resolver settle disputes. Both humans
> (browser wallet) and autonomous agents (an agent service with spending limits)
> can buy cover. Blockchain is load-bearing: capital custody, premium pricing,
> reserved payouts, quorum, and settlement all live in the contract.

**Why doesn't this exist yet / unique insight:**

> Parametric cover has historically failed on two fronts: trust in the oracle and
> capital efficiency. Overcover's insight is to make the observation itself
> verifiable — signed by a quorum, challengeable with a bond, and resolvable by
> an independent party — and to make the product machine-readable so an
> autonomous agent can buy cover without a human in the loop. Recent TEE
> attestation (e.g. Intel TDX quotes) now lets an operator prove *how* a reading
> was produced, not merely *who* asserted it; Overcover's POC demonstrates that
> binding end to end.

**Competitors:** Nexus Mutual, Etherisc, Arbol (parametric weather), and
on-chain option protocols. Difference: Overcover is agent-first, objective-index
based, and settles from signed observations with a bonded dispute path, rather
than discretionary claims assessment.

**What success looks like:**

> A live mainnet pool writing cover against one or more objective indices,
> purchased by both human wallets and autonomous agents, with all settlements
> resolved from independently verifiable observations and disputes exercised at
> least once end to end.

**Top goals for the Accelerator:**

> (1) A mainnet deployment and a first real risk taker; (2) guidance on token /
> incentive design for a risk mutual; (3) legal/regulatory framing for
> parametric cover; (4) integrations with NEAR agent infrastructure.

**Why the Shade Agents Framework is beneficial:**

> Overcover's weakest link is the oracle operator: today its signature proves
> *who* signed, not *how* the reading was produced. Shade Agents run agent code
> inside a TEE with a NEAR-native identity — exactly the property needed to make
> an observation operator verifiable. Overcover's POC already binds a reading to
> a pinned WASM build executed in an Intel TDX enclave and verifies the quote
> with `dcap-qvl`; adopting Shade Agents would give that operator a first-class
> NEAR identity and a supported runtime.

**How you plan to integrate Shade Agents:**

> Run the observation operator and the autonomous purchasing agent as Shade
> Agents: the operator fetches and normalises a reading inside the TEE, its
> attestation binds the WASM/input/output, and it signs the contract's
> `readingMessageV3` with a TEE-derived key. The purchasing agent runs with
> enforced spending limits against the live product catalogue.

**Active partnerships:** None yet — *[human]* for anything to add.

**Have you raised funding:** No. No grants or hackathon winnings to date.
*(This submission is itself a NEAR Hackathon 2026 entry; if a result is awarded
before applying, list it here.)*

**Uploads** — *[human]*: pitch deck (`docs/PITCH.md`), demo (`docs/DEMO.md`,
`demo-log.json`), architecture (`docs/ARCHITECTURE.md`).

### Other

**How did you hear about the Accelerator:** *[human]* (e.g. NEAR Hackathon 2026).

**Referrer:** *[human]*.

**What else should we know:**

> The entire project is reproducible: `npm test` runs the model (74 attacks),
> Rust unit tests (83), the console regressions, the agent, and the deploy
> harness; `npm run verify:proof` re-resolves every recorded testnet
> transaction. Nothing in the UI is fabricated; every number is contract state.

**Privacy Policy:** must be accepted by the applicant — *[human]*.

---

## Draft: NEAR Protocol Rewards application (shorter)

**Project:** Overcover — parametric risk mutual on NEAR
**Stage:** Live on testnet, fully functional, verification suite passing
**Repository:** https://github.com/itzebe/overcover
**Website:** https://overcover.vercel.app/

**What it is / impact:** *[as the "What are you building" answer above]*

**Evidence of shipping:** 83 Rust contract tests; 74/74 model attack scenarios
defended; 13/13 on-chain proof checks; 18 real testnet transactions in
`demo-log.json`; accessibility gate at 0 violations across 7 viewports.

**What rewards would fund:** mainnet deployment, a first external risk taker, and
Shade Agents integration for the observation operator.

---

## What requires human authority (do not automate)

- Personal-identity fields, contact handles, and the NEAR wallet address.
- The privacy-policy consent and the actual submission.
- Any claim of partnerships, funding, referrals, or hackathon results.
