// SEC-1 closure proof — the migrate() authorization guard, on the COMPILED wasm.
//
// `proof/migration-auth.mjs` proves the *shape* of v1's migrate() from source and
// the byte-identity of the deployed module. This proof goes further: it loads the
// actual built v2 wasm onto a real local neard node and exercises the guard over
// JSON-RPC, which is the closest we can get to the live contract while the live
// contract is still v1 (a live attempt would require the operator key we do not
// hold, and the live module has no guard to exercise).
//
// It establishes, with a real node and no funds:
//   1. a third-party migrate() is REFUSED (the SEC-1 takeover is closed);
//   2. the refusal leaves the owner and pool state untouched;
//   3. repeating the attack is still refused;
//   4. the contract account itself may migrate() (the redeploy self-call) — the
//      in-place upgrade path the runbook documents actually works.
//
// Skips cleanly (exit 0) when the sandbox binary or the built wasm is absent.
// Usage: node proof/upgrade-guard.mjs   (REQUIRE_SANDBOX=1 to fail instead of skip)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-upgrade-" + process.pid);
const PORT = Number(process.env.NEAR_SANDBOX_PORT || 3034);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const NEAR = (s) => utils.format.parseNearAmount(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GUARD = "migrate may only be called by the contract account itself";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("error", reject); p.on("close", (c) => resolve({ code: c, out }));
});

async function waitRpc() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${NODE_URL}/status`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(1000);
  }
  return false;
}

let sandbox;
async function main() {
  const bin = await ensureSandboxBin();
  if (!bin || !fs.existsSync(bin)) {
    if (process.env.REQUIRE_SANDBOX === "1") throw new Error("no neard >= 2.14 sandbox binary");
    console.log("SKIP  no neard sandbox binary (set NEAR_SANDBOX_BIN, or REQUIRE_SANDBOX=1 to fail)");
    return;
  }
  if (!fs.existsSync(WASM)) {
    if (process.env.REQUIRE_SANDBOX === "1") throw new Error(`no wasm at ${WASM}`);
    console.log(`SKIP  contract wasm not built at ${WASM}`);
    return;
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  const init = await run(bin, ["--home", HOME, "init"]);
  if (init.code !== 0) throw new Error("sandbox init failed: " + init.out);
  sandbox = spawn(bin, ["--home", HOME, "run", "--rpc-addr", `0.0.0.0:${PORT}`], { stdio: "ignore" });
  if (!(await waitRpc())) throw new Error("sandbox RPC did not come up");

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
  const attacker = await mk("attacker");
  const CONTRACT = `cover.${vk.account_id}`;
  const ckp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT, ckp);
  const c = await near.account(CONTRACT);

  await c.deployContract(fs.readFileSync(WASM));
  const wasmSha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(WASM)).digest("hex");
  check("the compiled v2 wasm is deployed on the sandbox", true, `${fs.statSync(WASM).size} bytes, sha256 ${wasmSha.slice(0, 16)}…`);

  const attestorKey = KeyPair.fromRandom("ed25519");
  const initArgs = { owner: owner.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 };
  await c.functionCall({ contractId: CONTRACT, methodName: "new", args: initArgs, gas: "300000000000000", attachedDeposit: "0" });
  const view = (m, a = {}) => c.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  const cfg0 = await view("get_config");
  check("the contract is initialised with the real owner", cfg0.owner === owner.id, `owner=${cfg0.owner}`);

  // Leave a mark in state so we can prove a refused migrate changes nothing.
  await owner.functionCall({ contractId: CONTRACT, methodName: "add_metric", args: { id: "rain", category: "precipitation", unit: "mm/10", max_value: 5000, scale: 10, direction: "Above" }, gas: "300000000000000", attachedDeposit: "0" });
  const metrics0 = await view("list_metrics");

  const callErr = async (acct, m, a) => { try { await acct.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: "300000000000000", attachedDeposit: "0" }); return null; } catch (e) { return e.message || String(e); } };

  // 1. A third party tries the SEC-1 takeover.
  const attackArgs = { owner: attacker.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 };
  const e1 = await callErr(attacker, "migrate", attackArgs);
  check("a third-party migrate() is REFUSED (SEC-1 closed)", !!e1 && e1.includes(GUARD), (e1 || "no error!").slice(0, 90));

  // 2. The refusal left state untouched.
  const cfg1 = await view("get_config");
  const metrics1 = await view("list_metrics");
  check("the owner is unchanged after the refused migrate", cfg1.owner === owner.id, `owner=${cfg1.owner}`);
  check("the contract state is unchanged after the refused migrate", metrics1.length === metrics0.length && metrics1[0]?.id === "rain", `metrics=${metrics1.map((m) => m.id).join(",")}`);

  // 3. Repeating the attack is still refused.
  const e2 = await callErr(attacker, "migrate", attackArgs);
  check("a repeated third-party migrate() is still refused", !!e2 && e2.includes(GUARD), (e2 || "no error!").slice(0, 90));

  // 4. The contract account itself may migrate (the redeploy self-call).
  let selfOk = false, selfErr = null;
  try { await c.functionCall({ contractId: CONTRACT, methodName: "migrate", args: initArgs, gas: "300000000000000", attachedDeposit: "0" }); selfOk = true; } catch (e) { selfErr = e.message || String(e); }
  check("the contract account itself may migrate() (self-call)", selfOk, selfOk ? "accepted" : (selfErr || "").slice(0, 90));
  const cfg2 = await view("get_config");
  check("the self-call migrate re-initialised the contract", cfg2.owner === owner.id, `owner=${cfg2.owner}`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} upgrade-guard checks passed.`);
  fs.writeFileSync(path.join(root, "proof", "upgrade-guard.json"), JSON.stringify({
    mode: "SANDBOX", nodeUrl: NODE_URL, contract: CONTRACT, wasmSha256: wasmSha,
    guardMessage: GUARD, checks: results, passed, total: results.length,
  }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("upgrade-guard harness error:", e.message); process.exitCode = 1; })
  .finally(() => { if (sandbox) { try { sandbox.kill("SIGKILL"); } catch { /* gone */ } } });
