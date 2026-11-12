// Controlled v3 deployment — an INDEPENDENT contract account with freshly
// generated, operator-controlled credentials — and a full security proof of the
// decentralised design against the real compiled module.
//
//   node proof/controlled-v3-deploy.mjs --plan       # prints the plan; sends nothing
//   node proof/controlled-v3-deploy.mjs --sandbox    # runs the whole proof on a local neard
//   node proof/controlled-v3-deploy.mjs              # deploys + verifies on NEAR testnet
//
// Why this exists
// ---------------
// The legacy contract `contract.attestor-overcover.testnet` still runs v1 with the
// unauthenticated `migrate()` takeover (finding SEC-1) and its FullAccess private
// key is not held by anyone in this environment (see docs/AUTHORITY_RECOVERY.md).
// This harness does NOT touch that account. It stands up a *separate* contract on
// a *fresh* account whose keys we generate and hold, so the decentralised v3
// design can be demonstrated and verified end to end without any claim over the
// legacy contract's address, capital or policies.
//
// Testnet mode creates the whole identity graph from the free testnet faucet (one
// funded top-level account, the rest funded sub-accounts). Sandbox mode uses a
// local neard validator as the funding root, needs no funds and no network, and is
// the same proof when the faucet is unavailable — but its evidence is labelled
// SANDBOX, never TESTNET.
//
// Both modes deploy the COMPILED v3 wasm, configure a 3-of-5 operator quorum and
// a 3-of-5 resolver quorum, and then prove the security properties against the
// real deployed module:
//   * the operator/resolver registries and the 3-of-5 thresholds;
//   * a sub-quorum (2-of-5) does NOT finalise an observation;
//   * a forged operator signature is refused;
//   * a non-operator cannot report;
//   * the owner CANNOT vote on a dispute (no unilateral adjudication);
//   * an operator that signed the reading cannot vote on its dispute;
//   * the challenger cannot resolve their own dispute;
//   * a real challenge is decided by an independent resolver quorum;
//   * a third-party `migrate()` is refused (SEC-1 closed on the new module);
//   * the pool reserves capital per policy, settles it, and stays solvent.
//
// Evidence (contract id, wasm sha256, every tx hash, every check) is written to
// proof/controlled-v3-deploy.json (testnet) or proof/controlled-v3-sandbox.json
// (sandbox). Generated testnet keys are written ONLY to the gitignored
// keys/controlled-v3.json (mode 0600) and are never printed.
//
// Testnet mode requires the faucet. If it is rate-limited the script SKIPs
// cleanly (exit 0) unless REQUIRE_TESTNET=1, in which case it fails loudly.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, utils, providers } from "near-api-js";
import { parseBigIntJson } from "../agent/json.mjs";
import { readingMessageV3 } from "../driver/attestor.js";
import { ensureSandboxBin } from "../scripts/sandbox-bin.mjs";
import { underfundedRoles } from "./gas-budget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = process.env.OVERCOVER_WASM || path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const GUARD = "migrate may only be called by the contract account itself";
const RPC = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"];
const NEAR = (s) => utils.format.parseNearAmount(String(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PLAN = process.argv.includes("--plan");
const SANDBOX = process.argv.includes("--sandbox");
const REQUIRE = process.env.REQUIRE_TESTNET === "1" || (SANDBOX && process.env.REQUIRE_SANDBOX === "1");
const ts = Date.now().toString(36);
// A hard wall-clock cap: the harness must never hang a CI runner. If it is hit
// the process fails loudly, and (in sandbox mode) the node is killed below.
const HARD_TIMEOUT_MS = Number(process.env.OVERCOVER_PROOF_TIMEOUT_MS ?? (SANDBOX ? 300000 : 480000));
const SEND_RETRIES = Number(process.env.OVERCOVER_SEND_RETRIES ?? 6);

const SANDBOX_HOME = process.env.NEAR_SANDBOX_HOME || path.join("/tmp", "overcover-v3-deploy-" + process.pid);
// A unique port per process: a leftover node from a previous run would otherwise
// answer our RPC and serve a half-initialised contract.
const SANDBOX_PORT = Number(process.env.NEAR_SANDBOX_PORT || (3000 + (process.pid % 1000)));
const SANDBOX_URL = `http://127.0.0.1:${SANDBOX_PORT}`;

// The accelerated window used while the proof runs; the production-sensible
// window is restored afterwards (per-policy the window is frozen at purchase, so
// the demo policies keep the short window and later policies get the long one).
const DEMO_WINDOW = Number(process.env.OVERCOVER_CHALLENGE_WINDOW ?? (SANDBOX ? 20 : 60));
const PROD_WINDOW = Number(process.env.OVERCOVER_PRODUCTION_WINDOW ?? 3600);
const QUORUM = Number(process.env.OVERCOVER_QUORUM ?? 3); // 3-of-5
const RESOLVER_QUORUM = Number(process.env.OVERCOVER_RESOLVER_QUORUM ?? 3); // 3-of-5
const DISPUTE_WINDOW_SEC = Number(process.env.OVERCOVER_DISPUTE_WINDOW ?? 3600);
const CHALLENGE_BOND_NEAR = "0.1";
// Per-call gas. The NEAR RPC reserves `gas_limit * gas_price` (1e9 yocto/Gas on
// testnet) against the signer's balance *before* execution, so a 300 Tgas limit
// demands a 0.3 NEAR float from every signer — more than the operator/resolver
// accounts are funded with. The contract's heaviest call (buy_cover, a state
// write plus an event) burns well under 20 Tgas, so 100 Tgas is ample and keeps
// the required float at ~0.1 NEAR. The sandbox validator's gas_price is ~0, so
// this only ever binds on testnet.
const GAS = process.env.OVERCOVER_GAS ?? "100000000000000";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("error", reject); p.on("close", (c) => resolve({ code: c, out }));
  });
}

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
    if (res.status === 429 || res.status === 403 || /rate limit|too many/i.test(body)) return null;
    throw new Error(`faucet ${res.status}: ${body.slice(0, 200)}`);
  }
  throw new Error(`no free name for ${base}`);
}

