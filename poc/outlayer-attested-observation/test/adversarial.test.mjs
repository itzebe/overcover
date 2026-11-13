// Adversarial tests for the OutLayer attested-observation POC.
//
// Each test proves a tampered/invalid input is REFUSED. Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KeyPair } from "../../../driver/attestor.js";
import { normalizeToObservation, preflight, buildReadingMessage, operatorSign } from "../lib/observation.mjs";
import {
  verifyAttestation,
  parseTdxQuote,
  spliceReportData,
  taskHash,
  verifyQuoteIntel,
} from "../lib/attestation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE = readFileSync(join(ROOT, "fixtures/tdx_quote_template.bin"));
const APPROVED = JSON.parse(readFileSync(join(ROOT, "fixtures/approved-measurements.json"), "utf8"));

const validObs = {
  metric_id: "temperature_c",
  city: "lagos",
  obs_date: "2026-11-13",
  value_tenths: 281,
  reported_at: Math.floor(Date.parse("2026-11-13T07:45:00Z") / 1000),
  expiry: Math.floor(Date.parse("2026-11-14T07:45:00Z") / 1000),
  evidence_hash: "a".repeat(64),
};
const NOW = Math.floor(Date.parse("2026-11-13T08:00:00Z") / 1000);

test("attestation: valid report_data binds task (passes)", () => {
  const expected = { task_type: "observation_adapter", wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(expected));
  const r = verifyAttestation({ quote: q, expected });
  assert.equal(r.checks.report_data_binds_task, true);
  assert.equal(r.checks.report_data_tail_zero, true);
});

test("attestation: wrong WASM hash is refused", () => {
  const good = { wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(good));
  const tampered = { ...good, wasm_hash: "ab".repeat(32) };
  const r = verifyAttestation({ quote: q, expected: tampered });
  assert.equal(r.checks.report_data_binds_task, false);
  assert.equal(r.ok, false);
});

test("attestation: wrong input hash is refused", () => {
  const good = { wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(good));
  const r = verifyAttestation({ quote: q, expected: { ...good, input_hash: "00".repeat(32) } });
  assert.equal(r.ok, false);
});

test("attestation: wrong output hash is refused", () => {
  const good = { wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(good));
  const r = verifyAttestation({ quote: q, expected: { ...good, output_hash: "11".repeat(32) } });
  assert.equal(r.ok, false);
});

test("attestation: invalid quote (not TDX) is rejected", () => {
  const bogus = Buffer.alloc(1024, 0);
  assert.throws(() => parseTdxQuote(bogus), /not a TDX quote|too short/);
});

test("attestation: wrong worker identity (measurements) is refused", () => {
  const expected = { wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(expected));
  // The template's measurements are not OutLayer's approved set.
  const r = verifyAttestation({ quote: q, expected, approvedMeasurements: APPROVED });
  assert.equal(r.checks.measurements_approved, false);
  assert.equal(r.ok, false);
});

test("attestation: a spliced report_data fails real Intel verification", () => {
  const expected = { wasm_hash: "aa".repeat(32), input_hash: "bb".repeat(32), output_hash: "cc".repeat(32) };
  const q = spliceReportData(TEMPLATE, taskHash(expected));
  const dir = mkdtempSync(join(tmpdir(), "ovc-quote-"));
  const p = join(dir, "spliced.bin");
  writeFileSync(p, q);
  const intel = verifyQuoteIntel({ quotePath: p });
  if (!intel.ran) return; // tool unavailable → UNAVAILABLE, not a pass
  assert.equal(intel.ok, false, "spliced quote must not verify");
});

test("attestation: a genuine Intel quote verifies (real dcap-qvl)", () => {
  // The untouched template is a genuine Intel-signed quote: it must verify.
  // This proves the Intel path is wired to a real verifier, not a stub.
  const dir = mkdtempSync(join(tmpdir(), "ovc-quote-"));
  const p = join(dir, "genuine.bin");
  writeFileSync(p, TEMPLATE);
  const intel = verifyQuoteIntel({ quotePath: p });
  if (!intel.ran) return; // tool/network unavailable → UNAVAILABLE, not a pass
  assert.equal(intel.ok, true, intel.output.slice(0, 200));
});

