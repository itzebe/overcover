// STORYBOARD + SCRIPT — single source of truth for the Overcover company film.
//
// Every claim in `narrate` is grounded in evidence listed in CLAIM-VERIFICATION.md.
// Nothing here is invented: figures, contract ids and hashes are the ones the
// live system returns (verified with `npm run verify:proof`).
//
// A scene is a list of shots. A shot is:
//   { img, sec, kb }  a still (card or live console frame) with Ken-Burns motion
//   kb: { z:[from,to], x:[from,to], y:[from,to] }  (fractions of the frame)
//   { card }          a full-bleed designed card (already 1920x1080)
//
// Palette and type roles mirror the console (video/build.mjs).

export const SCENES = [
  {
    id: "01-open",
    title: "The infrastructure problem",
    narrate:
      "Parametric insurance pays out when a measurable condition is met. But someone still has to be trusted to observe that condition, to judge the claim, and to hold the capital. Overcover replaces that trust with infrastructure — a capital-backed risk mutual that runs on NEAR.",
    shots: [
      { card: "open", sec: 7.0 },
      { img: "frames/01-hero.png", sec: 8.5, kb: { z: [1.0, 1.08], x: [0.5, 0.5], y: [0.35, 0.5] } },
    ],
  },
  {
    id: "02-product",
    title: "Introducing Overcover",
    narrate:
      "Overcover is parametric insurance infrastructure. Each product is an immutable, machine-readable risk — a city, an index, a trigger, a payout. Capital is pooled against those promises, and every policy is backed by reserved funds before it is sold. This is the live console, reading the contract directly.",
    shots: [
      { img: "frames/02-cover.png", sec: 6.5, kb: { z: [1.0, 1.06], x: [0.5, 0.45], y: [0.5, 0.5] } },
      { img: "frames/03-products.png", sec: 6.0, kb: { z: [1.05, 1.0], x: [0.5, 0.55], y: [0.5, 0.45] } },
      { img: "frames/04-how.png", sec: 6.5, kb: { z: [1.0, 1.05], x: [0.5, 0.5], y: [0.4, 0.5] } },
    ],
  },
  {
    id: "03-near",
    title: "Why NEAR",
    narrate:
      "Overcover is built on NEAR. The entire product is one Rust smart contract — the financial authority and the only source of truth. It holds the capital, issues policies, verifies signed observations, runs disputes, and settles. Here it is on NEAR testnet, with its deployed code hash. Every figure in this film can be reproduced from the public chain.",
    shots: [
      { card: "near", sec: 8.0 },
      { img: "frames/12-proof.png", sec: 7.0, kb: { z: [1.0, 1.06], x: [0.5, 0.5], y: [0.45, 0.5] } },
      { img: "frames/11-figs.png", sec: 6.5, kb: { z: [1.06, 1.0], x: [0.5, 0.5], y: [0.5, 0.45] } },
    ],
  },
  {
    id: "04-lifecycle",
    title: "The product lifecycle",
    narrate:
      "A policy's life is deterministic. A product defines the risk. Cover is bought, and the payout is reserved from the pool at that moment. An operator submits a signed index reading, and a quorum of operators must independently sign the same reading before it is accepted. Anyone can challenge it with a bond. An independent resolver settles the dispute. And settlement itself is a single comparison, run exactly once.",
    shots: [
      { card: "lifecycle", sec: 9.0 },
      { img: "frames/04-how.png", sec: 6.5, kb: { z: [1.0, 1.06], x: [0.45, 0.5], y: [0.5, 0.45] } },
      { img: "frames/07-policies.png", sec: 6.0, kb: { z: [1.05, 1.0], x: [0.5, 0.5], y: [0.5, 0.45] } },
      { img: "frames/08-observations.png", sec: 6.0, kb: { z: [1.0, 1.05], x: [0.5, 0.45], y: [0.45, 0.5] } },
    ],
  },
  {
    id: "05-security",
    title: "Security and capital integrity",
    narrate:
      "The hard question is not receiving an observation — it is accepting it as trustworthy. Readings are cryptographically signed. A quorum of distinct operators must agree. Disputes are bonded. Settlement is deterministic. And after every state change, the contract enforces that reserved capital never exceeds the pool. An attestation prototype can prove that code ran inside a secure enclave — but execution integrity is not proof that an observation is true. That distinction is the security model.",
    shots: [
      { card: "security", sec: 9.5 },
      { img: "frames/08-observations.png", sec: 6.5, kb: { z: [1.0, 1.06], x: [0.5, 0.5], y: [0.45, 0.5] } },
      { img: "frames/13-status.png", sec: 6.0, kb: { z: [1.05, 1.0], x: [0.5, 0.5], y: [0.5, 0.45] } },
      { img: "frames/11-figs.png", sec: 5.5, kb: { z: [1.0, 1.05], x: [0.45, 0.5], y: [0.5, 0.5] } },
    ],
  },
  {
    id: "06-architecture",
    title: "Architecture and differentiation",
    narrate:
      "Overcover is infrastructure, not an interface. External sources feed signed observations into the contract. The contract holds the truth: the products, the policies, the pool, and the observations. Disputes and settlement execute on-chain. And the capital accounting is enforced by invariant, not by policy. A console, an autonomous agent, and a permissionless factory all read and write the same contract — through the same rules.",
    shots: [
      { card: "architecture", sec: 10.5 },
      { img: "frames/09-factory.png", sec: 5.5, kb: { z: [1.0, 1.06], x: [0.5, 0.5], y: [0.45, 0.5] } },
      { img: "frames/10-agent.png", sec: 5.5, kb: { z: [1.05, 1.0], x: [0.5, 0.5], y: [0.5, 0.45] } },
    ],
  },
  {
    id: "07-close",
    title: "Overcover",
    narrate:
      "Overcover. Capital-backed parametric insurance infrastructure on NEAR. On testnet, unaudited, and built to be verified — not trusted. Reproduce every figure yourself at overcover dot vercel dot app.",
    shots: [
      { img: "frames/01-hero.png", sec: 6.0, kb: { z: [1.08, 1.0], x: [0.5, 0.5], y: [0.5, 0.45] } },
      { card: "close", sec: 9.0 },
    ],
  },
];