/** Start a local neard sandbox and return a bootstrap shaped like the testnet one. */
async function bootstrapSandbox() {
  const bin = await ensureSandboxBin();
  if (!bin || !fs.existsSync(bin)) return null;
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  const init = await run(bin, ["--home", SANDBOX_HOME, "init"]);
  if (init.code !== 0) throw new Error("sandbox init failed: " + init.out);
  // The default config pins the P2P port at 24567, so a second sandbox would
  // collide and panic. Give this node a unique port derived from ours.
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
  return { near, ks, rootId: vk.account_id, network: "local", endpoints: [SANDBOX_URL], keepKeys: false };
}

/** Create the funding root on real testnet from the free faucet. */
async function bootstrapTestnet() {
  const rootKp = KeyPair.fromRandom("ed25519");
  const rootId = await faucet(`ovc-v3-ctl-${ts}`, rootKp.getPublicKey().toString());
  if (!rootId) return null;
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("testnet", rootId, rootKp);
  const near = await connect({ networkId: "testnet", nodeUrl: RPC[0], keyStore: ks, headers: {} });
  near.connection.provider = new providers.FailoverRpcProvider(RPC.map((url) => new providers.JsonRpcProvider({ url })));
  await sleep(3000);
  return { near, ks, rootId, network: "testnet", endpoints: RPC, keepKeys: true };
}

