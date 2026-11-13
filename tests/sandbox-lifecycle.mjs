// End-to-end verification of the contract on a LOCAL NEAR sandbox.
//
//   NEAR_SANDBOX_BIN=/path/to/near-sandbox node tests/sandbox-lifecycle.mjs
//
// Unlike the model (a JavaScript re-implementation) and the Rust unit tests
// (which run inside `near-sdk`'s in-process test VM), this drives the COMPILED
// wasm through a real neard node over JSON-RPC: real signatures, real gas, real
// state, real promises. It is the closest thing to a testnet deployment that
// needs no funds and no network, so it can prove the lifecycle end to end.
//
// The neard build matters: the wasm is produced by a recent rustc, and the old
// near-sandbox (neard 2.6.2) cannot execute it. Use neard >= 2.14:
//
//   curl -sO https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz
//   tar xzf near-sandbox.tar.gz && export NEAR_SANDBOX_BIN=$PWD/Linux-x86_64/near-sandbox
//
// It skips cleanly (exit 0) when the binary or the built wasm is absent, so it
// never breaks a machine that has not set them up.
//
// It proves the decentralized lifecycle: the owner publishes a metric + product
// and registers an operator and resolver set; a buyer purchases; a 2-of-3
// operator quorum finalises an observation; a challenger disputes it; three
// independent resolvers decide it; the policy settles; the accounting
// reconciles. It also asserts the refusals: a wrong premium, a replayed nonce, a
// non-operator signer, a reporter voting on its own dispute, and a paused pool.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils } from "near-api-js";
import { readingMessageV3 } from "../driver/attestor.js";
import { parseBigIntJson } from "../agent/json.mjs";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
let SANDBOX = "";
const HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-sandbox-" + process.pid);
const PORT = Number(process.env.NEAR_SANDBOX_PORT || 3031);
const NODE_URL = `http://127.0.0.1:${PORT}`;
const NEAR = (s) => utils.format.parseNearAmount(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${NODE_URL}/status`); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

let sandbox;
async function main() {
  SANDBOX = await ensureSandboxBin();
  if (!SANDBOX || !fs.existsSync(SANDBOX)) { console.log("SKIP  no neard >= 2.14 sandbox binary (set NEAR_SANDBOX_BIN, or REQUIRE_SANDBOX=1 to fail)"); return; }
  if (!fs.existsSync(WASM)) { console.log(`SKIP  contract wasm not built at ${WASM} (run: cargo build --release --target wasm32-unknown-unknown)`); return; }

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

  const roles = {};
  async function account(name, fund = "50") {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${vk.account_id}`;
    let lastErr;
    for (let i = 0; i < 6; i++) {
      try { await master.createAccount(id, kp.getPublicKey(), NEAR(fund)); lastErr = null; break; }
      catch (e) { lastErr = e; await sleep(700); }
    }
    if (lastErr) throw new Error(`create ${id}: ${lastErr.message}`);
    await ks.setKey("local", id, kp);
    const acct = await near.account(id);
    acct.kp = kp;
    acct.id = id;
    roles[name] = acct;
    return acct;
  }
  const owner = await account("owner");
  const buyer = await account("buyer");
  const o1 = await account("op1"); const o2 = await account("op2"); const o3 = await account("op3");
  const r1 = await account("res1"); const r2 = await account("res2"); const r3 = await account("res3");
  const stranger = await account("stranger");
  check("created 9 accounts on the sandbox", Object.keys(roles).length === 9);

  const CONTRACT = `cover.${vk.account_id}`;
  const ckp = KeyPair.fromRandom("ed25519");
  await master.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("20"));
  await ks.setKey("local", CONTRACT, ckp);
  const c = await near.account(CONTRACT);
  await c.deployContract(fs.readFileSync(WASM));
  const attestorKey = KeyPair.fromRandom("ed25519");
  await c.functionCall({
    contractId: CONTRACT, methodName: "new",
    args: { owner: owner.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 20 },
    gas: "300000000000000", attachedDeposit: "0",
  });
  const cfg = await c.viewFunction({ contractId: CONTRACT, methodName: "get_config" });
  check("contract initialised with the owner", cfg.owner === owner.id, `owner=${cfg.owner}`);

  const view = (m, a = {}) => c.viewFunction({ contractId: CONTRACT, methodName: m, args: a });
  // near-api-js's view parses JSON with a plain JSON.parse, which rounds u128
  // money fields above 2^53 (1 NEAR = 1e24 yocto). Read exact big integers
  // straight from RPC with the project's parseBigIntJson instead.
  const rawView = async (m, a = {}) => {
    const r = await fetch(NODE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
  };
  const call = (acct, m, a = {}, dep = "0") => acct.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: "300000000000000", attachedDeposit: dep });
  // near-api-js returns the raw outcome; the method's JSON value lives in
  // status.SuccessValue (base64), not at the top level.
  const ret = (outcome) => {
    const sv = outcome && outcome.status && outcome.status.SuccessValue;
    if (sv === undefined) return undefined;
    const s = Buffer.from(sv, "base64").toString("utf8");
    try { return JSON.parse(s); } catch { return s; }
  };
  const callRet = async (acct, m, a = {}, dep = "0") => ret(await call(acct, m, a, dep));
  const callErr = async (acct, m, a = {}, dep = "0") => { try { await call(acct, m, a, dep); return null; } catch (e) { return e.message || String(e); } };
  // The contract reads the block timestamp, not the wall clock, so the harness
  // must anchor its dates to the chain to avoid a clock-skew race.
  const blockNow = async () => Number((await near.connection.provider.block({ finality: "final" })).header.timestamp) / 1e9;

  await call(owner, "add_metric", { id: "heat", category: "temperature", unit: "degC/10", max_value: 700, scale: 10, direction: "Above" });
  const metrics = await view("list_metrics");
  check("a temperature metric is registered (no rainfall assumption)", metrics.some((m) => m.id === "heat" && m.category === "temperature"), metrics.map((m) => m.id).join(","));
  await call(owner, "add_metric_product", {
    id: "heat-lagos", city: "lagos", metric_id: "heat", threshold_tenths: 400, premium_bp: 500,
    min_payout: NEAR("0.1"), max_payout: NEAR("5"), min_lead_sec: 0, max_total_coverage: NEAR("50"),
  });
  const prod = await view("get_product", { id: "heat-lagos" });
  check("the metric product is published", prod && prod.metric_id === "heat", prod ? `${prod.id}/${prod.metric_id}` : "missing");

  for (const o of [o1, o2, o3]) await call(owner, "add_operator", { account: o.id, public_key: Array.from(o.kp.getPublicKey().data) });
  for (const r of [r1, r2, r3]) await call(owner, "add_resolver", { account: r.id });
  await call(owner, "set_quorum", { quorum: 2 });
  await call(owner, "set_resolver_quorum", { quorum: 3 });
  const ops = await view("list_operators");
  check("three operators are registered", ops.length === 3, `active=${ops.filter((o) => o.active).length}`);

  await call(owner, "deposit", {}, NEAR("40"));
  const pool0 = await view("get_pool");
  check("pool holds the deposit", BigInt(pool0.capital) === BigInt(NEAR("40")), `capital=${utils.format.formatNearAmount(pool0.capital)}`);

  const obsDate = Math.floor(await blockNow()) + 3;
  const payout = NEAR("1");
  const quote = await view("quote", { product_id: "heat-lagos", payout });
  const policyId = await callRet(buyer, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate, beneficiary: null }, String(quote));
  check("buy_cover returns a policy id", policyId !== undefined && policyId !== null, `policy=${policyId}`);
  const pol = await view("get_policy", { id: Number(policyId) });
  check("the policy belongs to the buyer", pol.buyer === buyer.id && pol.direction === "Above", `buyer=${pol.buyer} direction=${pol.direction}`);

  const badDep = String(BigInt(quote) + 1n);
  const wrongPrem = await callErr(buyer, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate + 5, beneficiary: null }, badDep);
  check("a deposit that is not the quoted premium is refused", /quoted premium|deposit/.test(wrongPrem || ""), (wrongPrem || "").slice(0, 80));

  const value = 450;
  // The observation date must have passed before an operator may report it, so
  // wait for the chain clock to reach it (the sandbox clock is not the host's).
  while ((await blockNow()) < obsDate + 1) await sleep(500);
  const reportedAt = obsDate;
  const expiry = reportedAt + 6 * 3600;
  const evidence = Buffer.from("sandbox-evidence");
  const sig = (op, nonce) => {
    const msg = readingMessageV3({ operator: op.id, metricId: "heat", city: "lagos", obsDate, valueTenths: value, reportedAt, expiry, evidenceHash: Array.from(evidence), nonce, contractId: CONTRACT });
    return Array.from(op.kp.sign(msg).signature);
  };
  const baseArgs = { metric_id: "heat", city: "lagos", obs_date: obsDate, value_tenths: value, reported_at: reportedAt, expiry, evidence_hash: Array.from(evidence) };
  await call(o1, "submit_reading", { ...baseArgs, nonce: 0, signature: sig(o1, 0) });
  const finalized = await callRet(o2, "submit_reading", { ...baseArgs, nonce: 0, signature: sig(o2, 0) });
  check("a 2-of-3 quorum finalises the observation", Number(finalized) === 2, `quorum=${finalized}`);
  const obs = await view("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("the finalized value is stored", obs && Number(obs.value_tenths) === value, `value=${obs && obs.value_tenths}`);

  const replay = await callErr(o1, "submit_reading", { ...baseArgs, nonce: 0, signature: sig(o1, 0) });
  check("a replayed operator nonce is rejected", /nonce|already reported/i.test(replay || ""), (replay || "").slice(0, 80));

  const notOp = await callErr(stranger, "submit_reading", { ...baseArgs, nonce: 0, signature: sig(o1, 0) });
  check("a non-operator cannot submit a reading", /not a registered operator/i.test(notOp || ""), (notOp || "").slice(0, 80));

  await call(stranger, "challenge_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate, counter_value_tenths: 100 }, NEAR("0.1"));
  const obs2 = await view("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("the observation is marked disputed", obs2.disputed === true);

  const reporterVote = await callErr(o1, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  check("the reporter cannot vote on its own dispute", /resolver|operator/i.test(reporterVote || ""), (reporterVote || "").slice(0, 80));

  await call(r1, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  await call(r2, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  await call(r3, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  const obs3 = await view("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("a resolver quorum upholds the reading", obs3.disputed === false && obs3.nullified === false, `disputed=${obs3.disputed} nullified=${obs3.nullified}`);

  // The challenge window (5 s here) must elapse before the observation is
  // settle-able, so wait for the chain clock to clear it.
  while ((await blockNow()) < reportedAt + 22) await sleep(500);
  await call(owner, "resolve", { policy_id: Number(policyId) });
  // The settle transaction may not be final at the instant it returns, so poll
  // until the policy leaves "active" rather than racing the read.
  let pol2 = await rawView("get_policy", { id: Number(policyId) });
  for (let i = 0; i < 20 && pol2.status === "active"; i++) { await sleep(500); pol2 = await rawView("get_policy", { id: Number(policyId) }); }
  check("the policy settled and paid (value above threshold)", pol2.status === "settled_paid" && BigInt(pol2.paid_amount) === BigInt(payout), `status=${pol2.status} paid=${pol2.paid_amount}`);

  const pool = await view("get_pool");
  const rec = await view("reconcile");
  const inv = await view("check_invariant");
  check("reconcile() holds after settlement", rec === true, JSON.stringify(rec));
  check("check_invariant() holds after settlement", inv === true, JSON.stringify(inv));
  check("the reservation was released (reserved back to 0)", BigInt(pool.reserved) === 0n, `reserved=${pool.reserved}`);

  await call(owner, "set_paused", { paused: true });
  const pausedBuy = await callErr(buyer, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate + 100, beneficiary: null }, String(quote));
  check("a paused contract refuses purchases", /paused/i.test(pausedBuy || ""), (pausedBuy || "").slice(0, 80));
  await call(owner, "set_paused", { paused: false });

  // --- SEC-6: a terminally-invalid reading must not lock the reservation -----
  // Buy a second policy on a fresh date, finalise a reading, then have the
  // resolver quorum NULLIFY it. The policy can then never pay, so `resolve` must
  // settle it no-pay and RELEASE the reservation instead of leaving it locked
  // forever (which would strand providers' capital).
  const obsDate2 = Math.floor(await blockNow()) + 4;
  const quote2 = await view("quote", { product_id: "heat-lagos", payout });
  const policy2Id = await callRet(buyer, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate2, beneficiary: null }, String(quote2));
  while ((await blockNow()) < obsDate2 + 1) await sleep(500);
  const reportedAt2 = obsDate2;
  const expiry2 = reportedAt2 + 6 * 3600;
  const sig2 = (op, nonce) => {
    const msg = readingMessageV3({ operator: op.id, metricId: "heat", city: "lagos", obsDate: obsDate2, valueTenths: value, reportedAt: reportedAt2, expiry: expiry2, evidenceHash: Array.from(evidence), nonce, contractId: CONTRACT });
    return Array.from(op.kp.sign(msg).signature);
  };
  const baseArgs2 = { metric_id: "heat", city: "lagos", obs_date: obsDate2, value_tenths: value, reported_at: reportedAt2, expiry: expiry2, evidence_hash: Array.from(evidence) };
  // o1 and o2 each reported once in phase 1, so their monotonic nonce is now 1;
  // a 2-of-3 quorum is enough to finalise.
  await call(o1, "submit_reading", { ...baseArgs2, nonce: 1, signature: sig2(o1, 1) });
  await call(o2, "submit_reading", { ...baseArgs2, nonce: 1, signature: sig2(o2, 1) });
  await call(stranger, "challenge_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate2, counter_value_tenths: 100 }, NEAR("0.1"));
  await call(r1, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate2, uphold: false });
  await call(r2, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate2, uphold: false });
  await call(r3, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate2, uphold: false });
  const obs4 = await view("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate2 });
  check("SEC-6 a resolver quorum nullifies the reading", obs4.nullified === true, `nullified=${obs4.nullified}`);
  const reservedWithNullified = BigInt((await view("get_pool")).reserved);
  check("SEC-6 the nullified policy's payout is still reserved", reservedWithNullified >= BigInt(payout), `reserved=${reservedWithNullified}`);
  while ((await blockNow()) < reportedAt2 + 22) await sleep(500);
  const paid2 = await callRet(owner, "resolve", { policy_id: Number(policy2Id) });
  check("SEC-6 resolve on a nullified reading returns false (no payout)", paid2 === false || paid2 === "false", `resolve=${JSON.stringify(paid2)}`);
  let pol3 = await rawView("get_policy", { id: Number(policy2Id) });
  for (let i = 0; i < 20 && pol3.status === "active"; i++) { await sleep(500); pol3 = await rawView("get_policy", { id: Number(policy2Id) }); }
  check("SEC-6 the dead policy settles no-pay", pol3.status === "settled_no_pay" && BigInt(pol3.paid_amount) === 0n, `status=${pol3.status} paid=${pol3.paid_amount}`);
  const poolAfter = await view("get_pool");
  check("SEC-6 the reservation is RELEASED, not locked", BigInt(poolAfter.reserved) === reservedWithNullified - BigInt(payout), `reserved ${reservedWithNullified} -> ${poolAfter.reserved}`);
  check("SEC-6 the pool still reconciles and is solvent", (await view("reconcile")) === true && BigInt(poolAfter.reserved) <= BigInt(poolAfter.capital));
  // The stranded-capital symptom is gone: the depositor can now withdraw, whereas
  // a permanently-locked reservation would have made `withdraw` fail forever.
  const withdrawErr = await callErr(owner, "withdraw", { amount: NEAR("1") });
  check("SEC-6 a locked reservation would have blocked withdraw (now it does not)", !/solvency|reserved/i.test(withdrawErr || ""), (withdrawErr || "no error").slice(0, 80));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} sandbox checks passed.`);
  fs.writeFileSync(path.join(root, "proof", "sandbox-lifecycle.json"), JSON.stringify({ mode: "SANDBOX", nodeUrl: NODE_URL, contract: CONTRACT, checks: results, passed, total: results.length }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("sandbox harness error:", e.message); process.exitCode = 1; })
  .finally(() => { if (sandbox) { try { sandbox.kill("SIGKILL"); } catch { /* already gone */ } } });
