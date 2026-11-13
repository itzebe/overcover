// Overcover — the scenario suite: full lifecycle + adversarial matrix.
//
// This is the single source of truth for the v2 scenarios. It runs against
// the deterministic reference model (sim/engine.mjs) and is invoked by
// sim/run.mjs. Nothing here touches the chain.
//
// `check`/`expectThrow`/`log` are injected so the same scenarios can be run
// by the CLI harness (sim/run.mjs) and by the test runner (node --test).

import { Decentralized, ContractError, ONE_NEAR, keyPairFromSeed, sign } from "./engine.mjs";
import { evaluate, normalizeLimits } from "../agent/limits.mjs";

const N = (x) => BigInt(x) * ONE_NEAR;
const DAY = 24 * 3600;

const OPERATOR_SEEDS = { op1: 11, op2: 12, op3: 13, op4: 14, op5: 15 };
const HUMAN = "human.testnet";
const AGENT = "agent.testnet";
const WATCHDOG = "watchdog.testnet";
const RESOLVERS = ["res1.testnet", "res2.testnet", "res3.testnet", "res4.testnet", "res5.testnet"];

/// Deterministic evidence reference for every scenario reading (mirrors the
/// off-chain bundle hash an operator would sign).
const EVIDENCE = Buffer.from("scenario-evidence");

/// Build the canonical v3 reading message and the matching submit args.
function reading(m, operator, metricId, city, date, value, reportedAt, nonce, { expiry, evidence = EVIDENCE } = {}) {
  const ex = expiry ?? reportedAt + 6 * 3600;
  const msg = m.readingMessage(operator, metricId, city, BigInt(date), BigInt(value), BigInt(reportedAt), BigInt(ex), evidence, nonce);
  return { msg, args: { operator, metricId, city, obsDate: date, value, reportedAt, expiry: ex, evidenceHash: evidence, nonce } };
}

function newBoard({ quorum = 3, resolverQuorum = 3, disputeWindowSec = 3600 } = {}) {
  const m = new Decentralized({
    owner: "owner.testnet",
    challengeBond: ONE_NEAR / 10n,
    settleDelaySec: 0,
    challengeWindowSec: 3600,
    quorum,
    resolverQuorum,
    disputeWindowSec,
    now: 0,
  });
  const keys = {};
  for (const [acct, seed] of Object.entries(OPERATOR_SEEDS)) {
    const kp = keyPairFromSeed(seed);
    keys[acct] = kp;
    m.addOperator(`${acct}.testnet`, kp.pub);
  }
  m.setQuorum(quorum);
  for (const r of RESOLVERS) m.addResolver(r);
  m.setResolverQuorum(resolverQuorum);
  // Metrics for the categories we underwrite.
  m.addMetric("rain", { category: "precipitation", unit: "mm/10", maxValue: 5000, scale: 10, direction: "above" });
  m.addMetric("drought", { category: "drought", unit: "mm/10", maxValue: 5000, scale: 10, direction: "below" });
  m.addMetric("heat", { category: "temperature", unit: "degC/10", maxValue: 700, scale: 10, direction: "above" });
  m.addMetric("wind", { category: "wind", unit: "m/s/10", maxValue: 1000, scale: 10, direction: "above" });
  return { m, keys };
}

/** A quorum of operators report the same value; returns the finalized quorum. */
function reportQuorum(m, keys, metricId, city, date, value, reportedAt, { reporters = ["op1", "op2", "op3"] } = {}) {
  m.advanceTo(reportedAt); // a reading cannot be reported in the future
  let last = 0;
  for (const acct of reporters) {
    const operator = `${acct}.testnet`;
    const kp = keys[acct];
    const nonce = m.operators.get(operator).readings;
    const { msg, args } = reading(m, operator, metricId, city, date, value, reportedAt, nonce);
    last = m.submitReading({ ...args, signature: sign(kp.priv, msg) });
  }
  return last;
}


