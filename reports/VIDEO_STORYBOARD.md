# Overcover company film — storyboard and narration script

**Deliverable:** `overcover-company-film.mp4` (master) and `overcover-company-film-web.mp4` (web).
**Target:** 1920×1080 · 16:9 · 30 fps · H.264/AAC · stereo. **Runtime:** ~3 min 09 s.
**Audience:** institutional investors, insurers and capital providers, NEAR ecosystem participants,
technical evaluators, strategic partners.

This is the single source of truth for the cut. It is implemented in `scenes.mjs` (narration and
shot list) and rendered by `build.mjs`. Every claim is grounded in `reports/VIDEO_CLAIM_VERIFICATION.md`.

## Creative direction

Premium infrastructure, not a hackathon pitch. The visual system is the console's own: field-green
(`#10251d`), paper (`#f6f4ee`), a single copper accent (`#8f4a12`) and a gold kicker (`#e0aa55`);
DejaVu Serif for display, DejaVu Sans for text, DejaVu Sans Mono for labels and identifiers. The
one thing the film should be remembered for: **restraint** — calm type, slow motion, real product
footage, and figures that are demonstrably from the chain.

Motion rules: designed cards hold perfectly still (type stays crisp); live console frames get a
slow 4–8 % Ken-Burns drift; scenes crossfade over 0.5 s. No stings, no zoom-punch, no text that
animates for its own sake.

## Narrative structure

| Scene | Title | Length | Purpose |
| --- | --- | --- | --- |
| 01 | The infrastructure problem | 16.7 s | Frame the trust/verification/capital problem. |
| 02 | Introducing Overcover | 20.1 s | What the company builds; the live console. |
| 03 | Why NEAR | 23.1 s | The real NEAR integration and deployed identity. |
| 04 | The product lifecycle | 25.0 s | Define → buy & reserve → observe → challenge → settle. |
| 05 | The customer journey, exercised | 36.4 s | The live purchase journey, and the on-chain purchase that proves it works. |
| 06 | Security and capital integrity | 30.0 s | Signed observations, quorum, bonds, invariant, TEE honesty. |
| 07 | Architecture and differentiation | 27.2 s | It is infrastructure, not a frontend. |
| 08 | Overcover | 13.7 s | Minimal close: what it is, where to verify it. |

## Shot-by-shot script

### Scene 01 — The infrastructure problem (16.7 s)
- **Shot 1 (7.0 s)** — Title card *OVERCOVER — capital-backed parametric insurance infrastructure /
  Built on NEAR · Testnet*.
- **Shot 2 (9.7 s)** — Live console hero, slow push in.
- **Narration:** *"Parametric insurance pays out when a measurable condition is met. But someone
  still has to be trusted to observe that condition, to judge the claim, and to hold the capital.
  Overcover replaces that trust with infrastructure — a capital-backed risk mutual that runs on
  NEAR."*

### Scene 02 — Introducing Overcover (20.1 s)
- **Shot 1 (7.0 s)** — Live "Cover available now" strip.
- **Shot 2 (6.3 s)** — Live product cards.
- **Shot 3 (6.8 s)** — Live "From buying cover to getting paid".
- **Narration:** *"Overcover is parametric insurance infrastructure. Each product is an immutable,
  machine-readable risk — a city, an index, a trigger, a payout. Capital is pooled against those
  promises, and every policy is backed by reserved funds before it is sold. This is the live
  console, reading the contract directly."*

### Scene 03 — Why NEAR (23.1 s)
- **Shot 1 (8.2 s)** — Designed card: network **NEAR testnet**, contract
  `contract.ovc-v3-ctl-2f6c4c.testnet`, code hash `CQR8x1kWkr2z…`, runtime near-sdk 5.
- **Shot 2 (7.3 s)** — Live "Check it for yourself" proof section.
- **Shot 3 (7.6 s)** — Live pool figures.
- **Narration:** *"Overcover is built on NEAR. The entire product is one Rust smart contract — the
  financial authority and the only source of truth. It holds the capital, issues policies, verifies
  signed observations, runs disputes, and settles. Here it is on NEAR testnet, with its deployed
  code hash. Every figure in this film can be reproduced from the public chain."*

### Scene 04 — The product lifecycle (25.0 s)
- **Shot 1 (9.3 s)** — Designed card: five lifecycle steps.
- **Shot 2 (6.8 s)** — Live "how a claim settles".
- **Shot 3 (6.2 s)** — Live "Policies written".
- **Shot 4 (6.2 s)** — Live "Observations & disputes".
- **Narration:** *"A policy's life is deterministic. A product defines the risk. Cover is bought, and
  the payout is reserved from the pool at that moment. An operator submits a signed index reading,
  and a quorum of operators must independently sign the same reading before it is accepted. Anyone
  can challenge it with a bond. An independent resolver settles the dispute. And settlement itself
  is a single comparison, run exactly once."*

