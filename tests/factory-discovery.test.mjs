// Discovery agent — deterministic, offline-testable logic, plus one live read.
//
// The agent is a PROPOSER: it turns a real public forecast into a structured
// proposal and nothing else. These tests pin the parts that must never drift:
// the risk rule is deterministic, the evidence hash is reproducible, a forecast
// is labelled as a forecast (never an observation), and the proposal carries no
// invented premium or payout — the premium is the contract's own formula.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchForecast, classifyRisk, evidenceHash, buildProposal, physicalLabel } from "../agent/discovery.mjs";

const ONE = 1_000_000_000_000_000_000_000_000n;

// A canned Open-Meteo forecast payload, so the offline tests never touch the net.
const cannedFetch = (payload) => async () => ({ ok: true, json: async () => payload });

test("a forecast is labelled a forecast, never an observation", async () => {
  const f = await fetchForecast("rain", "lagos", 1794471872, {
    fetchImpl: cannedFetch({ daily: { precipitation_sum: [61.5] } }),
  });
  assert.equal(f.kind, "forecast");
  assert.equal(f.valueTenths, 615); // 61.5 mm -> tenths
  assert.match(f.source, /^open-meteo:forecast:/);
  assert.match(f.sourceUrl, /api\.open-meteo\.com\/v1\/forecast/);
});

test("the risk rule is deterministic and direction-aware", () => {
  const above = { direction: "Above", valueTenths: 615, note: "excess rainfall", unit: "mm/10" };
  assert.equal(classifyRisk(above, 300).emerging, true);
  assert.equal(classifyRisk(above, 700).emerging, false);
  const below = { direction: "Below", valueTenths: 5, note: "deficit", unit: "mm/10" };
  assert.equal(classifyRisk(below, 50).emerging, true);
  assert.equal(classifyRisk(below, 1).emerging, false);
});

test("the rationale quotes physical values, never a tenths value with a tenths unit", () => {
  // Regression: the rationale used to read "forecast 615 mm/10 crosses threshold
  // 300", mixing an already-physical value with the tenths unit label. It must
  // read in physical units, matching what the page shows everywhere else.
  const above = { direction: "Above", valueTenths: 615, note: "excess rainfall", unit: "mm/10" };
  const r = classifyRisk(above, 300).rationale;
  assert.match(r, /forecast 61\.5 mm/, "the value is shown as 61.5 mm");
  assert.match(r, /trigger 30\.0 mm/, "the trigger is shown as 30.0 mm");
  assert.doesNotMatch(r, /615/, "the raw tenths value is not printed as if physical");
  assert.doesNotMatch(r, /mm\/10/, "the tenths unit label does not appear in prose");
});

test("physicalLabel strips the tenths unit and scales the value", () => {
  assert.equal(physicalLabel(615, "mm/10"), "61.5 mm");
  assert.equal(physicalLabel(300, "mm/10"), "30.0 mm");
  assert.equal(physicalLabel(425, "degC/10"), "42.5 degC");
});

test("the evidence hash is reproducible for identical evidence", async () => {
  const f1 = await fetchForecast("rain", "lagos", 1794471872, { fetchImpl: cannedFetch({ daily: { precipitation_sum: [61.5] } }) });
  const f2 = await fetchForecast("rain", "lagos", 1794471872, { fetchImpl: cannedFetch({ daily: { precipitation_sum: [61.5] } }) });
  assert.equal(evidenceHash(f1), evidenceHash(f2));
  assert.match(evidenceHash(f1), /^sha256:[0-9a-f]{64}$/);
});

test("a proposal is prospective and its id is deterministic from the evidence", async () => {
  const f = await fetchForecast("rain", "miami", 1794471872, { fetchImpl: cannedFetch({ daily: { precipitation_sum: [61.5] } }) });
  const start = 1794471872;
  const p = buildProposal({
    forecast: f, thresholdTenths: 300, coverageStartSec: start,
    minPayoutYocto: ONE, maxPayoutYocto: 10n * ONE,
  });
  assert.equal(p.status, "PROPOSED"); // emerging risk
  assert.equal(p.coverageStartSec, start);
  assert.equal(p.id, "factory-rain-miami-2026-11-12");
  // Re-running the same discovery yields the same id -> no duplicate product.
  const p2 = buildProposal({ forecast: f, thresholdTenths: 300, coverageStartSec: start, minPayoutYocto: ONE, maxPayoutYocto: 10n * ONE });
  assert.equal(p.id, p2.id);
});

test("no emerging risk yields DISCOVERED, not PROPOSED", async () => {
  const f = await fetchForecast("rain", "lagos", 1794471872, { fetchImpl: cannedFetch({ daily: { precipitation_sum: [2.5] } }) });
  const p = buildProposal({ forecast: f, thresholdTenths: 300, coverageStartSec: 1794471872, minPayoutYocto: ONE, maxPayoutYocto: 10n * ONE });
  assert.equal(p.status, "DISCOVERED");
  assert.equal(p.risk.emerging, false);
});

test("the proposal carries the declared payouts and no invented premium", async () => {
  const f = await fetchForecast("rain", "miami", 1794471872, { fetchImpl: cannedFetch({ daily: { precipitation_sum: [61.5] } }) });
  const p = buildProposal({ forecast: f, thresholdTenths: 300, coverageStartSec: 1794471872, minPayoutYocto: ONE, maxPayoutYocto: 10n * ONE });
  assert.equal(p.minPayoutYocto, ONE.toString());
  assert.equal(p.maxPayoutYocto, (10n * ONE).toString());
  // The premium is a rate, not an amount: the contract computes the amount.
  assert.equal(p.premiumBp, 500);
  assert.equal("premium" in p, false);
});

test("an unsupported metric is refused rather than guessed", async () => {
  await assert.rejects(() => fetchForecast("earthquake", "lagos", 1794471872, { fetchImpl: cannedFetch({}) }), /no forecast adapter/);
});

test("an unknown city is refused rather than guessed", async () => {
  await assert.rejects(() => fetchForecast("rain", "atlantis", 1794471872, { fetchImpl: cannedFetch({}) }), /unknown city/);
});

// One live read against the real provider. Skipped (not failed) when offline, so
// the offline suite stays green; the read proves the agent reads real data.
test("reads a real Open-Meteo forecast (live; skipped when offline)", async (t) => {
  const dateSec = Math.floor(Date.now() / 1000) + 86400;
  let f;
  try {
    f = await fetchForecast("rain", "lagos", dateSec);
  } catch (e) {
    t.skip(`offline: ${e.message}`);
    return;
  }
  assert.equal(f.kind, "forecast");
  assert.ok(Number.isInteger(f.valueTenths) && f.valueTenths >= 0);
  assert.match(f.sourceUrl, /open-meteo/);
});