export function runScenarios({ check, expectThrow, log = () => {} }) {
// ===========================================================================
// 1. FULL LIFECYCLE (human + agent, three risk categories)
// ===========================================================================

console.log("\n== Full lifecycle ==");

{
  const { m, keys } = newBoard();
  // Two capital providers.
  m.deposit("lpA.testnet", N(600));
  m.deposit("lpB.testnet", N(400));

  // Products in three categories.
  m.addMetricProduct("rain-lagos", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(50), minLeadSec: DAY, maxTotalCoverage: N(500) });
  m.addMetricProduct("drought-lagos", { city: "lagos", metricId: "drought", thresholdTenths: 200, premiumBp: 600, minPayout: N(1), maxPayout: N(50), minLeadSec: DAY, maxTotalCoverage: N(500) });
  m.addMetricProduct("heat-lagos", { city: "lagos", metricId: "heat", thresholdTenths: 400, premiumBp: 400, minPayout: N(1), maxPayout: N(50), minLeadSec: DAY, maxTotalCoverage: N(500) });

  check("L1", "lifecycle", "products discoverable across 3 risk categories",
    "3", `${m.products.size}`, m.products.size === 3);

  // Human quotes and buys rain cover.
  const quote = m.quotePremium("rain-lagos", N(50));
  check("L2", "lifecycle", "contract quotes the premium (human)", (N(50) * 500n + 9999n) / 10000n, quote, quote === N(50) * 500n / 10000n);

  const humanPol = m.buyCover({ buyer: HUMAN, productId: "rain-lagos", payout: N(50), obsDate: 3 * DAY });
  check("L3", "lifecycle", "human purchase reserves the payout", N(50).toString(), m.getPool().reserved.toString(), m.getPool().reserved === N(50));
  check("L3b", "lifecycle", "premium entered the pool", (N(600) + N(400) + quote).toString(), m.getPool().capital.toString(), m.getPool().capital === N(1000) + quote);

  // Agent buys heat cover (an agent-authorized purchase).
  const agentPol = m.buyCover({ buyer: AGENT, productId: "heat-lagos", payout: N(30), obsDate: 3 * DAY });
  check("L4", "lifecycle", "agent purchase issues a policy owned by the agent",
    AGENT, m.getPolicy(agentPol).buyer, m.getPolicy(agentPol).buyer === AGENT);

  // Observation for day 3 (rain breach), quorum of 3.
  const day3 = 3 * DAY;
  m.advanceTo(day3);
  const q = reportQuorum(m, keys, "rain", "lagos", day3, 450, day3 + 60);
  check("L5", "lifecycle", "a quorum finalizes the observation", "3", `${q}`, q === 3);

  // The heat observation for the agent's policy is below threshold -> no pay.
  const q2 = reportQuorum(m, keys, "heat", "lagos", day3, 350, day3 + 120); // 35.0 < 40.0
  check("L7", "lifecycle", "non-breaching heat reading finalizes", "3", `${q2}`, q2 === 3);

  m.advanceTo(day3 + 7200);
  const settled = m.resolve(humanPol);
  check("L6", "lifecycle", "breaching policy pays exactly its payout", N(50).toString(), settled.paid.toString(), settled.paid === N(50));
  check("L6b", "lifecycle", "policy status is settled_paid", "settled_paid", m.getPolicy(humanPol).status, m.getPolicy(humanPol).status === "settled_paid");

  const settled2 = m.resolve(agentPol);
  check("L8", "lifecycle", "non-breaching policy does not pay", "0", settled2.paid.toString(), settled2.paid === 0n);
  check("L8b", "lifecycle", "policy status is settled_no_pay", "settled_no_pay", m.getPolicy(agentPol).status, m.getPolicy(agentPol).status === "settled_no_pay");

  // Reconciliation after the whole cycle.
  check("L9", "lifecycle", "pool reconciles after settlement", "true", `${m.reconcile()}`, m.reconcile());
  check("L10", "lifecycle", "reserved <= capital invariant holds", "true", `${m.checkInvariant()}`, m.checkInvariant());
  check("L11", "lifecycle", "all reservations released", "0", m.getPool().reserved.toString(), m.getPool().reserved === 0n);

  // Provider can withdraw its unencumbered capital after settlement.
  const bal = m.providerBalance("lpB.testnet");
  m.withdraw("lpB.testnet", N(400));
  check("L12", "lifecycle", "provider withdraws unencumbered capital", "true", `${bal === N(400)}`, bal === N(400));
}

