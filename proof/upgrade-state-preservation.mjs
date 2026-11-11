// Does the documented in-place upgrade PRESERVE existing state?
//
// The runbook (`docs/DEPLOY_RUNBOOK.md` §3a) says the in-place upgrade "keeps the
// address, the pool capital and the policies". `driver/upgrade.js` performs a
// DeployContract followed by a self-call `migrate()`. This proof tests that claim
// on a real local neard node, using the EXACT v1 bytecode read from the live
// contract, so the finding is about the real migration and not a stand-in.
//
// Sequence:
//   1. deploy the live v1 module, `new(...)`, add a product, deposit capital,
//      buy a policy  -> v1 state that must survive;
//   2. deploy the v2 module and self-call `migrate(...)` (the runbook's upgrade);
//   3. compare the pre/post state and report every difference.
//
// It asserts nothing about what "should" happen; it records what does. Exit 0
// means the harness ran; the summary line reports whether state survived.
//
// Skips cleanly when the sandbox binary or either wasm is absent.
// Usage: node proof/upgrade-state-preservation.mjs
//   OVERCOVER_V1_WASM=/tmp/v1-deployed.wasm  (default: download from RPC)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V2_WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const V1_WASM = process.env.OVERCOVER_V1_WASM || "/tmp/v1-deployed.wasm";
const RPC = "https://test.rpc.fastnear.com";
const LIVE_CONTRACT = "contract.attestor-overcover.testnet";
const HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-preserve-" + process.pid);
const PORT = Number(process.env.NEAR_SANDBOX_PORT || 3035);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const NEAR = (s) => utils.format.parseNearAmount(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("error", reject); p.on("close", (c) => resolve({ code: c, out }));
});

async function ensureV1() {
  if (fs.existsSync(V1_WASM)) return V1_WASM;
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "view_code", finality: "final", account_id: LIVE_CONTRACT } }) });
  const j = await r.json();
  fs.writeFileSync(V1_WASM, Buffer.from(j.result.code_base64, "base64"));
  return V1_WASM;
}

