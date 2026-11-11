// Tests for the agent spending policy. Pure logic, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLimits, evaluate, premiumSpentWithin, policiesWithin, DEFAULT_LIMITS, fundsShortfall } from "../agent/limits.mjs";

const NEAR = 10n ** 24n;
const product = {
  id: "rain-lagos",
  city: "lagos",
  min_payout: (NEAR / 100n).toString(), // 0.01
  max_payout: (NEAR * 2n).toString(),
  min_lead_sec: 0,
  active: true,
};

function baseCtx(overrides = {}) {
  return {
    limits: normalizeLimits({ maxPremiumPerPolicy: (NEAR / 10n).toString(), maxPayoutPerPolicy: (NEAR).toString(), dailyPremiumBudget: NEAR.toString(), dailyPolicyLimit: 5, cooldownSec: 60, ...(overrides.limits ?? {}) }),
    history: overrides.history ?? [],
    nowMs: overrides.nowMs ?? 1_000_000_000,
  };
}

function proposal(over = {}) {
  return {
    productId: "rain-lagos",
    city: "lagos",
    payoutYocto: (NEAR / 2n).toString(),
    premiumYocto: (NEAR / 100n).toString(),
    obsDateSec: 1_000_000 + 3600,
    nowSec: 1_000_000,
    ...over,
  };
}

test("a proposal inside every limit is allowed", () => {
  const v = evaluate(proposal(), product, baseCtx());
  assert.equal(v.allow, true, v.reasons.join("; "));
});

test("premium above the per-policy cap is refused", () => {
  const ctx = baseCtx({ limits: { maxPremiumPerPolicy: (NEAR / 1000n).toString() } });
  const v = evaluate(proposal({ premiumYocto: (NEAR / 100n).toString() }), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /maxPremiumPerPolicy/);
});

test("payout above the per-policy cap is refused", () => {
  const ctx = baseCtx({ limits: { maxPayoutPerPolicy: (NEAR / 4n).toString() } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /maxPayoutPerPolicy/);
});

test("a policy that would breach the rolling daily budget is refused", () => {
  const nowMs = 1_000_000_000;
  const history = [{ kind: "buy", atMs: nowMs - 3600_000, premiumYocto: (NEAR * 95n / 100n).toString() }];
  const ctx = baseCtx({ history, nowMs, limits: { dailyPremiumBudget: NEAR.toString() } });
  const v = evaluate(proposal({ premiumYocto: (NEAR / 10n).toString() }), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /dailyPremiumBudget/);
});

test("budget spent more than 24h ago does not count against today", () => {
  const nowMs = 1_000_000_000;
  const history = [{ kind: "buy", atMs: nowMs - 25 * 3600_000, premiumYocto: (NEAR * 99n / 100n).toString() }];
  const ctx = baseCtx({ history, nowMs, limits: { dailyPremiumBudget: NEAR.toString() } });
  const v = evaluate(proposal({ premiumYocto: (NEAR / 10n).toString() }), product, ctx);
  assert.equal(v.allow, true, v.reasons.join("; "));
});

test("exceeding the daily policy count is refused", () => {
  const nowMs = 1_000_000_000;
  const history = Array.from({ length: 5 }, (_, i) => ({ kind: "buy", atMs: nowMs - i * 1000, premiumYocto: "1" }));
  const ctx = baseCtx({ history, nowMs, limits: { dailyPolicyLimit: 5 } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /dailyPolicyLimit/);
});

test("cooldown blocks a purchase made too soon after the last", () => {
  const nowMs = 1_000_000_000;
  const history = [{ kind: "buy", atMs: nowMs - 10_000, premiumYocto: "1" }];
  const ctx = baseCtx({ history, nowMs, limits: { cooldownSec: 60 } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /cooldown/);
});

test("a product not on the allow-list is refused", () => {
  const ctx = baseCtx({ limits: { allowedProducts: ["rain-bergen-dry"] } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /allowedProducts/);
});

test("a city not on the allow-list is refused", () => {
  const ctx = baseCtx({ limits: { allowedCities: ["bergen"] } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /allowedCities/);
});

test("a payout outside the product bounds is refused even if under the agent cap", () => {
  const ctx = baseCtx();
  const v = evaluate(proposal({ payoutYocto: (NEAR * 10n).toString() }), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /outside product bounds/);
});

test("a disabled agent refuses everything", () => {
  const ctx = baseCtx({ limits: { enabled: false } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /disabled/);
});

test("too little lead time is refused", () => {
  const ctx = baseCtx({ limits: { minLeadSec: 7200 } });
  const v = evaluate(proposal({ obsDateSec: 1_000_000 + 100, nowSec: 1_000_000 }), product, ctx);
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /ahead/);
});

test("normalizeLimits rejects a negative or non-integer limit instead of widening authority", () => {
  assert.throws(() => normalizeLimits({ maxPremiumPerPolicy: "-1" }), /non-negative/);
  assert.throws(() => normalizeLimits({ maxPremiumPerPolicy: "abc" }), /non-negative/);
  assert.throws(() => normalizeLimits({ dailyPolicyLimit: -1 }), /non-negative/);
  assert.throws(() => normalizeLimits({ cooldownSec: 1.5 }), /non-negative/);
});

test("normalizeLimits applies safe defaults for omitted fields", () => {
  const l = normalizeLimits({});
  assert.equal(l.enabled, true);
  assert.equal(l.maxPremiumPerPolicy, DEFAULT_LIMITS.maxPremiumPerPolicy);
  assert.deepEqual(l.allowedProducts, []);
});

test("premiumSpentWithin sums only buys inside the window", () => {
  const now = 10_000_000;
  const h = [
    { kind: "buy", atMs: now - 1000, premiumYocto: "100" },
    { kind: "buy", atMs: now - 2000, premiumYocto: "50" },
    { kind: "buy", atMs: now - 90_000_000, premiumYocto: "999999" },
    { kind: "denied", atMs: now - 500, premiumYocto: "777" },
  ];
  assert.equal(premiumSpentWithin(h, now, 24 * 3600 * 1000), 150n);
  assert.equal(policiesWithin(h, now, 24 * 3600 * 1000), 2);
});

test("limits combine: several breaches are all reported", () => {
  const ctx = baseCtx({ limits: { maxPremiumPerPolicy: "1", maxPayoutPerPolicy: "1" } });
  const v = evaluate(proposal(), product, ctx);
  assert.equal(v.allow, false);
  assert.ok(v.reasons.length >= 2);
});

// Funds preflight: the agent must refuse a purchase its account cannot pay for
// BEFORE it signs anything. This guards the live send path (agent.mjs), which
// otherwise builds a transaction the network rejects for insufficient balance.
test("fundsShortfall: a balance that covers premium + buffer is allowed", () => {
  const N = 10n ** 24n;
  assert.equal(fundsShortfall(N.toString(), (N / 100n).toString()), null);
});

test("fundsShortfall: a balance below premium + buffer is refused with a reason", () => {
  const N = 10n ** 24n;
  assert.match(fundsShortfall((N / 1000n).toString(), (N / 10n).toString()), /below premium \+ gas buffer/);
});

test("fundsShortfall: covering the premium but not the gas buffer is refused", () => {
  const N = 10n ** 24n;
  assert.match(fundsShortfall((N / 10n).toString(), (N / 10n).toString()), /below premium \+ gas buffer/);
});

test("fundsShortfall: an unknown balance is refused, never treated as unlimited", () => {
  assert.match(fundsShortfall(null, "1"), /unknown/);
  assert.match(fundsShortfall(undefined, "1"), /unknown/);
});