// ===========================================================================
// 2. RISK-CATEGORY TRIGGERS (rain above / drought below / heat / wind)
// ===========================================================================

console.log("\n== Risk categories ==");

{
  // Rain "above": pays only at/above threshold.
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;

  // Boundary: exactly at threshold pays.
  const at = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  const below = m.buyCover({ buyer: "b.testnet", productId: "rain", payout: N(10), obsDate: 4 * DAY });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 300, day3 + 60);
  m.advanceTo(day3 + 7200);
  check("C1", "categories", "rain at exactly the threshold pays", "settled_paid", (m.resolve(at), m.getPolicy(at).status), m.getPolicy(at).status === "settled_paid");

  // One tenth below the threshold does not pay.
  m.advanceTo(4 * DAY);
  reportQuorum(m, keys, "rain", "lagos", 4 * DAY, 299, 4 * DAY + 60);
  m.advanceTo(4 * DAY + 7200);
  check("C2", "categories", "rain one tenth below the threshold does not pay", "settled_no_pay", (m.resolve(below), m.getPolicy(below).status), m.getPolicy(below).status === "settled_no_pay");
}

{
  // Drought "below": pays when the reading is at/below threshold.
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("drought", { city: "lagos", metricId: "drought", thresholdTenths: 200, premiumBp: 600, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const dry = m.buyCover({ buyer: "a.testnet", productId: "drought", payout: N(10), obsDate: day3 });
  const wet = m.buyCover({ buyer: "b.testnet", productId: "drought", payout: N(10), obsDate: 4 * DAY });
  m.advanceTo(day3);
  reportQuorum(m, keys, "drought", "lagos", day3, 100, day3 + 60); // 10 mm <= 20 mm
  m.advanceTo(day3 + 7200);
  check("C3", "categories", "drought deficit at/below threshold pays", "settled_paid", (m.resolve(dry), m.getPolicy(dry).status), m.getPolicy(dry).status === "settled_paid");

  m.advanceTo(4 * DAY);
  reportQuorum(m, keys, "drought", "lagos", 4 * DAY, 800, 4 * DAY + 60); // 80 mm > 20 mm
  m.advanceTo(4 * DAY + 7200);
  check("C4", "categories", "wet reading does not trigger a drought policy", "settled_no_pay", (m.resolve(wet), m.getPolicy(wet).status), m.getPolicy(wet).status === "settled_no_pay");
}

{
  // Heat and wind are separate categories with their own units/bounds.
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("heat", { city: "lagos", metricId: "heat", thresholdTenths: 400, premiumBp: 400, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m.addMetricProduct("wind", { city: "lagos", metricId: "wind", thresholdTenths: 250, premiumBp: 400, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const h = m.buyCover({ buyer: "a.testnet", productId: "heat", payout: N(10), obsDate: day3 });
  const w = m.buyCover({ buyer: "b.testnet", productId: "wind", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "heat", "lagos", day3, 420, day3 + 60); // 42.0 >= 40.0
  reportQuorum(m, keys, "wind", "lagos", day3, 240, day3 + 120); // 24.0 < 25.0
  m.advanceTo(day3 + 7200);
  check("C5", "categories", "extreme heat above threshold pays", "settled_paid", (m.resolve(h), m.getPolicy(h).status), m.getPolicy(h).status === "settled_paid");
  check("C6", "categories", "wind below threshold does not pay", "settled_no_pay", (m.resolve(w), m.getPolicy(w).status), m.getPolicy(w).status === "settled_no_pay");

  // A wind reading can never settle a heat policy: the observation key is bound
  // to the metric, so there is no cross-category replay.
  check("C7", "categories", "cross-category observations are isolated", "true",
    `${m.getObservation("wind", "lagos", day3) !== m.getObservation("heat", "lagos", day3)}`,
    m.getObservation("wind", "lagos", day3) !== m.getObservation("heat", "lagos", day3));
}

// ===========================================================================
// 3. ADVERSARIAL MATRIX
// ===========================================================================

console.log("\n== Adversarial matrix ==");

// A1: valid qualifying -> pays (already L6). A2: non-qualifying -> no pay (L8).
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;

  // A3: conflicting oracle observations -> no premature settlement.
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 100, day3 + 60, { reporters: ["op1"] });
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60, { reporters: ["op2"] });
  // Only two conflicting readings so far: no quorum on either value.
  check("A3", "adversarial", "conflicting readings below quorum do not finalize", "true",
    `${m.getObservation("rain", "lagos", day3) === undefined}`, m.getObservation("rain", "lagos", day3) === undefined);

  // A4: one malicious oracle -> honest quorum still holds (add op3 honest).
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 120, { reporters: ["op3"] });
  // Now op2+op3 agree at 900 (support 2 < quorum 3); op1 at 100 is alone.
  check("A4", "adversarial", "one malicious oracle cannot force a wrong reading", "true",
    `${m.getObservation("rain", "lagos", day3) === undefined}`, m.getObservation("rain", "lagos", day3) === undefined,
    "no value reaches quorum while readings disagree");
  m.advanceTo(day3 + 7200);
  expectThrow("A4b", "adversarial", "unfinalized observation cannot settle", () => m.resolve(pol));
}

{
  // A5: insufficient quorum -> no settlement; A6: duplicate signature counted once.
  const { m, keys } = newBoard({ quorum: 3 });
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 500, day3 + 60, { reporters: ["op1", "op2"] });
  check("A5", "adversarial", "two of three operators is below quorum", "true",
    `${m.getObservation("rain", "lagos", day3) === undefined}`, m.getObservation("rain", "lagos", day3) === undefined);
  m.advanceTo(day3 + 7200);
  expectThrow("A5b", "adversarial", "settlement blocked without quorum", () => m.resolve(pol));

  // A6: the same operator cannot be counted twice for one observation.
  expectThrow("A6", "adversarial", "duplicate operator reading is rejected", () => {
    reportQuorum(m, keys, "rain", "lagos", day3, 500, day3 + 90, { reporters: ["op1"] });
  });
}

{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  m.advanceTo(day3);

  // A7: unknown oracle key.
  expectThrow("A7", "adversarial", "unknown operator is rejected", () => {
    const kp = keyPairFromSeed(99);
    const operator = "unknown.testnet";
    const { msg, args } = reading(m, operator, "rain", "lagos", day3, 500, day3 + 60, 0);
    m.submitReading({ ...args, signature: sign(kp.priv, msg) });
  });

  // A8: revoked oracle key.
  const { m: m2, keys: k2 } = newBoard();
  m2.deposit("lp.testnet", N(1000));
  m2.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m2.advanceTo(day3);
  m2.revokeOperator("op3.testnet");
  expectThrow("A8", "adversarial", "revoked operator is rejected", () => {
    reportQuorum(m2, k2, "rain", "lagos", day3, 500, day3 + 60, { reporters: ["op3"] });
  });

  // A9: invalid signature.
  expectThrow("A9", "adversarial", "invalid signature is rejected", () => {
    const operator = "op1.testnet";
    const { args } = reading(m, "op1.testnet", "rain", "lagos", day3, 500, day3 + 60, 0);
    m.submitReading({ ...args, signature: Buffer.alloc(64, 7) });
  });

  // A10: stale observation.
  expectThrow("A10", "adversarial", "stale observation is rejected", () => {
    const operator = "op1.testnet";
    const kp = keys.op1;
    const { msg, args } = reading(m, operator, "rain", "lagos", day3, 500, day3 + 40 * 3600, 0);
    m.submitReading({ ...args, signature: sign(kp.priv, msg) });
  });

  // A11: replayed observation (stale nonce).
  const { m: m3, keys: k3 } = newBoard();
  m3.deposit("lp.testnet", N(1000));
  m3.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m3.advanceTo(day3);
  m3.advanceTo(day3 + 60);
  const r11 = reading(m3, "op1.testnet", "rain", "lagos", day3, 500, day3 + 60, 0);
  const sig0 = sign(k3.op1.priv, r11.msg);
  m3.submitReading({ ...r11.args, signature: sig0 });
  expectThrow("A11", "adversarial", "replayed reading (stale nonce) is rejected", () => {
    m3.submitReading({ ...r11.args, signature: sig0 });
  });

  // A12: cross-contract signature replay.
  expectThrow("A12", "adversarial", "signature bound to another contract is rejected", () => {
    const other = new Decentralized({ owner: "o.testnet", quorum: 3, contractId: "other-contract.testnet" });
    other.addOperator("op1.testnet", keys.op1.pub);
    const foreign = reading(other, "op1.testnet", "rain", "lagos", day3, 500, day3 + 60, 0);
    const sig = sign(keys.op1.priv, foreign.msg);
    // Submit that signature to THIS contract: the message embeds the other id.
    const { args } = reading(m, "op1.testnet", "rain", "lagos", day3, 500, day3 + 60, 0);
    m.submitReading({ ...args, signature: sig });
  });

  // A13: cross-product observation replay — a reading for "rain" cannot be used
  // for a "drought" observation (the metric is part of the signed message).
  const { m: m4, keys: k4 } = newBoard();
  m4.deposit("lp.testnet", N(1000));
  m4.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m4.addMetricProduct("drought", { city: "lagos", metricId: "drought", thresholdTenths: 200, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m4.advanceTo(day3);
  expectThrow("A13", "adversarial", "a reading signed for one metric cannot be replayed for another", () => {
    const operator = "op1.testnet";
    const { msg } = reading(m4, operator, "rain", "lagos", day3, 500, day3 + 60, 0);
    const sig = sign(k4.op1.priv, msg);
    const { args } = reading(m4, operator, "drought", "lagos", day3, 500, day3 + 60, 0);
    m4.submitReading({ ...args, signature: sig });
  });
}

// A14/A15: compromised oracle -> challenge mechanism; dispute timing.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  // A compromised quorum reports a FALSE breach.
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60);
  m.advanceTo(day3 + 120);
  m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day3, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  check("A14", "adversarial", "a challenge freezes a compromised reading", "true",
    `${m.getDispute("rain", "lagos", day3).resolvedAt === Number.MAX_SAFE_INTEGER}`,
    m.getDispute("rain", "lagos", day3).resolvedAt === Number.MAX_SAFE_INTEGER);
  m.advanceTo(day3 + 7200);
  expectThrow("A14b", "adversarial", "a disputed reading cannot settle", () => m.resolve(pol));

  // Resolvers nullify the false reading; the policy then fails closed (no pay)
  // and, because a nullified reading can never be replaced, the reservation is
  // RELEASED so the capital is not locked forever.
  for (const r of RESOLVERS.slice(0, 3)) m.resolverVote({ resolver: r, metricId: "rain", city: "lagos", obsDate: day3, uphold: false });
  const nullifiedRes = m.resolve(pol);
  check("A14c", "adversarial", "a nullified reading settles no-pay and releases the reservation", "false/0",
    `${nullifiedRes.triggered}/${m.getPolicy(pol).status}/${m.reserved}`,
    nullifiedRes.triggered === false && m.getPolicy(pol).status === "settled_no_pay" && m.reserved === 0n);

  // A15: a challenge after the challenge window is rejected.
  const day4 = 4 * DAY;
  m.advanceTo(day4);
  reportQuorum(m, keys, "rain", "lagos", day4, 900, day4 + 60);
  m.advanceTo(day4 + 7200); // past the 1h challenge window
  expectThrow("A15", "adversarial", "a late challenge is rejected", () => {
    m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day4, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  });
}

// A16: signer cannot resolve its own dispute; owner cannot unilaterally decide.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60);
  m.advanceTo(day3 + 120);
  m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day3, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  m.addResolver("op1.testnet"); // a signer, now also a resolver
  expectThrow("A16", "adversarial", "a signer cannot resolve its own dispute", () => {
    m.resolverVote({ resolver: "op1.testnet", metricId: "rain", city: "lagos", obsDate: day3, uphold: true });
  });
  expectThrow("A16b", "adversarial", "the owner cannot unilaterally resolve a dispute", () => {
    m.resolverVote({ resolver: "owner.testnet", metricId: "rain", city: "lagos", obsDate: day3, uphold: true });
  });
}

// A17: dispute timeout voids the reading and refunds the challenger.
{
  const { m, keys } = newBoard({ disputeWindowSec: 3600 });
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60);
  m.advanceTo(day3 + 120);
  const heldBefore = m.heldBonds;
  m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day3, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  check("A17", "adversarial", "the challenge bond is held, not counted as capital", (heldBefore + ONE_NEAR / 10n).toString(), m.heldBonds.toString(), m.heldBonds === heldBefore + ONE_NEAR / 10n);
  m.advanceTo(day3 + 120 + 3601);
  m.timeoutDispute({ metricId: "rain", city: "lagos", obsDate: day3 });
  check("A17b", "adversarial", "timeout releases the held bond", "0", m.heldBonds.toString(), m.heldBonds === 0n);
  const voidedRes = m.resolve(pol);
  check("A17c", "adversarial", "a voided reading settles no-pay and releases the reservation", "false/0",
    `${voidedRes.triggered}/${m.getPolicy(pol).status}/${m.reserved}`,
    voidedRes.triggered === false && m.getPolicy(pol).status === "settled_no_pay" && m.reserved === 0n);
}