let sandbox;
async function main() {
  const bin = await ensureSandboxBin();
  if (!bin || !fs.existsSync(bin)) {
    if (process.env.REQUIRE_SANDBOX === "1") throw new Error("no neard >= 2.14 sandbox binary");
    console.log("SKIP  no neard sandbox binary (set NEAR_SANDBOX_BIN, or REQUIRE_SANDBOX=1 to fail)"); return;
  }
  if (!fs.existsSync(V2_WASM)) {
    if (process.env.REQUIRE_SANDBOX === "1") throw new Error(`no wasm at ${V2_WASM}`);
    console.log(`SKIP  v2 wasm not built at ${V2_WASM}`); return;
  }
  const v1Path = await ensureV1();
  const crypto = await import("node:crypto");
  const v1Sha = crypto.createHash("sha256").update(fs.readFileSync(v1Path)).digest("hex");
  const v2Sha = crypto.createHash("sha256").update(fs.readFileSync(V2_WASM)).digest("hex");

  fs.rmSync(HOME, { recursive: true, force: true });
  if ((await run(bin, ["--home", HOME, "init"])).code !== 0) throw new Error("sandbox init failed");
  sandbox = spawn(bin, ["--home", HOME, "run", "--rpc-addr", `0.0.0.0:${PORT}`], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${NODE_URL}/status`)).ok) break; } catch {} await sleep(1000); }

  const vk = JSON.parse(fs.readFileSync(path.join(HOME, "validator_key.json"), "utf8"));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("local", vk.account_id, KeyPair.fromString(vk.secret_key));
  const near = await connect({ networkId: "local", nodeUrl: NODE_URL, keyStore: ks, headers: {} });
  const master = await near.account(vk.account_id);

  const mk = async (name, fund = "50") => {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${vk.account_id}`;
    for (let i = 0; i < 6; i++) { try { await master.createAccount(id, kp.getPublicKey(), NEAR(fund)); break; } catch { await sleep(700); } }
    await ks.setKey("local", id, kp);
    const a = await near.account(id); a.kp = kp; a.id = id; return a;
  };
  const owner = await mk("owner");
  const attestor = await mk("attestor");
  const buyer = await mk("buyer");
  const CONTRACT = `cover.${vk.account_id}`;
  const ckp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT, ckp);
  const c = await near.account(CONTRACT);
  const view = (m, a = {}) => c.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const call = (acct, m, a, dep = "0") => acct.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: "300000000000000", attachedDeposit: dep });

  // ---- 1. v1: deploy the LIVE bytecode and build real state ----
  await c.deployContract(fs.readFileSync(v1Path));
  const attestorPub = Array.from(attestor.kp.getPublicKey().data);
  const initArgs = { owner: owner.id, attestor: attestorPub, challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 1 };
  await call(c, "new", initArgs);

  // a published product (v1 shape) and a real policy — this is the state that
  // the runbook says the upgrade preserves. obs_date is a few seconds ahead so a
  // reading can be reported and the policy settled shortly after the upgrade.
  await call(owner, "add_product", {
    id: "heat-lagos", city: "lagos", threshold_tenths: 400, premium_bp: 1000,
    min_payout: NEAR("0.3"), max_payout: NEAR("0.3"), min_lead_sec: 0,
    max_total_coverage: NEAR("3"),
  });
  await call(owner, "deposit", {}, NEAR("5")); // pool capital
  const obsDate = Math.floor(Date.now() / 1000) + 3;
  await call(buyer, "buy_cover", { product_id: "heat-lagos", payout: NEAR("0.3"), obs_date: obsDate, beneficiary: buyer.id }, NEAR("0.03"));

  // Report a v1 observation (key `city|date`) that will trigger the payout. It is
  // part of the legacy state the migration must re-key for v2 `resolve` to find.
  await sleep(4000);
  const reportedAt = Math.floor(Date.now() / 1000);
  const value = 1000; // >= threshold 400 -> Above triggers
  const v1msg = Buffer.from(`overcover:v1|lagos|${obsDate}|${value}|${reportedAt}|0|${CONTRACT}`);
  const signature = Array.from(attestor.kp.sign(v1msg).signature);
  await call(attestor, "report_observation", { city: "lagos", obs_date: obsDate, value_tenths: value, reported_at: reportedAt, nonce: 0, signature });
  await sleep(2000); // let the challenge window elapse

  const before = {
    config: await view("get_config"),
    pool: await view("get_pool"),
    policies: await view("list_policies", { from_index: 0, limit: 100 }),
    products: (await view("list_products", { from_index: 0, limit: 100 })).map((p) => p.id),
    reconcile: await view("reconcile"),
    invariant: await view("check_invariant"),
  };
  console.log("BEFORE (v1, " + v1Sha.slice(0, 12) + "…):");
  console.log("  pool      ", JSON.stringify(before.pool));
  console.log("  policies  ", before.policies.length, before.policies.map((p) => `#${p.id}:${p.status}`).join(","));
  console.log("  products  ", before.products.join(","));

  // ---- 2. the runbook upgrade: deploy v2, self-call migrate ----
  await c.deployContract(fs.readFileSync(V2_WASM));
  const ownerKp = owner.kp;
  const migrateArgs = { owner: owner.id, attestor: Array.from(ownerKp.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 3600 };
  let migrateOk = false, migrateErr = null;
  try { await call(c, "migrate", migrateArgs); migrateOk = true; } catch (e) { migrateErr = e.message || String(e); }
  console.log(`\nAFTER deploy v2 + self-call migrate(): ${migrateOk ? "accepted" : "REJECTED — " + migrateErr}`);

  const after = {
    config: await view("get_config"),
    pool: await view("get_pool"),
    policies: await view("list_policies", { from_index: 0, limit: 100 }),
    products: (await view("list_products", { from_index: 0, limit: 100 })).map((p) => p.id),
    reconcile: await view("reconcile"),
    invariant: await view("check_invariant"),
  };
  console.log("  pool      ", JSON.stringify(after.pool));
  console.log("  policies  ", after.policies.length, after.policies.map((p) => `#${p.id}:${p.status}`).join(","));
  console.log("  products  ", after.products.join(","));

  // The strongest test: a migrated v1 policy must still settle under v2. The
  // observation was reported under v1 (key `city|date`); the migration re-keys it
  // to `|city|date`, which is what v2 `resolve` looks up. If the migration is
  // wrong, `resolve` fails with "no observation".
  let settleOk = false, settleDetail = "";
  try {
    const res = await c.functionCall({ contractId: CONTRACT, methodName: "resolve", args: { policy_id: 1 }, gas: "300000000000000", attachedDeposit: "0" });
    settleOk = true;
    const pol = await view("get_policy", { id: 1 });
    settleDetail = `status=${pol.status} paid=${pol.paid_amount}`;
  } catch (e) { settleDetail = (e.message || String(e)).slice(0, 120); }
  console.log("  settle migrated policy #1:", settleOk ? `OK — ${settleDetail}` : `FAILED — ${settleDetail}`);

  const diffs = [];
  const cmp = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${label}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`); };
  cmp("capital", before.pool.capital, after.pool.capital);
  cmp("reserved", before.pool.reserved, after.pool.reserved);
  cmp("policy_count", before.pool.policy_count, after.pool.policy_count);
  cmp("products", before.products, after.products);
  cmp("reconcile", before.reconcile, after.reconcile);

  // The v2 records add fields; every v1 field must survive unchanged and the new
  // fields must take the documented legacy defaults (metric "", direction Above).
  const stripV2 = (p) => { const { metric_id, direction, ...rest } = p; return rest; };
  const legacyOk = after.policies.length === before.policies.length
    && before.policies.every((b, i) => JSON.stringify(stripV2(after.policies[i])) === JSON.stringify(b))
    && after.policies.every((p) => p.metric_id === "" && p.direction === "Above");
  if (!legacyOk) diffs.push("legacy policy fields were not carried over with the v2 defaults");

  console.log("\nDIFFERENCES (before -> after):");
  if (!diffs.length) console.log("  none — state preserved");
  else for (const d of diffs) console.log("  " + d);

  fs.writeFileSync(path.join(root, "proof", "upgrade-state-preservation.json"), JSON.stringify({
    mode: "SANDBOX", nodeUrl: NODE_URL, contract: CONTRACT, v1WasmSha256: v1Sha, v2WasmSha256: v2Sha,
    migrateAccepted: migrateOk, migrateError: migrateErr,
    migratedPolicySettled: settleOk, migrateSettleDetail: settleDetail,
    before, after, differences: diffs, statePreserved: diffs.length === 0,
  }, null, 2));

  const ok = diffs.length === 0 && migrateOk && settleOk;
  console.log(`\nRESULT: state ${diffs.length === 0 ? "PRESERVED" : "NOT preserved (" + diffs.length + " differences)"}` +
    `${settleOk ? ", migrated policy settled" : ", migrated policy FAILED to settle"}.`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("harness error:", e.message); process.exitCode = 1; })
  .finally(() => { if (sandbox) { try { sandbox.kill("SIGKILL"); } catch {} } });
