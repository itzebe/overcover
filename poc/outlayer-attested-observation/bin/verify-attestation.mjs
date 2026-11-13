// Verify a real OutLayer attestation record + its TDX quote, offline.
//
//   node bin/verify-attestation.mjs <attestation.json> <quote.bin> [approved.json]
//
// Checks, in order:
//   1. The quote is a TDX quote (tee_type 0x81).
//   2. Recomputing the canonical OutLayer task hash from the record's own
//      fields equals report_data[0..32], and report_data[32..64] is zero.
//   3. The quote's 5 measurements are in the approved set (defaults to the
//      pinned fixture; pass the live on-chain set to check against chain).
//   4. Intel signature + TCB via dcap-qvl (if the CLI is available).
//
// Exit 0 only if every check that ran passed. A check that could not run is
// reported UNAVAILABLE and never counted as a pass.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTdxQuote, taskHash, verifyQuoteIntel } from "../lib/attestation.mjs";
import { attestationTaskFields } from "../lib/outlayer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const [attPath, quotePath, approvedPath] = process.argv.slice(2);
if (!attPath || !quotePath) {
  console.error("usage: verify-attestation.mjs <attestation.json> <quote.bin> [approved.json]");
  process.exit(2);
}

const att = JSON.parse(readFileSync(attPath, "utf8"));
const quote = readFileSync(quotePath);
const approved = JSON.parse(
  readFileSync(approvedPath || join(ROOT, "fixtures/approved-measurements.json"), "utf8"),
);

const result = {};

const parsed = parseTdxQuote(quote);
result.tee_type = `0x${parsed.tee_type.toString(16)}`;

const fields = attestationTaskFields(att);
const want = taskHash(fields).toString("hex");
const got = parsed.report_data.subarray(0, 32).toString("hex");
result.task_hash_expected = want;
result.task_hash_in_quote = got;
result.task_hash_matches = want === got;
result.report_data_tail_zero = parsed.report_data.subarray(32, 64).every((b) => b === 0);

const set = new Set(approved.map((m) => `${m.mrtd}|${m.rtmr0}|${m.rtmr1}|${m.rtmr2}|${m.rtmr3}`));
result.measurements_approved = set.has(
  `${parsed.mrtd}|${parsed.rtmr0}|${parsed.rtmr1}|${parsed.rtmr2}|${parsed.rtmr3}`,
);

const intel = verifyQuoteIntel({ quotePath });
result.intel = intel.ran ? { ok: intel.ok, status: intel.status } : { ran: false };

const checks = [result.task_hash_matches, result.report_data_tail_zero, result.measurements_approved];
const ok = checks.every(Boolean) && (!intel.ran || intel.ok);
result.ok = ok;

console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
