// In-place contract upgrade (deploy new wasm, then self-call migrate()).
//
//   node driver/upgrade.js --plan     # print the exact operations and costs, send nothing
//   node driver/upgrade.js            # deploy + self-call migrate + reconfigure
//
// Why this exists. `driver/deploy.js` DELETES and recreates the contract
// subaccount, which wipes all state (pool capital, policies, providers). For the
// SEC-1 fix that is unnecessary and destructive: the same address can be upgraded
// in place. `migrate()` is guarded to a self-call (predecessor == contract
// account), so the upgrade is a DeployContract action followed by a FunctionCall
// from the contract account to itself.
//
// It fails closed: if the built wasm does not contain the SEC-1 guard string, the
// script refuses to run. That guards against shipping a stale/unguarded artifact —
// exactly the mistake that would silently leave the vulnerability in place.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { connectNear, call, view, loadIdentities, loadState, saveState, WASM as DEFAULT_WASM, toYocto, txHash } from "./near.js";
import { configureContract } from "./deploy.js";

const CHALLENGE_BOND_NEAR = "0.1";
const SETTLE_DELAY_SEC = 0;
const CHALLENGE_WINDOW_SEC = Number(process.env.OVERCOVER_DEMO_WINDOW ?? 3600);
const QUORUM = Number(process.env.OVERCOVER_QUORUM ?? 3);
const RESOLVER_QUORUM = Number(process.env.OVERCOVER_RESOLVER_QUORUM ?? 3);
const DISPUTE_WINDOW_SEC = Number(process.env.OVERCOVER_DISPUTE_WINDOW ?? 3600);
const GUARD = "migrate may only be called by the contract account itself";
const WASM = process.env.OVERCOVER_WASM || DEFAULT_WASM;
const PLAN = process.argv.includes("--plan");

const RPC = process.env.OVERCOVER_RPC || "https://test.rpc.fastnear.com";

async function protocolConfig() {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_protocol_config", params: { finality: "final" } }),
  });
  return (await r.json()).result;
}

async function accountInfo(id) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }),
  });
  const j = await r.json();
  return j.result || null;
}

async function codeInfo(id) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: id } }),
  });
  const j = await r.json();
  return j.result || null;
}