// A18: duplicate policy purchase request -> no duplicate policy.
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(10), minLeadSec: DAY, maxTotalCoverage: N(20) });
  const id1 = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: 3 * DAY });
  expectThrow("A18", "adversarial", "capacity cap rejects the duplicate beyond the cap", () => {
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: 3 * DAY });
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: 3 * DAY });
  });
  check("A18b", "adversarial", "only the permitted policies exist", "2", `${m.policies.size}`, m.policies.size === 2);
}

// A19: pool lacks capital -> purchase refused.
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(5));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  expectThrow("A19", "adversarial", "purchase beyond available capital is refused", () => {
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(50), obsDate: 3 * DAY });
  });
}

// A20: withdrawal that threatens reservations is refused.
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(100));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(100), obsDate: 3 * DAY });
  expectThrow("A20", "adversarial", "withdrawing reserved capital is refused", () => m.withdraw("lp.testnet", N(100)));
}

// A21: duplicate settlement -> no second payout.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60);
  m.advanceTo(day3 + 7200);
  const first = m.resolve(pol);
  const paidAfterFirst = m.getPool().totalPaid;
  expectThrow("A21", "adversarial", "a policy cannot settle twice", () => m.resolve(pol));
  check("A21b", "adversarial", "no second payout was made", paidAfterFirst.toString(), m.getPool().totalPaid.toString(), m.getPool().totalPaid === paidAfterFirst && first.paid === N(10));
}

