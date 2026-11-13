// Verify an OutLayer Intel TDX attestation and bind it to the adapter's
// WASM/input/output and the worker identity.
//
// The quote format and the report_data construction follow OutLayer's own
// documentation (WORKER_ATTESTATION.md in github.com/out-layer/outlayer) and
// Intel's TDX DCAP quote layout. The cryptographic signature/TCB check is
// delegated to Phala's `dcap-qvl` — the same crate OutLayer's register
// contract uses — so this file never re-implements Intel's verification.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// TDX 1.5 / v4 DCAP quote body offsets (after the 48-byte header).
const OFF = {
  version: 0,
  att_key_type: 2,
  tee_type: 4, // u32 LE; 0x81 == TDX
  header: 48,
  mrtd: 48 + 136,
  rtmr0: 48 + 328,
  rtmr1: 48 + 376,
  rtmr2: 48 + 424,
  rtmr3: 48 + 472,
  report_data: 48 + 520,
  report_data_len: 64,
};

const TEE_TYPE_TDX = 0x81;

/** Parse a raw TDX quote's stable fields. Throws if it is not a TDX quote. */
export function parseTdxQuote(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < OFF.report_data + OFF.report_data_len) {
    throw new Error("quote too short to be a TDX quote");
  }
  const version = buf.readUInt16LE(OFF.version);
  const teeType = buf.readUInt32LE(OFF.tee_type);
  if (teeType !== TEE_TYPE_TDX) {
    throw new Error(`not a TDX quote (tee_type=0x${teeType.toString(16)})`);
  }
  const h = (o) => buf.subarray(o, o + 48).toString("hex");
  return {
    version,
    tee_type: teeType,
    mrtd: h(OFF.mrtd),
    rtmr0: h(OFF.rtmr0),
    rtmr1: h(OFF.rtmr1),
    rtmr2: h(OFF.rtmr2),
    rtmr3: h(OFF.rtmr3),
    report_data: buf.subarray(OFF.report_data, OFF.report_data + OFF.report_data_len),
  };
}

/** SHA-256 over the task fields, per WORKER_ATTESTATION.md. */
export function taskHash(fields) {
  const order = [
    "task_type",
    "task_id",
    "repo",
    "commit",
    "build_target",
    "wasm_hash",
    "input_hash",
    "output_hash",
    "block_height",
    "caller_account_id",
    "project_id",
    "secrets_ref",
    "timestamp",
    "attached_usd",
  ];
  const parts = [];
  for (const k of order) {
    const v = fields[k];
    if (v === undefined || v === null) continue; // absent optional fields are skipped
    if (typeof v === "number") {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(v));
      parts.push(b);
    } else {
      parts.push(Buffer.from(String(v), "utf8"));
    }
  }
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

/**
 * Verify an attestation against expected task fields and the approved
 * measurements. Pure checks only; the Intel signature/TCB check is separate.
 * Returns { ok, checks: {name: boolean}, report_data_hex }.
 */
export function verifyAttestation({ quote, expected, approvedMeasurements = null }) {
  const parsed = parseTdxQuote(quote);
  const checks = {};

  const want = taskHash(expected);
  const got = parsed.report_data.subarray(0, 32);
  checks.report_data_binds_task = want.equals(got);
  checks.report_data_tail_zero = parsed.report_data.subarray(32, 64).every((b) => b === 0);

  if (approvedMeasurements) {
    const set = new Set(
      approvedMeasurements.map((m) => `${m.mrtd}|${m.rtmr0}|${m.rtmr1}|${m.rtmr2}|${m.rtmr3}`),
    );
    checks.measurements_approved = set.has(
      `${parsed.mrtd}|${parsed.rtmr0}|${parsed.rtmr1}|${parsed.rtmr2}|${parsed.rtmr3}`,
    );
  }

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    expected_report_data: want.toString("hex"),
    quote_report_data: parsed.report_data.toString("hex"),
    measurements: {
      mrtd: parsed.mrtd,
      rtmr0: parsed.rtmr0,
      rtmr1: parsed.rtmr1,
      rtmr2: parsed.rtmr2,
      rtmr3: parsed.rtmr3,
    },
  };
}

/**
 * Full Intel signature + TCB verification via the official `dcap-qvl` CLI
 * (the same crate OutLayer's register contract uses). The CLI fetches Intel
 * collateral from a PCCS. Returns { ran, ok, output, status }.
 * `ran:false` means the tool was unavailable — UNAVAILABLE, never a silent pass.
 */
export function verifyQuoteIntel({ quotePath, dcapBin, strict = false } = {}) {
  const bin = dcapBin || process.env.DCAP_QVL_BIN || "dcap-qvl";
  const args = ["verify", quotePath];
  if (strict) args.push("--strict");
  try {
    // `dcap-qvl verify` exits non-zero when verification fails; a zero exit is
    // the verified result. It prints the TCB status JSON on stdout and
    // "Quote verified" on stderr.
    const out = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    const status = /"status":"([A-Za-z]+)"/.exec(out)?.[1] || null;
    return { ran: true, ok: true, output: out.trim(), status };
  } catch (e) {
    if (e.code === "ENOENT") return { ran: false, ok: false, output: "dcap-qvl not available", status: null };
    const text = `${e.stdout || ""}${e.stderr || ""}`;
    const status = /"status":"([A-Za-z]+)"/.exec(text)?.[1] || null;
    return { ran: true, ok: false, output: text.trim() || String(e), status };
  }
}

/**
 * Build a TDX quote with a chosen `report_data` from a real template quote.
 * The template's body is Intel-signed, so a spliced report_data makes
 * `verifyQuoteIntel` FAIL — which is exactly the point: it demonstrates that a
 * caller cannot forge the hardware signature, so a genuine execution is
 * required for both checks to pass together.
 */
export function spliceReportData(templateQuote, reportData32) {
  const out = Buffer.from(templateQuote);
  reportData32.copy(out, OFF.report_data, 0, 32);
  out.fill(0, OFF.report_data + 32, OFF.report_data + 64);
  return out;
}

export const QUOTE_OFFSETS = OFF;

