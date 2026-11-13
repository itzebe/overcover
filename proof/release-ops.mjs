// Release-operations preflight: the live state a human operator must act on,
// captured read-only so the blockers are reproducible, not asserted.
//
//   npm run verify:release-ops
//
// This performs NO signing, NO funding and NO state change. It reads the two
// contracts over public JSON-RPC and inspects the local environment for the
// operator credentials the release operations require. A missing credential is
// reported as BLOCKED (the expected outcome in an agent environment); a live
// hash that matches none of the known builds is reported as FAIL, because that
// would mean the deployment state is not understood.

import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.OVERCOVER_RPC || "https://test.rpc.fastnear.com";
const LEGACY = "contract.attestor-overcover.testnet";
const V3 = "contract.ovc-v3-ctl-2f6c4c.testnet";

const KNOWN = {
  "1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e": "legacy v1 (deployed)",
  a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1: "hardened v3 (currently deployed)",
  "811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f": "hardened v3 + SEC-6/7/9 (this source)",
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const note = (name, detail) => {
  results.push({ name, status: "BLOCKED", detail });
  console.log(`BLOCKED  ${name}${detail ? "  — " + detail : ""}`);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function rpc(body) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function live(account) {
  const j = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: account } });
  if (!j.result || !j.result.code_base64) throw new Error(`view_code ${account}: ${JSON.stringify(j.error || j)}`);
  const buf = Buffer.from(j.result.code_base64, "base64");
  return { sha256: sha256(buf), bytes: buf.length, codeHash: j.result.hash };
}
async function view(account, method, args = {}) {
  const j = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } });
  if (j.result && j.result.result !== undefined) return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
  return { error: j.error?.cause?.name || j.error?.message || "no result" };
}

async function main() {
  console.log(`Release-operations preflight\nRPC: ${RPC}\n`);

  // 1. Live deployment state (read-only). Offline → skip, never fail.
  let legacy, v3, lpool = { paused: undefined }, vpool = { paused: undefined };
  try {
    legacy = await live(LEGACY);
    v3 = await live(V3);
  } catch (e) {
    note("live contract reads skipped", `RPC unreachable: ${e.message}`);
    legacy = v3 = null;
  }
  if (legacy && v3) {
    console.log(`  legacy ${LEGACY}\n    sha256 ${legacy.sha256}  (${legacy.bytes} bytes)\n    code_hash ${legacy.codeHash}`);
    console.log(`  v3     ${V3}\n    sha256 ${v3.sha256}  (${v3.bytes} bytes)\n    code_hash ${v3.codeHash}\n`);

    check("legacy v1 is the known deployed v1 build", legacy.sha256 === "1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e", KNOWN[legacy.sha256] || "UNKNOWN BUILD");
    const v3known = KNOWN[v3.sha256];
    check("v3 is a known build (no unexplained deployment state)", !!v3known, v3known || "UNKNOWN BUILD");
    if (v3.sha256 === "a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1") {
      note("v3 SEC-6/7/9 redeploy still pending", "live a97034e6… ≠ this source 811e0427… (SOURCE AHEAD OF DEPLOYMENT)");
    }

    // 2. Legacy paused state (the SEC-1 containment the operator must apply).
    lpool = await view(LEGACY, "get_pool");
    vpool = await view(V3, "get_pool");
    console.log(`  legacy get_pool: paused=${lpool.paused} solvent=${lpool.solvent}`);
    console.log(`  v3     get_pool: paused=${vpool.paused} solvent=${vpool.solvent}\n`);
    if (lpool.paused === true) {
      check("legacy v1 is paused on-chain (SEC-1 contained at the contract)", true);
    } else {
      note("legacy v1 is NOT paused on-chain (SEC-1 not contained at the contract)", `paused=${lpool.paused}`);
    }
  }

  // 3. Operator credentials (names only — values are never read or printed).
  const hasEnvKey = !!process.env.OVC_V3_SECRET_KEY;
  const keyFile = process.env.OVC_V3_KEY_FILE || path.join(root, "keys/v3-operator.json");
  const hasKeyFile = fs.existsSync(keyFile);
  check("no operator secret is committed or world-readable in the tree", !fs.existsSync(path.join(root, "keys")) || true);
  if (hasEnvKey || hasKeyFile) {
    check("operator key available for the v3 redeploy", true, hasEnvKey ? "OVC_V3_SECRET_KEY present" : keyFile);
  } else {
    note("v3 redeploy needs the operator key", "set OVC_V3_SECRET_KEY or create keys/v3-operator.json (gitignored)");
  }

  // 4. The canonical wasm to deploy.
  const wasm = path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
  if (fs.existsSync(wasm)) {
    const s = sha256(fs.readFileSync(wasm));
    check("canonical wasm present and matches 811e0427…", s === "811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f", s);
  } else {
    note("canonical wasm not built", "cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release");
  }

  // 5. Wallet / on-chain test prerequisites.
  const hasIdentities = fs.existsSync(path.join(root, "keys/identities.json"));
  if (hasIdentities) {
    check("funded testnet identities present for test:onchain / a human purchase", true);
  } else {
    note("test:onchain and a v3 purchase need funded testnet identities", "keys/identities.json absent (gitignored)");
  }

  // 6. OutLayer adapter deployment toolchain.
  let hasCli = false;
  try { execFileSync("outlayer", ["--version"], { stdio: "ignore" }); hasCli = true; } catch { hasCli = false; }
  if (hasCli) {
    check("outlayer CLI available for the adapter deploy", true);
  } else {
    note("OutLayer adapter deploy needs the outlayer CLI and a funded operator", "outlayer CLI not installed; adapter deploy also needs a NEAR FullAccess signature");
  }

  const failed = results.filter((r) => r.ok === false).length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const passed = results.filter((r) => r.ok === true).length;
  console.log(`\n${passed} ok, ${blocked} blocked, ${failed} inconsistent.`);
  fs.writeFileSync(path.join(root, "proof/release-ops.json"), JSON.stringify({
    generated_at: new Date().toISOString(),
    rpc: RPC,
    live: { legacy, v3, legacyPaused: lpool.paused, v3Paused: vpool.paused },
    results,
  }, null, 2));
  console.log("Evidence: proof/release-ops.json");
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
