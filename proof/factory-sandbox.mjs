// Permissionless insurance factory — end-to-end proof on a LOCAL sandbox.
//
//   node proof/factory-sandbox.mjs
//
// Runs the real compiled wasm on a local neard validator and proves, against
// the live contract (not a unit-test mock):
//
//   * a NON-OWNER wallet submits a proposal and the product activates with no
//     owner transaction;
//   * the contract's fixed rules refuse an unknown metric, an out-of-band
//     premium, an excessive payout, a non-prospective coverage start, a
//     duplicate id, an under-funded stake, and a proposal that would
//     overcommit the pool;
//   * the proposer's stake enters the pool and the accounting reconciles;
//   * the existing purchase path buys cover on the permissionlessly-created
//     product, reserves capital and keeps the pool solvent;
//   * the owner path (add_metric_product) still works unchanged.
//
// Evidence is written to proof/factory-sandbox.json and labelled SANDBOX. It is
// NEVER presented as a testnet transaction. When the testnet faucet recovers,
// the same factory flow can be driven against a fresh testnet deployment by
// proof/controlled-v3-deploy.mjs; this file deliberately does not touch any
// existing account.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { parseBigIntJson } from "../agent/json.mjs";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const GAS = "100000000000000"; // 100 Tgas
const NEAR = (s) => utils.format.parseNearAmount(String(s));
const ONE = 1_000_000_000_000_000_000_000_000n;
const PROPOSAL_MIN_STAKE = "0.1";

const SANDBOX_HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-factory-" + process.pid);
const SANDBOX_PORT = Number(process.env.NEAR_SANDBOX_PORT || (4000 + (process.pid % 1000)));
const SANDBOX_URL = `http://127.0.0.1:${SANDBOX_PORT}`;
const HARD_TIMEOUT_MS = Number(process.env.OVERCOVER_PROOF_TIMEOUT_MS ?? 300000);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("error", reject); p.on("close", (c) => resolve({ code: c, out }));
  });
}