async function main() {
  // --plan needs no key: it prints the operations and costs from public RPC.
  // The real upgrade needs keys/identities.json (the contract's full-access key
  // for the self-call migrate, and the owner key for the setters).
  let ids = null;
  try { ids = loadIdentities(); } catch { ids = null; }
  if (!ids && !PLAN) throw new Error("missing keys/identities.json; run: node driver/keys.js");

  const contractId = ids?.contract?.accountId || process.env.OVERCOVER_CONTRACT || "contract.attestor-overcover.testnet";
  const wasm = fs.readFileSync(WASM);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(wasm).digest("hex");

  if (!wasm.toString("latin1").includes(GUARD)) {
    throw new Error(`refusing to upgrade: ${WASM} does not contain the SEC-1 guard. Rebuild with the pinned toolchain (cargo build --release --target wasm32-unknown-unknown).`);
  }

  const pc = await protocolConfig();
  const storagePerByte = BigInt(pc.runtime_config.storage_amount_per_byte);
  const gasPrice = BigInt(pc.runtime_config.min_gas_price ?? "100000000");
  const deployExecGas = BigInt(pc.runtime_config.transaction_costs.action_creation_config.deploy_contract_cost.send_sir);
  const wasmStake = BigInt(wasm.length) * storagePerByte;
  const maxGas = 300_000_000_000_000n;

  const acct = await accountInfo(contractId);
  const code = await codeInfo(contractId);

  console.log(`In-place upgrade plan for ${contractId}\n`);
  console.log(`  new wasm        ${WASM}`);
  console.log(`  wasm sha256     ${sha}`);
  console.log(`  wasm size       ${wasm.length} bytes`);
  console.log(`  SEC-1 guard     present (self-call enforced)`);
  console.log(`  current code    ${code ? code.hash : "(none)"}`);
  console.log(`  account balance ${acct ? (Number(BigInt(acct.amount)) / 1e24).toFixed(4) : "?"} NEAR`);
  console.log(`  owner identity  ${ids ? ids.owner.accountId : "(no keys — plan only)"}`);
  console.log(`  contract key    ${ids?.contract?.secretKey ? "held (self-call migrate possible)" : "NOT held"}\n`);

  console.log(`Operations (2 transactions, both signed by ${contractId}'s full-access key):`);
  console.log(`  1. DeployContract  { code: ${wasm.length} bytes }`);
  console.log(`       gas:  ${deployExecGas} (~${(Number(deployExecGas) * Number(gasPrice) / 1e24).toFixed(6)} NEAR)`);
  console.log(`       stake for new code: ${(Number(wasmStake) / 1e24).toFixed(6)} NEAR (added to the account's locked balance)`);
  console.log(`  2. FunctionCall ${contractId}.migrate(owner, attestor, challenge_bond, settle_delay_sec, challenge_window_sec)`);
  console.log(`       predecessor == current_account_id -> passes the SEC-1 guard`);
  console.log(`       gas:  up to ${maxGas} (max ${(Number(maxGas) * Number(gasPrice) / 1e24).toFixed(6)} NEAR)`);
  console.log(`       then: set_quorum/set_resolver_quorum/set_dispute_window/add_operator/add_resolver/add_metric (owner-signed)\n`);
  console.log(`Estimated total cost: ~${((Number(wasmStake) + Number(deployExecGas) * Number(gasPrice)) / 1e24).toFixed(4)} NEAR (code stake is refundable on the next upgrade)`);
  console.log(`Required: ${contractId} must hold the ${(Number(wasmStake) / 1e24).toFixed(4)} NEAR code stake plus gas; current balance ${acct ? (Number(BigInt(acct.amount)) / 1e24).toFixed(4) : "?"} NEAR.`);

  if (PLAN) {
    console.log(`\n--plan: no transactions sent.`);
    return;
  }

  const near = await connectNear();
  const c = await near.account(contractId);
  console.log(`\ndeploying...`);
  await c.deployContract(wasm);
  console.log(`  deployed ${wasm.length} bytes`);

  const ownerKp = KeyPair.fromString(ids.attestor.secretKey);
  const ownerPub = Array.from(ownerKp.getPublicKey().data);
  const migrateArgs = {
    owner: ids.owner.accountId,
    attestor: ownerPub,
    challenge_bond: toYocto(CHALLENGE_BOND_NEAR),
    settle_delay_sec: SETTLE_DELAY_SEC,
    challenge_window_sec: CHALLENGE_WINDOW_SEC,
  };
  // Self-call: signer and receiver are both the contract account.
  const outcome = await call(near, contractId, contractId, "migrate", migrateArgs, "0");
  console.log(`  migrate self-call ok. tx: ${txHash(outcome)}`);

  await configureContract(near, ids, contractId, {
    quorum: QUORUM, resolverQuorum: RESOLVER_QUORUM, disputeWindowSec: DISPUTE_WINDOW_SEC,
    challengeBondYocto: toYocto(CHALLENGE_BOND_NEAR), challengeWindowSec: CHALLENGE_WINDOW_SEC,
  });

  const code2 = await codeInfo(contractId);
  console.log(`\nnew code hash: ${code2.hash}`);
  console.log(`config:  `, await view(near, contractId, "get_config", {}));
  console.log(`metrics: `, (await view(near, contractId, "list_metrics", {})).map((m) => m.id));

  const state = loadState();
  saveState({ ...state, upgradedFrom: code ? code.hash : null, codeHash: code2.hash, wasmSha256: sha });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error("UPGRADE FAILED:", e.message); process.exit(1); });
}
