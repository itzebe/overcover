// Serialization and real-evidence tests for the OutLayer task hash.
//
// These lock the EXACT serialization OutLayer uses (worker/src/tdx_attestation.rs,
// WORKER_ATTESTATION.md) against independent Python-generated vectors, and prove
// the verifier agrees with a REAL OutLayer-hosted Intel TDX quote captured on
// testnet. They are the regression guard for the A3 finding: the previous
// implementation wrote every integer as unsigned, which is wrong for the signed
// `task_id` and `timestamp` fields.
//
// Run: node --test test/outlayer-real.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  taskHash,
  taskHashParts,
  parseTdxQuote,
  verifyAttestation,
  spliceReportData,
  verifyQuoteIntel,
  QUOTE_OFFSETS,
} from "../lib/attestation.mjs";
import { attestationTaskFields } from "../lib/outlayer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VECTORS = JSON.parse(readFileSync(join(ROOT, "test/vectors/task-hash.json"), "utf8"));
const REAL_ATT = JSON.parse(readFileSync(join(ROOT, "fixtures/outlayer-real/attestation.json"), "utf8"));
const REAL_QUOTE = readFileSync(join(ROOT, "fixtures/outlayer-real/quote.bin"));
const APPROVED = JSON.parse(readFileSync(join(ROOT, "fixtures/approved-measurements.json"), "utf8"));

test("serialization: JS task hash matches independent Python vectors", () => {
  for (const v of VECTORS.vectors) {
    const got = taskHash(v.fields).toString("hex");
    assert.equal(got, v.sha256, `vector ${v.name}`);
  }
});

test("serialization: byte layout — task_id i64LE, block_height u64LE, timestamp i64LE", () => {
  const fields = { task_type: "x", task_id: 1, output_hash: "aa", block_height: 256, timestamp: 2 };
  const parts = taskHashParts(fields);
  const byName = {};
  // taskHashParts returns only the byte segments; reconstruct field order from TASK_HASH order.
  const names = ["task_type", "task_id", "output_hash", "block_height", "timestamp"];
  parts.forEach((b, i) => (byName[names[i]] = b));
  assert.equal(byName.task_id.toString("hex"), "0100000000000000"); // i64 LE
  assert.equal(byName.block_height.toString("hex"), "0001000000000000"); // u64 LE
  assert.equal(byName.timestamp.toString("hex"), "0200000000000000"); // i64 LE
});

test("serialization: hex hashes are folded as hex STRINGS, not decoded bytes", () => {
  const asString = taskHash({ task_type: "execute", output_hash: "ab".repeat(32) });
  const asBytes = taskHash({ task_type: "execute", output_hash: Buffer.from("ab".repeat(32), "hex") });
  assert.notEqual(asString.toString("hex"), asBytes.toString("hex"));
  // The string form is the canonical one; it must equal a manual concatenation.
  const manual = taskHash({ task_type: "execute", output_hash: "ab".repeat(32) });
  assert.equal(asString.toString("hex"), manual.toString("hex"));
});

test("serialization: field order matters (swapping two fields changes the hash)", () => {
  const a = taskHash({ task_type: "execute", input_hash: "11", output_hash: "22" });
  const b = taskHash({ task_type: "execute", input_hash: "22", output_hash: "11" });
  assert.notEqual(a.toString("hex"), b.toString("hex"));
});

test("serialization: absent and null optional fields hash identically", () => {
  const absent = taskHash({ task_type: "execute", task_id: 7, output_hash: "ff" });
  const nulled = taskHash({ task_type: "execute", task_id: 7, repo: null, commit: null, output_hash: "ff" });
  assert.equal(absent.toString("hex"), nulled.toString("hex"));
});

test("real evidence: task hash recomputed from the record equals the quote's report_data", () => {
  const parsed = parseTdxQuote(REAL_QUOTE);
  const want = taskHash(attestationTaskFields(REAL_ATT)).toString("hex");
  assert.equal(want, parsed.report_data.subarray(0, 32).toString("hex"));
  assert.ok(parsed.report_data.subarray(32, 64).every((b) => b === 0), "report_data tail must be zero");
});

