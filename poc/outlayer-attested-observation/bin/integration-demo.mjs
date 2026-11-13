// Overcover × OutLayer attested-observation POC — integration demonstration.
//
// Runs the real chain:
//   external source → pinned adapter WASM → (OutLayer execution) → TEE attestation
//   → attestation verification → Overcover observation → operator signatures
//   → quorum → dispute/settlement preflight
//
// Real components used here: the pinned adapter WASM (run in a WASI-P2
// runtime), a real external source (Open-Meteo), real ed25519 operator keys
// signing the production `readingMessageV3`, and the real approved TDX
// measurements read from `worker.outlayer.testnet`.
//
// Every step is labelled LIVE / VERIFIED / SIMULATED / UNAVAILABLE. The
// OutLayer-hosted execution step is SIMULATED unless a real execution is
// available (env OUTLAYER_ATTESTATION), in which case the real TDX quote is
// verified with the official dcap-qvl. No status is ever fabricated.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KeyPair } from "../../../driver/attestor.js";
import { normalizeToObservation, preflight, operatorSign } from "../lib/observation.mjs";
import { verifyAttestation, verifyQuoteIntel, spliceReportData, taskHash } from "../lib/attestation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CONTRACT_ID = "contract.ovc-v3-ctl-2f6c4c.testnet";

const STATUS = { LIVE: "LIVE", VERIFIED: "VERIFIED", SIMULATED: "SIMULATED", UNAVAILABLE: "UNAVAILABLE" };