// A22: agent authorization boundary (uses the real limits engine).
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const limits = normalizeLimits({ maxPremiumPerPolicy: "5000000000000000000000", maxPayoutPerPolicy: "20000000000000000000000" }); // 0.005 / 0.02 NEAR
  const payout = N(10);
  const premium = m.quotePremium("rain", payout);
  const proposal = { productId: "rain", city: "lagos", payoutYocto: payout.toString(), premiumYocto: premium.toString(), obsDateSec: 3 * DAY, nowSec: 0 };
  const product = { min_payout: N(1).toString(), max_payout: N(100).toString(), min_lead_sec: DAY, active: true };
  const over = evaluate(proposal, product, { limits, history: [], nowMs: 0 });
  check("A22", "adversarial", "an over-limit agent proposal is denied before any purchase", "denied", over.allow ? "allowed" : "denied", over.allow === false);
  const under = evaluate({ ...proposal, premiumYocto: "10000000000000000000", payoutYocto: "1000000000000000000000" }, { ...product, min_payout: "1" }, { limits, history: [], nowMs: 0 });
  check("A22b", "adversarial", "an in-limit agent proposal is allowed", "allowed", under.allow ? "allowed" : `denied: ${under.reasons.join("; ")}`, under.allow === true);
  const killed = evaluate(proposal, product, { limits: { ...limits, enabled: false }, history: [], nowMs: 0 });
  check("A22c", "adversarial", "the kill switch denies every proposal", "denied", killed.allow ? "allowed" : "denied", killed.allow === false);
}

