// Read-only reconciliation of the two live Overcover testnet contracts.
//
// This script NEVER signs, never sends a transaction and never needs a key. It
// only calls `view` methods over public RPC and writes what the chain returns
// to proof/legacy-reconciliation.json. A method that does not exist on a
// contract is recorded as an error, not guessed.
//
//   node scripts/legacy-reconciliation.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.OVERCOVER_RPC || "https://rpc.testnet.fastnear.com";

const CONTRACTS = {
  v3: "contract.ovc-v3-ctl-2f6c4c.testnet",
  legacy_v1: "contract.attestor-overcover.testnet",
};

// View methods to try on each contract. Missing methods return an RPC error,
// which is itself the evidence that the contract is the expected generation.
const METHODS = [
  ["get_config", {}],
  ["get_pool", {}],
  ["list_products", {}],
  ["list_policies", {}],
  ["list_observations", {}],
  ["list_metrics", {}],
  ["list_operators", {}],
  ["list_resolvers", {}],
  ["reconcile", {}],
  ["check_invariant", {}],
];

async function view(account, method, args) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: {
        request_type: "call_function", finality: "final", account_id: account,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error) return { error: j.error.cause?.name || j.error.message || "error" };
  const bytes = j.result?.result || [];
  const text = Buffer.from(bytes).toString("utf8");
  try { return { value: JSON.parse(text) }; } catch { return { raw: text }; }
}

async function accountState(account) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "view_account", finality: "final", account_id: account } }),
  });
  const j = await res.json();
  const r = j.result || {};
  return { amount_yocto: r.amount, code_hash: r.code_hash, storage_usage: r.storage_usage };
}

async function accessKeys(account) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "view_access_key_list", finality: "final", account_id: account } }),
  });
  const j = await res.json();
  return (j.result?.keys || []).map((k) => ({
    public_key: k.public_key,
    permission: typeof k.access_key.permission === "string"
      ? k.access_key.permission : Object.keys(k.access_key.permission)[0],
  }));
}

const out = { generated_at: new Date().toISOString(), rpc: RPC, network: "testnet", contracts: {} };

for (const [label, account] of Object.entries(CONTRACTS)) {
  const entry = { account_id: account, state: await accountState(account), access_keys: await accessKeys(account), views: {} };
  for (const [method, args] of METHODS) {
    entry.views[method] = await view(account, method, args);
  }
  out.contracts[label] = entry;
}

const dest = path.join(root, "proof", "legacy-reconciliation.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");

const near = (y) => (y == null ? "?" : (Number(y) / 1e24).toFixed(4));
for (const [label, e] of Object.entries(out.contracts)) {
  console.log(`\n=== ${label} — ${e.account_id} ===`);
  console.log(`  balance ${near(e.state.amount_yocto)} NEAR | code_hash ${String(e.state.code_hash).slice(0, 12)} | keys ${e.access_keys.length}`);
  const cfg = e.views.get_config?.value;
  if (cfg) console.log(`  owner ${cfg.owner} | attestor ${cfg.attestor} | paused ${cfg.paused} | generation ${cfg.quorum ? "v3+" : "v1"}`);
  const pool = e.views.get_pool?.value;
  if (pool) console.log(`  capital ${near(pool.capital)} | reserved ${near(pool.reserved)} | available ${near(pool.available ?? (Number(pool.capital) - Number(pool.reserved)))} NEAR`);
  const pol = e.views.list_policies?.value;
  if (Array.isArray(pol)) console.log(`  policies ${pol.length}`);
  for (const m of ["list_metrics", "list_operators", "list_resolvers", "reconcile", "check_invariant"]) {
    const v = e.views[m];
    console.log(`  ${m}: ${v.error ? "ERR(" + v.error + ")" : JSON.stringify(v.value)}`);
  }
}
console.log(`\nwritten: ${path.relative(root, dest)}`);