async function bootstrapSandbox() {
  const bin = await ensureSandboxBin();
  if (!bin || !fs.existsSync(bin)) return null;
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  const init = await run(bin, ["--home", SANDBOX_HOME, "init"]);
  if (init.code !== 0) throw new Error("sandbox init failed: " + init.out);
  const cfgPath = path.join(SANDBOX_HOME, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.network = cfg.network || {};
  cfg.network.addr = `0.0.0.0:${SANDBOX_PORT + 1}`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn(bin, ["--home", SANDBOX_HOME, "run", "--rpc-addr", `0.0.0.0:${SANDBOX_PORT}`], { stdio: ["ignore", "ignore", "inherit"] });
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${SANDBOX_URL}/status`); if (r.ok) break; } catch { /* not up */ }
    if (i === 59) throw new Error("sandbox RPC did not come up");
    await sleep(1000);
  }
  const vk = JSON.parse(fs.readFileSync(path.join(SANDBOX_HOME, "validator_key.json"), "utf8"));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("local", vk.account_id, KeyPair.fromString(vk.secret_key));
  const near = await connect({ networkId: "local", nodeUrl: SANDBOX_URL, keyStore: ks, headers: {} });
  return { near, ks, rootId: vk.account_id };
}

async function main() {
  if (!fs.existsSync(WASM)) throw new Error(`no wasm at ${WASM}; build it first`);
  const wasm = fs.readFileSync(WASM);
  const sha = createHash("sha256").update(wasm).digest("hex");

  const b = await bootstrapSandbox();
  if (!b) {
    if (process.env.REQUIRE_SANDBOX === "1") throw new Error("no neard >= 2.14 sandbox binary (REQUIRE_SANDBOX=1)");
    console.log("SKIP  no neard >= 2.14 sandbox binary. Re-run where the sandbox is available.");
    return;
  }
  const { near, ks, rootId } = b;
  const network = "local";
  const evidence = { mode: "SANDBOX", network, wasmSha256: sha, wasmBytes: wasm.length, txs: {}, checks: results };
  const persist = () => fs.writeFileSync(path.join(root, "proof", "factory-sandbox.json"), JSON.stringify(evidence, null, 2));

  async function send(id, fn) {
    const a = await near.account(id);
    for (let i = 0; i < 4; i++) {
      try { return await fn(a); } catch (e) {
        if (i === 3) throw e;
        await sleep(2000);
      }
    }
  }
  async function sub(name, fund) {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${rootId}`;
    const out = await send(rootId, (a) => a.createAccount(id, kp.getPublicKey(), NEAR(fund)));
    evidence.txs[`create:${name}`] = out.transaction_outcome?.id;
    await ks.setKey(network, id, kp);
    const acct = await near.account(id);
    return { id, acct };
  }

  const owner = await sub("owner", "20");
  const proposer = await sub("proposer", "5");   // NON-owner
  const buyer = await sub("buyer", "5");
  const attacker = await sub("attacker", "5");
  const CONTRACT = `contract.${rootId}`;
  const ckp = KeyPair.fromRandom("ed25519");
  const cout = await send(rootId, (a) => a.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("15")));
  evidence.txs["create:contract"] = cout.transaction_outcome?.id;
  await ks.setKey(network, CONTRACT, ckp);
  evidence.contractId = CONTRACT;
  evidence.ownerId = owner.id;
  evidence.proposerId = proposer.id;
  persist();
  await sleep(2000);

  await send(CONTRACT, (a) => a.deployContract(wasm));
  check("deployed the factory wasm to a fresh sandbox contract", true, `${wasm.length} bytes, sha256 ${sha.slice(0, 16)}…`);
  const attestorKey = KeyPair.fromRandom("ed25519");
  const initArgs = { owner: owner.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 3600 };
  await send(CONTRACT, (a) => a.functionCall({ contractId: CONTRACT, methodName: "new", args: initArgs, gas: GAS, attachedDeposit: "0" }));

  const rawView = async (m, a = {}) => {
    const r = await fetch(SANDBOX_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) });
    const j = await r.json();
    if (!j.result) throw new Error(JSON.stringify(j.error).slice(0, 200));
    if (j.result.result === undefined && j.result.error) throw new Error(String(j.result.error).slice(0, 200));
    return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
  };
  let cfg;
  for (let i = 0; i < 30; i++) { try { cfg = await rawView("get_config"); if (cfg?.owner) break; } catch { /* not committed */ } await sleep(1000); }
  check("initialised with the controlled owner", cfg?.owner === owner.id, `owner=${cfg?.owner}`);

  const blockNow = async () => Number((await near.connection.provider.block({ finality: "optimistic" })).header.timestamp) / 1e9;
  const call = (acct, m, a = {}, dep = "0") => send(acct.id, async (x) => {
    const o = await x.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: GAS, attachedDeposit: dep });
    if (o.status?.Failure) throw new Error(JSON.stringify(o.status.Failure).slice(0, 300));
    return o;
  });
  const callRet = async (acct, m, a = {}, dep = "0") => {
    const o = await call(acct, m, a, dep);
    const sv = o.status?.SuccessValue;
    if (sv === undefined) return undefined;
    const s = Buffer.from(sv, "base64").toString("utf8");
    try { return JSON.parse(s); } catch { return s; }
  };
  const callErr = async (acct, m, a = {}, dep = "0") => { try { await call(acct, m, a, dep); return null; } catch (e) { return e.message || String(e); } };
  const txOf = (o) => o.transaction_outcome?.id;

  // --- owner registers the index and seeds the pool -------------------------
  await call(owner, "add_metric", { id: "heat", category: "temperature", unit: "degC/10", max_value: 700, scale: 10, direction: "Above" });
  evidence.txs.deposit = txOf(await call(owner, "deposit", {}, NEAR("10")));
  const pool0 = await rawView("get_pool");
  check("pool seeded with capital", BigInt(pool0.capital) === BigInt(NEAR("10")), `capital=${pool0.capital}`);

  // A valid proposal (max_payout 1 NEAR -> capacity 5 NEAR, ceiling = 10 - 2 = 8).
  const now = Math.floor(await blockNow());
  const base = { id: "heat-lagos-factory", city: "lagos", metric_id: "heat", threshold_tenths: 400, premium_bp: 500, min_payout: NEAR("0.1"), max_payout: NEAR("1"), coverage_start: now + 7200, evidence_hash: "sha256:open-meteo-heat-lagos" };

  // --- THE KEY PROOF: a non-owner proposes and it activates -----------------
  const proposeOut = await call(proposer, "propose_product", base, NEAR(PROPOSAL_MIN_STAKE));
  evidence.txs.propose_product = txOf(proposeOut);
  const stored = await rawView("get_product", { id: base.id });
  check("a NON-OWNER proposal activates a product with no owner transaction", stored && stored.active === true, `active=${stored?.active}`);
  check("the product records the proposer (not the owner)", stored?.proposed_by === proposer.id, `proposed_by=${stored?.proposed_by}`);
  check("the product records the immutable evidence reference", stored?.evidence_hash === base.evidence_hash, `evidence=${stored?.evidence_hash}`);
  check("the product is written against the registered metric", stored?.metric_id === "heat" && stored?.category === "temperature", `metric=${stored?.metric_id}`);
  check("the product appears in the public product list", (await rawView("list_products")).some((p) => p.id === base.id));

  // --- adversarial: every guard refuses ------------------------------------
  const r1 = await callErr(proposer, "propose_product", { ...base, id: "x1", metric_id: "nope" }, NEAR(PROPOSAL_MIN_STAKE));
  check("an unknown metric is refused", /no such metric/i.test(r1 || ""), (r1 || "").slice(0, 70));
  const r2 = await callErr(proposer, "propose_product", { ...base, id: "x2", premium_bp: 9000 }, NEAR(PROPOSAL_MIN_STAKE));
  check("an out-of-band premium is refused", /premium_bp out of range/i.test(r2 || ""), (r2 || "").slice(0, 70));
  const r3 = await callErr(proposer, "propose_product", { ...base, id: "x3", threshold_tenths: 900 }, NEAR(PROPOSAL_MIN_STAKE));
  check("an implausible threshold is refused", /threshold above metric max_value/i.test(r3 || ""), (r3 || "").slice(0, 70));
  const r4 = await callErr(proposer, "propose_product", { ...base, id: "x4", max_payout: NEAR("100") }, NEAR(PROPOSAL_MIN_STAKE));
  check("an excessive payout is refused", /exceeds available capital|overcommit/i.test(r4 || ""), (r4 || "").slice(0, 70));
  const r5 = await callErr(proposer, "propose_product", { ...base, id: "x5", coverage_start: now }, NEAR(PROPOSAL_MIN_STAKE));
  check("a non-prospective coverage start is refused", /prospective/i.test(r5 || ""), (r5 || "").slice(0, 70));
  const r6 = await callErr(proposer, "propose_product", base, NEAR(PROPOSAL_MIN_STAKE));
  check("a duplicate product id is refused (terms immutable)", /already exists/i.test(r6 || ""), (r6 || "").slice(0, 70));
  const r7 = await callErr(proposer, "propose_product", { ...base, id: "x7" }, "0");
  check("an under-funded stake is refused", /stake below minimum/i.test(r7 || ""), (r7 || "").slice(0, 70));
  const r8 = await callErr(attacker, "propose_product", { ...base, id: "x8" }, NEAR(PROPOSAL_MIN_STAKE));
  check("a second full-size proposal cannot overcommit the pool", /overcommit|exceeds available capital/i.test(r8 || ""), (r8 || "").slice(0, 70));

  // --- the proposer's stake entered the pool and reconciles -----------------
  const pool1 = await rawView("get_pool");
  check("the proposer's stake entered the pool", BigInt(pool1.capital) === BigInt(NEAR("10")) + BigInt(NEAR(PROPOSAL_MIN_STAKE)), `capital=${pool1.capital}`);
  check("pool accounting reconciles after a proposal", await rawView("reconcile") === true);

  // --- existing purchase path buys cover on the proposed product ------------
  const payout = NEAR("0.5");
  const quote = await rawView("quote", { product_id: base.id, payout });
  const policyId = await callRet(buyer, "buy_cover", { product_id: base.id, payout, obs_date: now + 7200, beneficiary: null }, String(quote));
  const pol = await rawView("get_policy", { id: Number(policyId) });
  check("a buyer purchases cover on the permissionlessly-created product", pol?.buyer === buyer.id && BigInt(pol?.payout) === BigInt(payout), `policy=${policyId} buyer=${pol?.buyer}`);
  const pool2 = await rawView("get_pool");
  check("the payout is reserved and the pool stays solvent", BigInt(pool2.reserved) === BigInt(payout) && pool2.solvent === true, `reserved=${pool2.reserved} solvent=${pool2.solvent}`);
  check("the pool still reconciles after the purchase", await rawView("reconcile") === true);

  // --- the owner path is unchanged ------------------------------------------
  await call(owner, "add_metric_product", { id: "heat-owner-path", city: "lagos", metric_id: "heat", threshold_tenths: 400, premium_bp: 500, min_payout: NEAR("0.1"), max_payout: NEAR("1"), min_lead_sec: 0, max_total_coverage: NEAR("1") });
  const ownerProd = await rawView("get_product", { id: "heat-owner-path" });
  check("the owner path (add_metric_product) still works unchanged", ownerProd?.active === true, `active=${ownerProd?.active}`);

  const passed = results.filter((r) => r.ok).length;
  evidence.passed = passed;
  evidence.total = results.length;
  evidence.productId = base.id;
  evidence.policyId = Number(policyId);
  persist();
  console.log(`\n${passed}/${results.length} factory checks passed (SANDBOX). Contract: ${CONTRACT}`);
  console.log(`Evidence: proof/factory-sandbox.json`);
  if (passed !== results.length) process.exitCode = 1;
}

const withDeadline = (p) => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`proof exceeded ${HARD_TIMEOUT_MS} ms`)), HARD_TIMEOUT_MS); t.unref?.(); }),
]);

withDeadline(main()).then(
  () => process.exit(process.exitCode || 0),
  (e) => { console.error("\nFACTORY PROOF FAILED:", e?.stack || e); process.exit(1); },
);