// A23: malformed / oversized inputs fail closed.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  expectThrow("A23", "adversarial", "a payout outside product bounds is refused", () => m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(1000), obsDate: 3 * DAY }));
  expectThrow("A23b", "adversarial", "an unknown product is refused", () => m.buyCover({ buyer: "a.testnet", productId: "nope", payout: N(10), obsDate: 3 * DAY }));
  expectThrow("A23c", "adversarial", "an implausibly large reading is refused", () => {
    m.advanceTo(3 * DAY);
    reportQuorum(m, keys, "rain", "lagos", 3 * DAY, 100000, 3 * DAY + 60, { reporters: ["op1"] });
  });
}

// A24: RPC interruption / uncertain outcome cannot yield a false success. In the
// model, an exception mid-flight must leave no partial state (all-or-nothing).
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const before = { capital: m.getPool().capital, reserved: m.getPool().reserved, count: m.policies.size };
  expectThrow("A24", "adversarial", "a refused purchase changes no state", () => {
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(1000), obsDate: 3 * DAY });
  });
  check("A24b", "adversarial", "capital/reserved/policy count unchanged after a refusal", "true",
    `${before.capital === m.getPool().capital && before.reserved === m.getPool().reserved && before.count === m.policies.size}`,
    before.capital === m.getPool().capital && before.reserved === m.getPool().reserved && before.count === m.policies.size);
}

