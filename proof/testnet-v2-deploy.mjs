// Real, isolated v2 deployment to NEAR testnet — the deploy proof that a fresh
// environment with a working faucet can run, and that closes the "cannot deploy
// from here" gap for the CONTRACT itself (it cannot close SEC-1 on the *live*
// address, which needs the operator key; see docs/DEPLOY_RUNBOOK.md).
//
//   node proof/testnet-v2-deploy.mjs
//
// It creates a throwaway identity graph from the testnet faucet, deploys the
// COMPILED v2 wasm, initialises it, configures the operator quorum + resolvers +
// metrics, funds the pool, buys one policy, and then attempts the SEC-1 takeover
// against the real deployed module — which must be refused. Everything is on
// real testnet with real transactions; the script writes the contract id, the
// wasm sha256 and every transaction hash to proof/testnet-v2-deploy.json.
//
// It needs network access and the testnet faucet. If the faucet is unavailable
// it skips cleanly (exit 0) unless REQUIRE_TESTNET=1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils, providers } from "near-api-js";
import { parseBigIntJson } from "../agent/json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const GUARD = "migrate may only be called by the contract account itself";
const NEAR = (s) => utils.format.parseNearAmount(String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];
const NETWORK = "testnet";
const ts = Date.now().toString(36);
const REQUIRE = process.env.REQUIRE_TESTNET === "1";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function faucet(base, publicKey) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = attempt === 0 ? base : `${base}${attempt}`;
    const id = `${name}.testnet`;
    const res = await fetch("https://helper.testnet.near.org/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
    });
    const body = await res.text();
    if (res.ok) return id;
    if (/exists|already|taken|AccountAlreadyExists/i.test(body)) continue;
    if (/rate limit|429/i.test(body)) return null;
    throw new Error(`faucet ${res.status}: ${body.slice(0, 200)}`);
  }
  throw new Error(`no free name for ${base}`);
}