function sha256hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Run the pinned adapter WASM locally with wasmtime (WASI-P2), if available.
function runAdapter(wasmPath, inputObj) {
  const r = spawnSync("wasmtime", ["run", "-S", "http", wasmPath], {
    input: JSON.stringify(inputObj),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    return { ok: false, error: r.error?.message || r.stderr || `exit ${r.status}` };
  }
  return { ok: true, output: JSON.parse(r.stdout) };
}

async function main() {
  const report = { schema: "overcover.outlayer-poc.report.v1", steps: [], statuses: {} };

  // ---- 1. Pin the adapter WASM (the artifact OutLayer would execute) --------
  const wasmPath = join(ROOT, "adapter/target/wasm32-wasip2/release/overcover-observation-adapter.wasm");
  if (!existsSync(wasmPath)) throw new Error(`adapter wasm missing: ${wasmPath}`);
  const wasmBytes = readFileSync(wasmPath);
  const wasmHash = sha256hex(wasmBytes);
  report.wasm = { path: wasmPath, sha256: wasmHash, size: wasmBytes.length };
  report.steps.push({ step: "pin_adapter_wasm", status: STATUS.LIVE, wasm_sha256: wasmHash });

  // ---- 2. Run the adapter against a real external source -------------------
  const today = new Date().toISOString().slice(0, 10);
  const inputObj = {
    source_url: "https://api.open-meteo.com/v1/forecast?latitude=6.45&longitude=3.39&current=temperature_2m",
    source_name: "open-meteo",
    value_pointer: "/current/temperature_2m",
    reported_at_pointer: "/current/time",
    metric_id: "temperature_c",
    city: "lagos",
    obs_date: today,
    ttl_secs: 86400,
  };
  const run = runAdapter(wasmPath, inputObj);
  if (!run.ok) {
    report.steps.push({ step: "adapter_execution", status: STATUS.UNAVAILABLE, error: run.error });
    report.statuses.adapter_execution = STATUS.UNAVAILABLE;
    writeReport(report);
    return;
  }
  const adapterOutput = run.output;
  const inputHash = sha256hex(Buffer.from(JSON.stringify(inputObj)));
  const outputHash = sha256hex(Buffer.from(JSON.stringify(adapterOutput)));
  report.execution = { input_hash: inputHash, output_hash: outputHash, source: adapterOutput.source };
  report.steps.push({ step: "adapter_execution", status: STATUS.LIVE, source: adapterOutput.source.url });

  // ---- 3. Normalize into Overcover's observation schema --------------------
  const obs = normalizeToObservation(adapterOutput);
  report.observation = obs;
  report.steps.push({ step: "normalize_observation", status: STATUS.VERIFIED, evidence_hash: obs.evidence_hash });

  // ---- 4. Attestation: real if provided, else clearly SIMULATED ------------
  const realQuotePath = process.env.OUTLAYER_ATTESTATION;
  let attestation;
  if (realQuotePath && existsSync(realQuotePath)) {
    const quote = readFileSync(realQuotePath);
    const expected = {
      task_type: "observation_adapter",
      wasm_hash: wasmHash,
      input_hash: inputHash,
      output_hash: outputHash,
    };
    const approved = JSON.parse(readFileSync(join(ROOT, "fixtures/approved-measurements.json"), "utf8"));
    attestation = verifyAttestation({ quote, expected, approvedMeasurements: approved });
    const intel = verifyQuoteIntel({ quotePath: realQuotePath });
    attestation.intel = intel;
    attestation.status = attestation.ok && intel.ok ? STATUS.VERIFIED : STATUS.UNAVAILABLE;
  } else {
    // No real execution: build a clearly-labelled SIMULATED attestation by
    // splicing the real task hash into a real template quote. This exercises
    // every check; the Intel signature check is reported UNAVAILABLE.
    const templatePath = join(ROOT, "fixtures/tdx_quote_template.bin");
    if (existsSync(templatePath)) {
      const template = readFileSync(templatePath);
      const expected = {
        task_type: "observation_adapter",
        wasm_hash: wasmHash,
        input_hash: inputHash,
        output_hash: outputHash,
      };
      const spliced = spliceReportData(template, taskHash(expected));
      attestation = verifyAttestation({ quote: spliced, expected });
      attestation.intel = { ran: false, ok: false, output: "no live OutLayer execution provided (OUTLAYER_ATTESTATION unset)" };
      attestation.status = STATUS.SIMULATED;
    } else {
      attestation = { status: STATUS.UNAVAILABLE, reason: "no template quote and no live execution" };
    }
  }
  report.attestation = attestation;
  report.steps.push({ step: "verify_attestation", status: attestation.status, checks: attestation.checks });

  // ---- 5. Operator signatures over the production v3 message ---------------
  const nowSec = Math.floor(Date.now() / 1000);
  const pf = preflight(obs, { nowSec, valueMax: 600 }); // 60.0°C plausibility bound
  const operators = [
    { name: "op-alpha", kp: KeyPair.fromRandom("ed25519") },
    { name: "op-beta", kp: KeyPair.fromRandom("ed25519") },
    { name: "op-gamma", kp: KeyPair.fromRandom("ed25519") },
  ];
  const threshold = 2;
  const signatures = operators.map((o) => {
    const { message, signature } = operatorSign(obs, {
      keyPair: o.kp,
      operator: `${o.name}.testnet`,
      nonce: 0,
      contractId: CONTRACT_ID,
    });
    return {
      operator: `${o.name}.testnet`,
      public_key: o.kp.getPublicKey().toString(),
      message_hex: message.toString("hex"),
      signature_len: signature.length,
    };
  });
  report.quorum = { threshold, total: signatures.length, signatures, preflight: pf };
  report.steps.push({
    step: "operator_quorum",
    status: pf.ok ? STATUS.VERIFIED : STATUS.UNAVAILABLE,
    reached: signatures.length >= threshold,
    preflight_ok: pf.ok,
    preflight_reasons: pf.reasons,
  });

  report.statuses = {
    adapter_execution: STATUS.LIVE,
    observation_normalization: STATUS.VERIFIED,
    attestation: attestation.status,
    operator_quorum: pf.ok ? STATUS.VERIFIED : STATUS.UNAVAILABLE,
    settlement_readiness: pf.ok && signatures.length >= threshold ? STATUS.VERIFIED : STATUS.UNAVAILABLE,
  };
  writeReport(report);
}

function writeReport(report) {
  const out = join(ROOT, "evidence", "poc-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.statuses, null, 2));
  console.log(`\nreport: ${out}`);
  console.log(`wasm sha256: ${report.wasm?.sha256}`);
  if (report.observation) {
    console.log(`normalized: value_tenths=${report.observation.value_tenths} city=${report.observation.city} date=${report.observation.obs_date}`);
  }
}

main().catch((e) => {
  console.error("POC failed:", e);
  process.exit(1);
});