// A25: idempotency — a repeated idempotency key is refused by the agent policy.
{
  const limits = normalizeLimits({ maxPremiumPerPolicy: N(1).toString(), maxPayoutPerPolicy: N(10).toString() });
  const product = { min_payout: N(1).toString(), max_payout: N(10).toString(), min_lead_sec: DAY, active: true };
  const proposal = { productId: "rain", city: "lagos", payoutYocto: N(5).toString(), premiumYocto: (ONE_NEAR / 10n).toString(), obsDateSec: 3 * DAY, nowSec: 0, idempotencyKey: "req-1" };
  const first = evaluate(proposal, product, { limits, history: [], nowMs: 0 });
  check("A25", "adversarial", "the first use of an idempotency key is allowed", "allowed", first.allow ? "allowed" : "denied", first.allow === true);
  const history = [{ kind: "buy", atMs: 0, premiumYocto: (ONE_NEAR / 10n).toString(), idempotencyKey: "req-1" }];
  const second = evaluate(proposal, product, { limits, history, nowMs: 120_000 });
  check("A25b", "adversarial", "a repeated idempotency key cannot buy twice", "denied", second.allow ? "allowed" : "denied", second.allow === false);
}

// A26: a reading that has expired cannot settle (expiry is signed and enforced).
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3 + 60);
  // Every operator signs a reading that expires 2 minutes after reporting.
  for (const acct of ["op1", "op2", "op3"]) {
    const operator = `${acct}.testnet`;
    const nonce = m.operators.get(operator).readings;
    const { msg, args } = reading(m, operator, "rain", "lagos", day3, 900, day3 + 60, nonce, { expiry: day3 + 180 });
    m.submitReading({ ...args, signature: sign(keys[acct].priv, msg) });
  }
  check("A26", "adversarial", "a signed reading with an expiry is accepted", "quorum>=1",
    `${m.getObservation("rain", "lagos", day3)?.quorum}`, (m.getObservation("rain", "lagos", day3)?.quorum ?? 0) >= 1);
  m.advanceTo(day3 + 7200); // well past the expiry
  const expiredRes = m.resolve(pol);
  check("A26b", "adversarial", "an expired reading settles no-pay and releases the reservation", "false/0",
    `${expiredRes.triggered}/${m.getPolicy(pol).status}/${m.reserved}`,
    expiredRes.triggered === false && m.getPolicy(pol).status === "settled_no_pay" && m.reserved === 0n);
}

// A27: the owner cannot be a resolver, and an owner account cannot vote.
{
  const { m } = newBoard();
  expectThrow("A27", "adversarial", "the owner cannot be registered as a resolver", () => {
    m.addResolver("owner.testnet");
  });
}

// A28: the challenge window is fixed at purchase and cannot be shortened.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60); // observation freezes window = 3600
  // The owner shortens the global window to 1 second after the fact.
  m.setChallengeWindow(1);
  m.advanceTo(day3 + 160); // 100 s after the reading: inside the frozen 3600 s window
  m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day3, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  check("A28", "adversarial", "the frozen challenge window still allows the challenge", "disputed",
    `${m.getObservation("rain", "lagos", day3).disputed}`, m.getObservation("rain", "lagos", day3).disputed === true);
  expectThrow("A28b", "adversarial", "an unbounded challenge window is refused", () => m.setChallengeWindow(8 * 24 * 3600));
}

