// Execute on OutLayer and verify the resulting TDX attestation — the
// reproducible path that produced fixtures/outlayer-real/.
//
//   # Fresh anonymous wallet + free trial (testnet), then run connector-probe:
//   node bin/execute-on-outlayer.mjs --register
//
//   # Reuse an existing key (env or file):
//   OUTLAYER_PAYMENT_KEY="owner:nonce:secret" node bin/execute-on-outlayer.mjs
//
//   # Run against a project you deployed (needs that project to exist):
//   node bin/execute-on-outlayer.mjs --project myacct.testnet/weather --operation fetch \
//        --input '{"url":"https://api.open-meteo.com/v1/forecast?...","operation":"fetch"}'
//
// It registers/claims only when asked, never prints secret values, and writes
// the attestation record + quote to a directory you name (default: a temp dir).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OUTLAYER,
  registerWallet,
  claimTrial,
  callConnector,
  fetchAttestation,
  attestationTaskFields,
} from "../lib/outlayer.mjs";
import { parseTdxQuote, taskHash, verifyQuoteIntel } from "../lib/attestation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const base = OUTLAYER.testnet;
  const outDir = arg("out", join(ROOT, "fixtures/outlayer-real"));
  mkdirSync(outDir, { recursive: true });

  let paymentKey = process.env.OUTLAYER_PAYMENT_KEY;
  let owner = arg("owner");
  const project = arg("project", "connectors.outlayer.testnet/connector-probe");

  if (has("register")) {
    const reg = await registerWallet(base);
    if (!reg.ok) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
    const apiKey = reg.body.api_key;
    owner = owner || reg.body.near_account_id;
    const trial = await claimTrial(base, apiKey);
    if (!trial.ok) throw new Error(`trial failed: ${JSON.stringify(trial.body)}`);
    paymentKey = trial.body.payment_key;
    console.log(`registered wallet ${reg.body.wallet_id}; trial: ${trial.body.calls} calls`);
  }
  if (!paymentKey) throw new Error("no OUTLAYER_PAYMENT_KEY (use --register or set the env var)");

  const operation = arg("operation", "whoami");
  const input = has("input") ? JSON.parse(arg("input")) : { operation };

  const [pOwner, pName] = project.split("/");
  const call = await callConnector(base, {
    paymentKey,
    owner: pOwner,
    project: pName,
    input,
  });
  if (!call.ok) throw new Error(`call failed: ${JSON.stringify(call.body)}`);
  console.log(`call ${call.body.call_id} → ${call.body.status} (cost ${call.body.compute_cost})`);

  const att = await fetchAttestation(base, call.body.call_id);
  if (!att.ok) throw new Error(`attestation not available: ${JSON.stringify(att.body)}`);

  const record = { ...att.body, _source: `${base}/attestations/by-call/${call.body.call_id}` };
  writeFileSync(join(outDir, "attestation.json"), JSON.stringify(record, null, 2));
  const quote = Buffer.from(att.body.tdx_quote, "base64");
  writeFileSync(join(outDir, "quote.bin"), quote);

  const parsed = parseTdxQuote(quote);
  const want = taskHash(attestationTaskFields(att.body)).toString("hex");
  const got = parsed.report_data.subarray(0, 32).toString("hex");
  const intel = verifyQuoteIntel({ quotePath: join(outDir, "quote.bin") });

  console.log(JSON.stringify({
    attestation: join(outDir, "attestation.json"),
    quote_sha256: (await import("node:crypto")).createHash("sha256").update(quote).digest("hex"),
    task_hash_matches: want === got,
    intel: intel.ran ? { ok: intel.ok, status: intel.status } : { ran: false },
  }, null, 2));
}

main().catch((e) => {
  console.error("execute-on-outlayer failed:", e.message);
  process.exit(1);
});