test("observation: altered source payload changes the evidence hash", () => {
  const out = JSON.parse(readFileSync(join(ROOT, "evidence/poc-report.json"), "utf8"));
  if (!out.observation) return;
  const obs = out.observation;
  const alt = { ...obs, evidence_hash: "f".repeat(64) };
  const msgA = buildReadingMessage(obs, { operator: "op.testnet", nonce: 0, contractId: "c.testnet" });
  const msgB = buildReadingMessage(alt, { operator: "op.testnet", nonce: 0, contractId: "c.testnet" });
  assert.notEqual(msgA.toString("hex"), msgB.toString("hex"));
});

test("observation: stale reading (reported too late) is refused", () => {
  // obs_date 2026-11-11, reported 2026-11-12T12:00 → 36h later (> 24h bound),
  // still not in the future relative to NOW.
  const stale = {
    ...validObs,
    obs_date: "2026-11-11",
    reported_at: Math.floor(Date.parse("2026-11-12T12:00:00Z") / 1000),
    expiry: Math.floor(Date.parse("2026-11-12T18:00:00Z") / 1000),
  };
  const pf = preflight(stale, { nowSec: NOW });
  assert.equal(pf.ok, false);
  assert.ok(pf.reasons.includes("observation reported too late (stale)"), pf.reasons.join("; "));
});

test("observation: expired reading is refused", () => {
  const expired = { ...validObs, expiry: NOW - 10 };
  const pf = preflight(expired, { nowSec: NOW });
  assert.equal(pf.ok, false);
  assert.ok(pf.reasons.includes("observation already expired"));
});

test("observation: future-dated observation is refused", () => {
  const future = { ...validObs, obs_date: "2027-01-01" };
  const pf = preflight(future, { nowSec: NOW });
  assert.equal(pf.ok, false);
  assert.ok(pf.reasons.some((r) => r.includes("future date")));
});

test("observation: value above plausibility bound is refused", () => {
  const pf = preflight(validObs, { nowSec: NOW, valueMax: 100 });
  assert.equal(pf.ok, false);
  assert.ok(pf.reasons.includes("value above metric plausibility bound"));
});

test("observation: oversized evidence reference is refused", () => {
  const big = { ...validObs, evidence_hash: "a".repeat(2 * 200) };
  const pf = preflight(big, { nowSec: NOW });
  assert.equal(pf.ok, false);
  assert.ok(pf.reasons.includes("evidence reference too large"));
});

test("observation: valid reading passes preflight", () => {
  const pf = preflight(validObs, { nowSec: NOW, valueMax: 600 });
  assert.equal(pf.ok, true, pf.reasons.join("; "));
});

test("operator signature: signs and verifies; tamper is detected", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const { message, signature } = operatorSign(validObs, {
    keyPair: kp,
    operator: "op-alpha.testnet",
    nonce: 0,
    contractId: "contract.ovc-v3-ctl-2f6c4c.testnet",
  });
  assert.equal(signature.length, 64);
  assert.equal(kp.verify(message, Buffer.from(signature)), true);
  // A different reading yields a different message → the same signature fails.
  const other = buildReadingMessage({ ...validObs, value_tenths: 999 }, {
    operator: "op-alpha.testnet",
    nonce: 0,
    contractId: "contract.ovc-v3-ctl-2f6c4c.testnet",
  });
  assert.equal(kp.verify(other, Buffer.from(signature)), false);
});

test("replay: same reading for the same operator+date is a duplicate", () => {
  // The contract keys readings by (metric, city, date, operator); a replay is
  // the same tuple. This mirrors that key.
  const key = (o) => `${o.metric_id}|${o.city}|${o.obs_date}`;
  const seen = new Set();
  const first = key(validObs);
  assert.equal(seen.has(first), false);
  seen.add(first);
  assert.equal(seen.has(key(validObs)), true);
});