async function main() {
  if (!fs.existsSync(WASM)) throw new Error(`no wasm at ${WASM}; build it first`);
  const wasm = fs.readFileSync(WASM);
  const sha = createHash("sha256").update(wasm).digest("hex");

  // Fail closed on a stale artifact: deploying a wasm without the SEC-1 guard
  // would ship the takeover vulnerability.
  if (!wasm.toString("latin1").includes(GUARD)) {
    throw new Error("refusing to deploy: wasm lacks the SEC-1 self-call guard. Rebuild with the pinned toolchain.");
  }

  const ops = 5, res = 5;
  // The contract must cover its own code stake (~5 NEAR for ~490 KB) plus state,
  // so it is funded generously. Every *other* account is a signer, and the RPC
  // reserves `gas_limit * gas_price` (≈0.1 NEAR at the 100 Tgas limit used here)
  // against the signer before execution — so each signer must hold its largest
  // attached deposit PLUS that reserve, not merely the deposit. Testnet is kept
  // under the 10 NEAR a single faucet account grants; the sandbox validator is
  // rich, so the same shape is scaled up.
  const SCALE = SANDBOX ? 5 : 1;
  const funding = { contract: 6 * SCALE, owner: 0.8 * SCALE, buyer: 0.3 * SCALE, attacker: 0.35 * SCALE };
  for (let i = 0; i < ops; i++) funding[`op${i + 1}`] = 0.15 * SCALE;
  for (let i = 0; i < res; i++) funding[`res${i + 1}`] = 0.15 * SCALE;
  const total = Object.values(funding).reduce((a, b) => a + b, 0);

  if (PLAN) {
    console.log(`Controlled v3 deployment plan (fresh, independent account)\n`);
    console.log(`  mode            ${SANDBOX ? "SANDBOX (local neard, no funds)" : "TESTNET (free faucet)"}`);
    console.log(`  wasm            ${WASM}`);
    console.log(`  wasm sha256     ${sha}`);
    console.log(`  wasm size       ${wasm.length} bytes`);
    console.log(`  SEC-1 guard     present (third-party migrate refused)`);
    console.log(`  operator quorum ${QUORUM}-of-${ops}`);
    console.log(`  resolver quorum ${RESOLVER_QUORUM}-of-${res}`);
    console.log(`  challenge window ${DEMO_WINDOW}s (accelerated demo) -> ${PROD_WINDOW}s (restored after proof)`);
    console.log(`  dispute window  ${DISPUTE_WINDOW_SEC}s\n`);
    if (!SANDBOX) {
      console.log(`Funding (all from ONE faucet account, then sub-accounts):`);
      for (const [k, v] of Object.entries(funding)) console.log(`  ${k.padEnd(10)} ${v} NEAR`);
      console.log(`  TOTAL       ${total.toFixed(2)} NEAR  (the free faucet grants 10 NEAR per account)\n`);
    }
    console.log(`Transactions: CREATE_ACCOUNT x${Object.keys(funding).length + 1}, DeployContract, new(),`);
    console.log(`   set_quorum, set_resolver_quorum, set_challenge_window, set_dispute_window, add_metric,`);
    console.log(`   add_metric_product, add_operator x${ops}, add_resolver x${res}, deposit, buy_cover,`);
    console.log(`   submit_reading, challenge_observation, resolver_vote, resolve, migrate(attacker -> refused).`);
    console.log(`\n--plan: nothing sent. This deploys a NEW account; it never touches the legacy contract.`);
    return;
  }

  // --- fresh, operator-controlled identity graph ---------------------------
  const b = SANDBOX ? await bootstrapSandbox() : await bootstrapTestnet();
  if (!b) {
    if (REQUIRE) throw new Error("bootstrap unavailable (faucet rate-limited or no sandbox binary)");
    console.log(`SKIP  ${SANDBOX ? "no neard >= 2.14 sandbox binary" : "testnet faucet unavailable (rate-limited)"}. Re-run when it recovers.`);
    return;
  }
  const { near, ks, rootId, network, endpoints } = b;
  check(`created the funding root (${network})`, true, rootId);

  const EVIDENCE_PATH = path.join(root, "proof", SANDBOX ? "controlled-v3-sandbox.json" : "controlled-v3-deploy.json");
  const KEYS_OUT = path.join(root, "keys", "controlled-v3.json");
  const evidence = { mode: SANDBOX ? "SANDBOX" : "TESTNET", network, rootId, wasmSha256: sha, wasmBytes: wasm.length, txs: {}, checks: results };
  // Every key this run generates, so an interrupted run is still recoverable:
  // the deployment account's FullAccess key is created here and nowhere else, so
  // losing it orphans a funded contract on-chain. Written incrementally (mode
  // 0600, gitignored) rather than only on success.
  const keyMaterial = {};
  const writeKeys = () => {
    if (!b.keepKeys) return;
    fs.mkdirSync(path.dirname(KEYS_OUT), { recursive: true });
    fs.writeFileSync(KEYS_OUT, JSON.stringify({ note: "generated by proof/controlled-v3-deploy.mjs; never commit", rootId, contractId: evidence.contractId, keys: keyMaterial }, null, 2));
    fs.chmodSync(KEYS_OUT, 0o600);
  };
  const persist = () => {
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    writeKeys();
  };

  async function send(id, fn) {
    let last;
    for (let i = 0; i < SEND_RETRIES; i++) {
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
    const out = await send(rootId, (a) => a.createAccount(id, kp.getPublicKey(), NEAR(fund)));
    evidence.txs[`create:${name}`] = out.transaction_outcome?.id;
    await ks.setKey(network, id, kp);
    keyMaterial[id] = kp.toString();
    persist();
    const acct = await near.account(id); acct.kp = kp; acct.id = id; roles[name] = acct; return acct;
  }

  const owner = await sub("owner", String(funding.owner));
  const buyer = await sub("buyer", String(funding.buyer));
  const attacker = await sub("attacker", String(funding.attacker));
  const operators = [];
  for (let i = 1; i <= ops; i++) operators.push(await sub(`op${i}`, String(funding[`op${i}`])));
  const resolvers = [];
  for (let i = 1; i <= res; i++) resolvers.push(await sub(`res${i}`, String(funding[`res${i}`])));
  const CONTRACT = `contract.${rootId}`;
  const ckp = KeyPair.fromRandom("ed25519");
  const cout = await send(rootId, (a) => a.createAccount(CONTRACT, ckp.getPublicKey(), NEAR(String(funding.contract))));
  evidence.txs["create:contract"] = cout.transaction_outcome?.id;
  await ks.setKey(network, CONTRACT, ckp);
  keyMaterial[CONTRACT] = ckp.toString();
  evidence.contractId = CONTRACT;
  persist();
  await sleep(3000);
  evidence.ownerId = owner.id;
  evidence.operatorIds = operators.map((o) => o.id);
  evidence.resolverIds = resolvers.map((r) => r.id);
  check("created the identity graph + contract account", true, CONTRACT);

  // Fail closed on underfunding BEFORE the deploy spends the most gas: the RPC
  // reserves `gas_limit * gas_price` against the signer of every call, on top of
  // any attached deposit, so a signer funded with only its deposit is refused.
  // (This is exactly what silently passed in the sandbox, where gas_price ≈ 0.)
  if (!SANDBOX) {
    const gp = BigInt((await near.connection.provider.gasPrice(null)).gas_price);
    const float = BigInt(GAS) * gp;
    const short = underfundedRoles(funding, { gasLimit: BigInt(GAS), gasPriceYocto: gp, challengeBondYocto: NEAR(CHALLENGE_BOND_NEAR) });
    if (short.length) {
      throw new Error(`underfunded signer(s) at gas price ${gp}: ${short.map((s) => `${s.role} has ${s.balance} needs ${s.required}`).join("; ")}`);
    }
    evidence.gasFloatYocto = float.toString();
    evidence.gasPrice = gp.toString();
  }

  // --- deploy + initialise --------------------------------------------------
  const depOut = await send(CONTRACT, (a) => a.deployContract(wasm));
  evidence.txs.deploy = depOut.transaction_outcome?.id;
  check("deployed the compiled v3 wasm", true, `${wasm.length} bytes, sha256 ${sha.slice(0, 16)}…`);

  const attestorKey = KeyPair.fromRandom("ed25519");
  const initArgs = { owner: owner.id, attestor: Array.from(attestorKey.getPublicKey().data), challenge_bond: NEAR(CHALLENGE_BOND_NEAR), settle_delay_sec: 0, challenge_window_sec: DEMO_WINDOW };
  const initOut = await send(CONTRACT, (a) => a.functionCall({ contractId: CONTRACT, methodName: "new", args: initArgs, gas: GAS, attachedDeposit: "0" }));
  evidence.txs.new = initOut.transaction_outcome?.id;

  const rawView = async (m, a = {}) => {
    let lastErr = "";
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) });
        const j = await r.json();
        if (j.result) {
          if (j.result.result === undefined && j.result.error) { lastErr = String(j.result.error); continue; }
          return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
        }
        lastErr = JSON.stringify(j.error || j);
      } catch (e) { lastErr = String(e?.message || e); }
    }
    throw new Error(`rawView ${m} failed: ${lastErr.slice(0, 200)}`);
  };
  // `new()` returns as soon as it executes, but a finality:final read can land on
  // a block that has not yet included the initialisation receipt; the contract
  // then has no state and reading it traps. Wait until the state is visible.
  let cfg;
  for (let i = 0; i < 30; i++) {
    try { cfg = await rawView("get_config"); if (cfg && cfg.owner) break; } catch { /* not committed yet */ }
    await sleep(1000);
  }
  if (!cfg || !cfg.owner) throw new Error("contract did not initialise");
  // A finality:final read lags a just-submitted write by a block. Wait until the
  // chain has finalised a block after the one the write landed in.
  const waitFinal = async (h0) => {
    for (let i = 0; i < 40; i++) {
      const h = (await near.connection.provider.block({ finality: "final" })).header.height;
      if (h > h0) return;
      await sleep(500);
    }
  };
  const call = (acct, m, a = {}, dep = "0") => send(acct.id, async (x) => {
    const h = (await near.connection.provider.block({ finality: "final" })).header.height;
    const o = await x.functionCall({ contractId: CONTRACT, methodName: m, args: a, gas: GAS, attachedDeposit: dep });
    // near-api-js resolves even when the receipt failed; surface the real reason
    // instead of silently continuing with state that never changed.
    if (o.status && o.status.Failure) {
      throw new Error(JSON.stringify(o.status.Failure).slice(0, 300));
    }
    await waitFinal(h);
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
  // "final" can lag the tip by a block or more, which made a fresh observation
  // date read as already-past. "optimistic" returns the latest block the node
  // has seen, which is what a just-submitted transaction will execute against.
  const blockNow = async () => Number((await near.connection.provider.block({ finality: "optimistic" })).header.timestamp) / 1e9;

  check("initialised with the controlled owner", cfg.owner === owner.id, `owner=${cfg.owner}`);
  check("challenge window is the accelerated demo value", Number(cfg.challenge_window_sec) === DEMO_WINDOW, `window=${cfg.challenge_window_sec}s`);

  // --- configure: quorum, resolvers, metrics, operators ---------------------
  evidence.txs.set_quorum = txOf(await call(owner, "set_quorum", { quorum: QUORUM }));
  evidence.txs.set_resolver_quorum = txOf(await call(owner, "set_resolver_quorum", { quorum: RESOLVER_QUORUM }));
  evidence.txs.set_dispute_window = txOf(await call(owner, "set_dispute_window", { secs: DISPUTE_WINDOW_SEC }));
  await call(owner, "add_metric", { id: "heat", category: "temperature", unit: "degC/10", max_value: 700, scale: 10, direction: "Above" });
  await call(owner, "add_metric_product", { id: "heat-lagos", city: "lagos", metric_id: "heat", threshold_tenths: 400, premium_bp: 500, min_payout: NEAR("0.1"), max_payout: NEAR("2"), min_lead_sec: 0, max_total_coverage: NEAR("20") });
  for (const o of operators) await call(owner, "add_operator", { account: o.id, public_key: Array.from(o.kp.getPublicKey().data) });
  for (const r of resolvers) await call(owner, "add_resolver", { account: r.id });

  const opsList = await rawView("list_operators");
  const resList = await rawView("list_resolvers");
  check("five operators are registered (3-of-5)", opsList.length === 5 && opsList.every((o) => o.active), `active=${opsList.filter((o) => o.active).length}`);
  check("five independent resolvers are registered (3-of-5)", resList.length === 5 && resList.every((r) => r.active), `active=${resList.filter((r) => r.active).length}`);
  check("the operators are distinct accounts", new Set(opsList.map((o) => o.account)).size === 5);
  check("the resolvers are distinct accounts", new Set(resList.map((r) => r.account)).size === 5);
  check("no operator or resolver is the owner (no shared controller)", !opsList.some((o) => o.account === owner.id) && !resList.some((r) => r.account === owner.id));

  const prod = await rawView("get_product", { id: "heat-lagos" });
  check("the metric product is published", prod && prod.metric_id === "heat", prod ? `${prod.id}/${prod.metric_id}` : "missing");

  // --- fund the pool and buy a policy (human path) --------------------------
  evidence.txs.deposit = txOf(await call(owner, "deposit", {}, NEAR("0.5")));
  const pool0 = await rawView("get_pool");
  check("the pool holds the deposit", BigInt(pool0.capital) === BigInt(NEAR("0.5")), `capital=${pool0.capital}`);

  // The observation must be dated far enough ahead that it is still in the
  // future when `buy_cover` executes. The local sandbox finalises in well under
  // a second, but a public testnet read can be several seconds stale, so the
  // testnet lead is wider. If the contract still refuses because the date read
  // as already-past, refresh the date from the tip and retry rather than aborting
  // a funded lifecycle over clock skew.
  let obsDate = Math.floor(await blockNow()) + (SANDBOX ? 3 : 30);
  const payout = NEAR("0.3");
  const quote = await rawView("quote", { product_id: "heat-lagos", payout });
  let policyId;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      policyId = await callRet(buyer, "buy_cover", { product_id: "heat-lagos", payout, obs_date: obsDate, beneficiary: null }, String(quote));
      break;
    } catch (e) {
      if (attempt === 3 || !/observation date too soon/i.test(String(e.message))) throw e;
      obsDate = Math.floor(await blockNow()) + (SANDBOX ? 3 : 45);
      await sleep(1500);
    }
  }
  evidence.obsDate = obsDate;
  evidence.policyId = Number(policyId);
  check("buy_cover returns a policy id", policyId !== undefined && policyId !== null, `policy=${policyId}`);
  const pol = await rawView("get_policy", { id: Number(policyId) });
  check("the policy belongs to the buyer and froze the challenge window", pol.buyer === buyer.id && Number(pol.challenge_window_sec) === DEMO_WINDOW, `buyer=${pol.buyer} window=${pol.challenge_window_sec}`);
  const pool1 = await rawView("get_pool");
  check("the payout is reserved against capital", BigInt(pool1.reserved) === BigInt(payout), `reserved=${pool1.reserved}`);

  // --- oracle: forged signer, non-operator, sub-quorum, then 3-of-5 ---------
  while ((await blockNow()) < obsDate + 1) await sleep(500);
  const value = 450;
  const reportedAt = obsDate;
  const expiry = reportedAt + 6 * 3600;
  const evidenceBytes = Buffer.from("controlled-v3-evidence");
  const sig = (op, nonce) => Array.from(op.kp.sign(readingMessageV3({ operator: op.id, metricId: "heat", city: "lagos", obsDate, valueTenths: value, reportedAt, expiry, evidenceHash: Array.from(evidenceBytes), nonce, contractId: CONTRACT })).signature);
  const baseArgs = { metric_id: "heat", city: "lagos", obs_date: obsDate, value_tenths: value, reported_at: reportedAt, expiry, evidence_hash: Array.from(evidenceBytes) };

  const forged = await callErr(operators[0], "submit_reading", { ...baseArgs, nonce: 0, signature: sig(operators[1], 0) });
  check("a forged operator signature is refused", /invalid operator signature/i.test(forged || ""), (forged || "").slice(0, 80));

  const notOp = await callErr(attacker, "submit_reading", { ...baseArgs, nonce: 0, signature: sig(operators[0], 0) });
  check("a non-operator cannot submit a reading", /not a registered operator/i.test(notOp || ""), (notOp || "").slice(0, 80));

  await call(operators[0], "submit_reading", { ...baseArgs, nonce: 0, signature: sig(operators[0], 0) });
  const twoOnly = await callRet(operators[1], "submit_reading", { ...baseArgs, nonce: 0, signature: sig(operators[1], 0) });
  const obsTwo = await rawView("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("a 2-of-5 sub-quorum does NOT finalise (threshold enforced)", Number(twoOnly) === 0 && obsTwo === null, `finalized=${twoOnly} observation=${obsTwo === null ? "none" : "present"}`);

  const finalized = await callRet(operators[2], "submit_reading", { ...baseArgs, nonce: 0, signature: sig(operators[2], 0) });
  const obs = await rawView("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("a 3-of-5 quorum finalises the observation", Number(finalized) === QUORUM && obs && Number(obs.value_tenths) === value, `quorum=${finalized} value=${obs && obs.value_tenths}`);

  // --- dispute: challenge + independent resolver quorum ---------------------
  const bond = NEAR(CHALLENGE_BOND_NEAR);
  evidence.txs.challenge = txOf(await call(attacker, "challenge_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate, counter_value_tenths: 100 }, bond));
  const disp = await rawView("get_dispute", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("the observation is disputed", disp && disp.opened_at > 0, `threshold=${disp && disp.threshold}`);

  const ownerVote = await callErr(owner, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  check("the OWNER cannot vote on a dispute (no unilateral adjudication)", /owner may not vote/i.test(ownerVote || ""), (ownerVote || "").slice(0, 80));

  const signerVote = await callErr(operators[0], "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  check("an operator that signed the reading cannot resolve its own dispute", /may not resolve|not a registered resolver/i.test(signerVote || ""), (signerVote || "").slice(0, 80));

  const challengerVote = await callErr(attacker, "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  check("the challenger cannot resolve their own dispute", /challenger may not|not a registered resolver/i.test(challengerVote || ""), (challengerVote || "").slice(0, 80));

  await call(resolvers[0], "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  await call(resolvers[1], "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true });
  evidence.txs.resolver_vote = txOf(await call(resolvers[2], "resolver_vote", { metric_id: "heat", city: "lagos", obs_date: obsDate, uphold: true }));
  const obsAfter = await rawView("get_observation", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  const dispAfter = await rawView("get_dispute", { metric_id: "heat", city: "lagos", obs_date: obsDate });
  check("a 3-of-5 resolver quorum upholds the reading", obsAfter && obsAfter.disputed === false && obsAfter.nullified === false && dispAfter.uphold === true, `disputed=${obsAfter && obsAfter.disputed} uphold=${dispAfter && dispAfter.uphold}`);

  // --- settle the policy ----------------------------------------------------
  const deadline = reportedAt + DEMO_WINDOW + 2;
  while ((await blockNow()) < deadline) await sleep(1000);
  evidence.txs.resolve = txOf(await call(owner, "resolve", { policy_id: Number(policyId) }));
  const polAfter = await rawView("get_policy", { id: Number(policyId) });
  check("the policy settled and paid (value above threshold)", polAfter.status === "settled_paid" && BigInt(polAfter.paid_amount) === BigInt(payout), `status=${polAfter.status} paid=${polAfter.paid_amount}`);
  const poolAfter = await rawView("get_pool");
  check("the pool released the reservation and stayed solvent", BigInt(poolAfter.reserved) === 0n && poolAfter.solvent === true, `reserved=${poolAfter.reserved} solvent=${poolAfter.solvent}`);

  // --- SEC-1 on the new module: third-party migrate refused -----------------
  let refused = null;
  try { await call(attacker, "migrate", initArgs); } catch (e) { refused = e.message || String(e); }
  check("SEC-1 closed on the new module: third-party migrate() is refused", !!refused && refused.includes(GUARD), (refused || "ACCEPTED — vulnerable!").slice(0, 90));
  const cfgAfter = await rawView("get_config");
  check("the owner is unchanged after the refused migrate", cfgAfter.owner === owner.id);

  // --- restore the production-sensible challenge window ---------------------
  evidence.txs.set_prod_window = txOf(await call(owner, "set_challenge_window", { secs: PROD_WINDOW }));
  const cfgProd = await rawView("get_config");
  check("the production challenge window is restored for future policies", Number(cfgProd.challenge_window_sec) === PROD_WINDOW, `window=${cfgProd.challenge_window_sec}s`);

  const passed = results.filter((r) => r.ok).length;
  evidence.passed = passed;
  evidence.total = results.length;
  evidence.config = cfgAfter;
  persist();
  console.log(`\n${passed}/${results.length} controlled-v3 checks passed (${evidence.mode}). Contract: ${CONTRACT}`);
  console.log(`Evidence: ${path.relative(root, EVIDENCE_PATH)}`);
  if (b.keepKeys) console.log(`Keys (gitignored, 0600): ${path.relative(root, KEYS_OUT)}`);
  if (passed !== results.length) process.exitCode = 1;
}

// A hard wall-clock cap so the harness can never hang a CI runner: whichever of
// the proof or the deadline settles first wins. On timeout (or any failure) the
// process exits explicitly, which fires the sandbox `process.on("exit")` hook
// that kills the stray neard node.
const withDeadline = (p) => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`proof exceeded ${HARD_TIMEOUT_MS} ms`)), HARD_TIMEOUT_MS); t.unref?.(); }),
]);

withDeadline(main()).then(
  () => process.exit(process.exitCode || 0),
  (e) => { console.error("FATAL", e?.message || e); process.exit(1); },
);