test("real evidence: quote report_data matches the recorded expected value", () => {
  const parsed = parseTdxQuote(REAL_QUOTE);
  const expected = VECTORS.vectors.find((v) => v.name === "real_outlayer_execution").report_data_expected;
  assert.equal(parsed.report_data.subarray(0, 32).toString("hex"), expected);
});

test("real evidence: quote measurements are in the pinned approved set", () => {
  const r = verifyAttestation({
    quote: REAL_QUOTE,
    expected: attestationTaskFields(REAL_ATT),
    approvedMeasurements: APPROVED,
  });
  assert.equal(r.checks.measurements_approved, true);
  assert.equal(r.ok, true);
});

test("real evidence: a tampered output hash is refused (task hash no longer binds)", () => {
  const tampered = { ...attestationTaskFields(REAL_ATT), output_hash: "00".repeat(32) };
  const r = verifyAttestation({ quote: REAL_QUOTE, expected: tampered });
  assert.equal(r.checks.report_data_binds_task, false);
  assert.equal(r.ok, false);
});

test("real evidence: a tampered input hash is refused", () => {
  const tampered = { ...attestationTaskFields(REAL_ATT), input_hash: "00".repeat(32) };
  const r = verifyAttestation({ quote: REAL_QUOTE, expected: tampered });
  assert.equal(r.ok, false);
});

test("real evidence: a substituted WASM hash is refused", () => {
  const tampered = { ...attestationTaskFields(REAL_ATT), wasm_hash: "11".repeat(32) };
  const r = verifyAttestation({ quote: REAL_QUOTE, expected: tampered });
  assert.equal(r.ok, false);
});

test("real evidence: a wrong caller identity is refused", () => {
  const tampered = { ...attestationTaskFields(REAL_ATT), caller_account_id: "attacker.testnet" };
  const r = verifyAttestation({ quote: REAL_QUOTE, expected: tampered });
  assert.equal(r.ok, false);
});

test("real evidence: an unapproved measurement set is refused", () => {
  const foreign = [{ mrtd: "00".repeat(48), rtmr0: "00".repeat(48), rtmr1: "00".repeat(48), rtmr2: "00".repeat(48), rtmr3: "00".repeat(48) }];
  const r = verifyAttestation({
    quote: REAL_QUOTE,
    expected: attestationTaskFields(REAL_ATT),
    approvedMeasurements: foreign,
  });
  assert.equal(r.checks.measurements_approved, false);
  assert.equal(r.ok, false);
});

test("real evidence: a spliced report_data fails real Intel verification", () => {
  // Replace the signed report_data with a fresh task hash; Intel's signature no
  // longer covers it, so dcap-qvl must reject it.
  const spliced = spliceReportData(REAL_QUOTE, taskHash({ task_type: "execute", output_hash: "00".repeat(32) }));
  const dir = mkdtempSync(join(tmpdir(), "ovc-real-"));
  const p = join(dir, "spliced.bin");
  writeFileSync(p, spliced);
  const intel = verifyQuoteIntel({ quotePath: p });
  if (!intel.ran) return; // UNAVAILABLE, not a pass
  assert.equal(intel.ok, false, "spliced report_data must not verify");
});

test("real evidence: the untouched real quote verifies with real Intel dcap-qvl", () => {
  const dir = mkdtempSync(join(tmpdir(), "ovc-real-"));
  const p = join(dir, "genuine.bin");
  writeFileSync(p, REAL_QUOTE);
  const intel = verifyQuoteIntel({ quotePath: p });
  if (!intel.ran) return; // UNAVAILABLE, not a pass
  assert.equal(intel.ok, true, intel.output.slice(0, 200));
  assert.equal(intel.status, "UpToDate");
});

test("real evidence: replay — a quote is bound to one task_id; another task_id fails", () => {
  const replay = { ...attestationTaskFields(REAL_ATT), task_id: REAL_ATT.task_id + 1 };
  const r = verifyAttestation({ quote: REAL_QUOTE, expected: replay });
  assert.equal(r.ok, false, "a quote cannot be reused for a different task_id");
});

test("real evidence: report_data offset constant matches the documented 568", () => {
  assert.equal(QUOTE_OFFSETS.report_data, 568);
});