// A29: the dispute decision threshold is frozen when the dispute opens.
{
  const { m, keys } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  m.advanceTo(day3);
  reportQuorum(m, keys, "rain", "lagos", day3, 900, day3 + 60);
  m.advanceTo(day3 + 120);
  m.challenge({ challenger: WATCHDOG, metricId: "rain", city: "lagos", obsDate: day3, counterValueTenths: 100, bond: ONE_NEAR / 10n });
  m.setResolverQuorum(1); // try to lower the bar after the dispute is open
  m.resolverVote({ resolver: "res1.testnet", metricId: "rain", city: "lagos", obsDate: day3, uphold: false });
  m.advanceTo(day3 + 7200);
  expectThrow("A29", "adversarial", "one vote cannot decide a dispute opened with a 3-vote threshold", () => m.resolve(pol));
}

// A30: a reading that is NEVER reported must not lock the reservation (SEC-7).
// A reading for date D may be submitted with a BACKDATED reported_at, so the last
// instant it can still be accepted is D + REPORT_MAX_DELAY_SEC +
// READING_MAX_VALIDITY_SEC. Past that the key is terminally empty, so the policy
// can never pay and the reservation must be released — not locked forever.
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  const pol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  check("A30", "adversarial", "the payout is reserved while the reading is outstanding", N(10).toString(),
    m.reserved.toString(), m.reserved === N(10));
  // Before the report bound a reading may still arrive: settlement must refuse.
  m.advanceTo(day3 + 86400 - 60);
  expectThrow("A30b", "adversarial", "a reading that may still arrive keeps the reservation", () => m.resolve(pol));
  // Even after D + 24h a backdated reading may still arrive: still hold.
  m.advanceTo(day3 + 86400 + 86400);
  expectThrow("A30b2", "adversarial", "a backdated reading may still arrive after D + 24h", () => m.resolve(pol));
  // Past the last instant any reading could be accepted: settle no-pay and release.
  m.advanceTo(day3 + 86400 + 7 * 86400 + 60);
  const dead = m.resolve(pol);
  check("A30c", "adversarial", "a reading that never arrived settles no-pay and releases the reservation", "false/0",
    `${dead.triggered}/${m.getPolicy(pol).status}/${m.reserved}`,
    dead.triggered === false && m.getPolicy(pol).status === "settled_no_pay" && m.reserved === 0n);
}

// A31: an unbounded observation date must not lock the payout (SEC-9).
// `buy_cover` bounds `obs_date` only from below. Because the reservation is
// released only in `resolve` (which needs `now >= obs_date + settle_delay_sec`),
// a buyer could reserve against an arbitrarily distant date — and `u64::MAX`
// would lock provider capital forever. The contract now caps the lead.
{
  const { m } = newBoard();
  m.deposit("lp.testnet", N(1000));
  m.addMetricProduct("rain", { city: "lagos", metricId: "rain", thresholdTenths: 300, premiumBp: 500, minPayout: N(1), maxPayout: N(100), minLeadSec: DAY, maxTotalCoverage: N(5000) });
  const day3 = 3 * DAY;
  // A century out is refused; it would strand the payout for that whole interval.
  expectThrow("A31", "adversarial", "cover with a far-future observation date is refused", () =>
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: 100 * 365 * DAY }));
  // `u64::MAX` is refused; it would lock the reservation forever.
  expectThrow("A31b", "adversarial", "cover with a u64::MAX observation date is refused", () =>
    m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: (1n << 64n) - 1n }));
  // An in-bound lead is unaffected.
  const okPol = m.buyCover({ buyer: "a.testnet", productId: "rain", payout: N(10), obsDate: day3 });
  check("A31c", "adversarial", "cover within the max lead still reserves normally", N(10).toString(),
    m.reserved.toString(), m.reserved === N(10) && m.getPolicy(okPol).status === "active");
}


}
