// Reads the PUBLIC state of the two controlled-v3 contract accounts that the
// deployment proof stood up on NEAR testnet and writes proof/controlled-v3-deploy.json.
//
// The generated identity graph's keys were lost when the first two runs aborted
// mid-lifecycle (before the incremental-persistence fix), so the FULL 29-check
// proof could not be re-run in the same session — the faucet then rate-limited for
// 12 h. This script therefore records only what is INDEPENDENTLY verifiable from
// public RPC + the nearblocks indexer: the deployed code hash, the initialised
// config, the operator/resolver registries, the pool, the live policy, and every
// transaction hash. It never asserts the checks it cannot run.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://test.rpc.fastnear.com";
const INDEXER = "https://api-testnet.nearblocks.io/v3/accounts";
const WASM = path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const OUT = path.join(root, "proof/controlled-v3-onchain-evidence.json");

const CONTRACTS = [
  { account: "contract.ovc-v3-ctl-mwd32f3w.testnet", label: "run 1 (pre-fix harness; buy_cover reached via a separate probe)" },
  { account: "contract.ovc-v3-ctl-mwd3judn.testnet", label: "run 2 (post gas/funding fix; full lifecycle to buy_cover)" },
];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

async function rpc(body) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

async function viewAccount(account) {
  const d = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } });
  return d.result;
}

async function viewKeys(account) {
  const d = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } });
  return d.result?.keys ?? [];
}

// The strongest available check: fetch the deployed module bytes and hash them
// ourselves, rather than trusting the account's reported code_hash.
async function viewCode(account) {
  const d = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: account } });
  const code = d.result?.code_base64;
  if (!code) return null;
  const bytes = Buffer.from(code, "base64");
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), hasSec1Guard: bytes.includes("migrate may only be called by the contract account itself") };
}

async function call(account, method, args = {}) {
  const d = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: b64(args) } });
  const res = d.result;
  if (!res || res.result === undefined || res.result === null) return null;
  return JSON.parse(Buffer.from(res.result).toString("utf8"));
}

async function indexerTxns(account) {
  const r = await fetch(`${INDEXER}/${account}/txns?limit=100&order=asc`);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data ?? []).map((t) => ({
    tx: t.transaction_hash,
    block: Number(t.block?.block_height),
    signer: t.signer_account_id,
    actions: (t.actions ?? []).map((a) => a.action),
    method: (t.actions ?? []).find((a) => a.method)?.method ?? null,
    success: t.outcomes?.status === true || t.outcome?.status === true || undefined,
  }));
}

const wasm = fs.readFileSync(WASM);
const wasmSha256 = createHash("sha256").update(wasm).digest("hex");

const out = {
  note: "Public, independently re-derivable evidence for the controlled v3 testnet deployments. No private keys. Regenerate with `node proof/controlled-v3-evidence.mjs`.",
  mode: "TESTNET",
  generatedAt: new Date().toISOString(),
  wasm: { path: path.relative(root, WASM), bytes: wasm.length, sha256: wasmSha256 },
  contracts: [],
};

for (const { account, label } of CONTRACTS) {
  const a = await viewAccount(account);
  const keys = await viewKeys(account);
  const deployed = await viewCode(account);
  const [cfg, operators, resolvers, metrics, products, policies, pool] = await Promise.all([
    call(account, "get_config"),
    call(account, "list_operators"),
    call(account, "list_resolvers"),
    call(account, "list_metrics"),
    call(account, "list_products"),
    call(account, "list_policies"),
    call(account, "get_pool"),
  ]);
  const codeHashHex = Buffer.from(
    (await import("bs58")).default.decode(a?.code_hash ?? ""),
  ).toString("hex");
  out.contracts.push({
    label,
    account,
    exists: !!a,
    codeHashBase58: a?.code_hash,
    codeHashHex,
    deployedCode: deployed,
    wasmSha256MatchesDeployedCode: deployed ? deployed.sha256 === wasmSha256 : null,
    balanceYocto: a?.amount,
    storageUsage: a?.storage_usage,
    accessKeys: keys.map((k) => ({ publicKey: k.public_key, permission: k.access_key?.permission })),
    config: cfg,
    operators: operators ?? [],
    resolvers: resolvers ?? [],
    metrics: metrics ?? [],
    products: products ?? [],
    pool,
    policies: policies ?? [],
    txns: await indexerTxns(account),
  });
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${path.relative(root, OUT)}`);
for (const c of out.contracts) {
  console.log(`  ${c.account}: exists=${c.exists} keys=${c.accessKeys.length} ops=${c.operators.length} res=${c.resolvers.length} policies=${c.policies.length} txns=${c.txns.length}`);
}