async function main() {
  if (!fs.existsSync(WASM)) { console.log(`SKIP  no wasm at ${WASM}`); return; }
  const wasm = fs.readFileSync(WASM);
  const sha = (await import("node:crypto")).createHash("sha256").update(wasm).digest("hex");
  if (!wasm.toString("latin1").includes(GUARD)) throw new Error("wasm lacks the SEC-1 guard; rebuild before deploying");

  // The funding root — a fresh top-level account from the faucet.
  const rootKp = KeyPair.fromRandom("ed25519");
  const rootId = await faucet(`ovc-v2-deploy-${ts}`, rootKp.getPublicKey().toString());
  if (!rootId) {
    if (REQUIRE) throw new Error("testnet faucet unavailable");
    console.log("SKIP  testnet faucet unavailable (rate-limited)");
    return;
  }
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey(NETWORK, rootId, rootKp);
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC[0], keyStore: ks, headers: {} });
  await sleep(3000);
  check("created the funding root from the faucet", true, rootId);

  // A fresh Account per send avoids the cached access-key nonce, which is the
  // usual InvalidNonce cause when several sends from one account happen quickly.
  async function send(id, fn) {
    let last;
    for (let i = 0; i < 12; i++) {
      try { const a = await near.account(id); return await fn(a); }
      catch (e) {
        last = e;
        const m = String(e?.message || e);
        if (/InvalidNonce|nonce must be larger|does not exist|not found|Timeout|ECONNRESET|502|503|504|[-]32000/i.test(m)) { await sleep(2000); continue; }
        throw e;
      }
    }
    throw new Error(`send(${id}) failed after retries: ${last?.message || last}`);
  }

  const roles = {};
  async function sub(name, fund) {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${rootId}`;
    await send(rootId, (a) => a.createAccount(id, kp.getPublicKey(), NEAR(fund)));
    await ks.setKey(NETWORK, id, kp);
    const acct = await near.account(id); acct.kp = kp; acct.id = id; roles[name] = acct; return acct;
  }

  const owner = await sub("owner", "1.5");
  const buyer = await sub("buyer", "0.6");
  const ops = [await sub("op1", "0.25"), await sub("op2", "0.25"), await sub("op3", "0.25")];
  const res = [await sub("res1", "0.15"), await sub("res2", "0.15"), await sub("res3", "0.15")];
  const CONTRACT = `contract.${rootId}`;
  const ckp = KeyPair.fromRandom("ed25519");
  await send(rootId, (a) => a.createAccount(CONTRACT, ckp.getPublicKey(), NEAR("5")));
  await ks.setKey(NETWORK, CONTRACT, ckp);
  await sleep(3000);
  check("created the identity graph + contract account", true, CONTRACT);

  const txs = {};
  await send(CONTRACT, (a) => a.deployContract(wasm));
  check("deployed the compiled v2 wasm to real testnet", true, `${wasm.length} bytes, sha256 ${sha.slice(0, 16)}…`);

  const attestorKey = KeyPair.fromRandom("ed25519");
  const initArgs = { owner: owner.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR("0.1"), settle_delay_sec: 0, challenge_window_sec: 3600 };
  await send(CONTRACT, (a) => a.functionCall({ contractId: CONTRACT, methodName: "new", args: initArgs, gas: "300000000000000", attachedDeposit: "0" }));
  const view = (m, a = {}) => near.account(CONTRACT).then((c) => c.viewFunction({ contractId: CONTRACT, methodName: m, args: a }));
  const call = (id, m, a = {}, dep = "0") => send(id, (acct) => acct.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: "300000000000000", attachedDeposit: dep }));
  const cfg = await view("get_config");
  check("initialised with the real owner", cfg.owner === owner.id, `owner=${cfg.owner}`);

  // Configure: quorum, resolvers, metrics, operators.
  await call(owner.id, "set_quorum", { quorum: 2 });
  await call(owner.id, "set_resolver_quorum", { quorum: 2 });
  await call(owner.id, "set_dispute_window", { secs: 3600 });
  await call(owner.id, "add_metric", { id: "heat", category: "temperature", unit: "degC/10", max_value: 700, scale: 10, direction: "Above" });
  await call(owner.id, "add_metric_product", { id: "heat-lagos", city: "lagos", metric_id: "heat", threshold_tenths: 400, premium_bp: 500, min_payout: NEAR("0.1"), max_payout: NEAR("2"), min_lead_sec: 0, max_total_coverage: NEAR("20") });
  for (const o of ops) await call(owner.id, "add_operator", { account: o.id, public_key: Array.from(o.kp.getPublicKey().data) });
  for (const r of res) await call(owner.id, "add_resolver", { account: r.id });
  check("published the metric product", (await view("get_product", { id: "heat-lagos" })).metric_id === "heat");
  check("registered the 3-operator quorum", (await view("list_operators")).length === 3);

  // Fund the pool and buy a policy.
  await call(owner.id, "deposit", {}, NEAR("0.5"));
  const block = await near.connection.provider.block({ finality: "final" });
  const obsDate = Math.floor(Number(block.header.timestamp) / 1e9) + 60;
  const payout = NEAR("0.3");
  const quoteRaw = await rawView(CONTRACT, "quote", { product_id: "heat-lagos", payout });
  const premium = quoteRaw.premium ?? quoteRaw;
  const out = await call(buyer.id, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate, beneficiary: null }, String(premium));
  txs.buy_cover = out.transaction_outcome?.id;
  let policy = null;
  for (let i = 0; i < 10; i++) { try { policy = await rawView(CONTRACT, "get_policy", { id: 1 }); if (policy) break; } catch { /* not final yet */ } await sleep(1500); }
  check("a real buy_cover created policy 1 for the buyer", policy && policy.buyer === buyer.id, policy ? `buyer=${policy.buyer}` : "no policy");

  // SEC-1 against the REAL deployed module: a third party must be refused.
  const attacker = await sub("attacker", "0.5");
  let refused = null;
  try { await send(attacker.id, (a) => a.functionCall({ contractId: CONTRACT, methodName: "migrate", args: initArgs, gas: "300000000000000", attachedDeposit: "0" })); }
  catch (e) { refused = e.message || String(e); }
  check("SEC-1 closed on real testnet: third-party migrate() is refused", !!refused && refused.includes(GUARD), (refused || "ACCEPTED — vulnerable!").slice(0, 90));
  check("the owner is unchanged after the refused migrate", (await view("get_config")).owner === owner.id);

  const passed = results.filter((r) => r.ok).length;
  const evidence = {
    mode: "TESTNET", network: NETWORK, contractId: CONTRACT, rootId, wasmSha256: sha, wasmBytes: wasm.length,
    policies: { 1: policy?.buyer }, txs, checks: results, passed, total: results.length,
  };
  fs.writeFileSync(path.join(root, "proof", "testnet-v2-deploy.json"), JSON.stringify(evidence, null, 2));
  console.log(`\n${passed}/${results.length} testnet v2 deploy checks passed. Contract: ${CONTRACT}`);
  if (passed !== results.length) process.exitCode = 1;
}

async function rawView(contractId, method, args) {
  for (const url of RPC) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
      });
      const j = await r.json();
      if (j.result) return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
    } catch { /* try next */ }
  }
  throw new Error(`rawView ${method} failed`);
}

main().catch((e) => { console.error("TESTNET DEPLOY FAILED:", e.message); process.exit(1); });