### Scene 05 — The customer journey, exercised (36.4 s)
- **Shot 1 (7.8 s)** — Designed card: the four journey steps (Discover → Select & quote → Buy → Policy).
- **Shot 2 (7.8 s)** — Live product selection (`heat-lagos`: trigger 40.0 °C, premium 5.00 %).
- **Shot 3 (7.3 s)** — Live contract quote (premium 0.0150 NEAR; payout reserved 0.30 NEAR).
- **Shot 4 (7.3 s)** — Live purchase surface ("Buy this cover with your own wallet"; destination
  `contract.ovc-v3-ctl-2f6c4c.testnet · verified hardened module`).
- **Shot 5 (6.8 s)** — Live policy register (policies with the contract's own status).
- **Shot 6 (9.0 s)** — Designed card: the verified on-chain purchase (contract, `buy_cover`,
  resulting policy #3 `active`, transaction `45A1s3hz…`), with the honest flag that it was signed by
  the project's agent and that a human-wallet purchase is the outstanding acceptance step.
- **Narration:** *"This is the customer journey, captured on the live console. A buyer discovers the
  catalogue, reads the terms, and the contract quotes the price — five percent of the payout, fixed
  in code, not by the page. One buy_cover is signed, and a policy is issued with its payout reserved
  from the pool before it is sold. That path is real and verifiable: policy three on the hardened
  contract is active on-chain, with reserved capital behind it. The signature is the one step a
  headless browser cannot make — the console is ready for a person to sign this same call in their
  own wallet, and that human acceptance step is the next milestone."*

### Scene 06 — Security and capital integrity (30.0 s)
- **Shot 1 (9.8 s)** — Designed card: six controls + the TEE honesty note.
- **Shot 2 (6.7 s)** — Live "Observations & disputes".
- **Shot 3 (6.2 s)** — Live "What is live, what is not, and what is blocked".
- **Shot 4 (5.7 s)** — Live pool figures.
- **Narration:** *"The hard question is not receiving an observation — it is accepting it as
  trustworthy. Readings are cryptographically signed. A quorum of distinct operators must agree.
  Disputes are bonded. Settlement is deterministic. And after every state change, the contract
  enforces that reserved capital never exceeds the pool. An attestation prototype can prove that
  code ran inside a secure enclave — but execution integrity is not proof that an observation is
  true. That distinction is the security model."*

### Scene 07 — Architecture and differentiation (27.2 s)
- **Shot 1 (10.7 s)** — Designed card: observation sources → NEAR contract → clients, with the
  invariant stated.
- **Shot 2 (5.6 s)** — Live "insurance factory".
- **Shot 3 (5.6 s)** — Live agent console.
- **Narration:** *"Overcover is infrastructure, not an interface. External sources feed signed
  observations into the contract. The contract holds the truth: the products, the policies, the
  pool, and the observations. Disputes and settlement execute on-chain. And the capital accounting
  is enforced by invariant, not by policy. A console, an autonomous agent, and a permissionless
  factory all read and write the same contract — through the same rules."*

### Scene 08 — Overcover (13.7 s)
- **Shot 1 (6.1 s)** — Live console hero, slow pull back.
- **Shot 2 (9.1 s)** — Designed close card: console URL, contract id, `npm run verify:proof`.
- **Narration:** *"Overcover. Capital-backed parametric insurance infrastructure on NEAR. On testnet,
  unaudited, and built to be verified — not trusted. Reproduce every figure yourself at overcover dot
  vercel dot app."*

## What the film deliberately does not say

See `reports/VIDEO_CLAIM_VERIFICATION.md` → "Deliberately NOT claimed". In short: no endorsement,
funding or partnership; no users, revenue, policies-sold or capital-under-management figures; no
"audited"; the TEE layer is labelled a prototype; and the closing scene states plainly that the
deployment is testnet and unaudited.

It also does **not** claim a human-wallet purchase. Scene 05 shows the live journey and the real
on-chain purchase, and states on the card that the purchase was **signed by the project's agent**,
with the human-wallet signature named as the outstanding acceptance step. The full evidence, and why
the earlier "human" purchase (legacy v1 tx `87n1pdeA…`) is **not** a human-wallet purchase, is in
`reports/VIDEO_CUSTOMER_JOURNEY_EVIDENCE.md`.
