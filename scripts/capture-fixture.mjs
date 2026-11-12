// Freeze a read-only snapshot of the deployed contract into a fixture, so the
// console tests can exercise the REAL page code offline and deterministically.
//
//   node scripts/capture-fixture.mjs
//
// The fixture is test data, not product data: it is a point-in-time copy of what
// the contract returned, used only to drive the browser tests without a network.
// It is never served to a user and never substituted for a live read in
// production. `captured_at` records when it was taken.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "https://test.rpc.fastnear.com";
// The default contract the console reads and signs against. The fixture mirrors
// that default so the offline tests exercise the shipped destination.
const CONTRACT = "contract.ovc-v3-ctl-2f6c4c.testnet";
const VIEWS = ["get_pool", "get_config", "list_products", "list_policies", "list_observations", "list_metrics", "list_operators", "reconcile", "check_invariant"];

const rpc = async (body) =>
  (await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

async function callView(method) {
  const r = await rpc({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from("{}").toString("base64") },
  });
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return Buffer.from(r.result.result).toString("utf8");
}

const views = {};
for (const m of VIEWS) views[m] = await callView(m);

// The console quotes a specific (product, payout); freeze the quotes the tests
// exercise so the page's view("quote", …) call resolves offline.
const quotes = {};
for (const [productId, payout] of [
  ["heat-lagos", "100000000000000000000000"],
  ["heat-lagos", "300000000000000000000000"],
]) {
  const r = await rpc({
    jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: "quote", args_base64: Buffer.from(JSON.stringify({ product_id: productId, payout })).toString("base64") },
  });
  if (r.error) throw new Error(`quote(${productId},${payout}): ${r.error.message}`);
  quotes[`${productId}:${payout}`] = Buffer.from(r.result.result).toString("utf8");
}

const acct = await rpc({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: CONTRACT } });
if (acct.error) throw new Error(`view_account: ${acct.error.message}`);

const out = {
  _note: "Frozen read-only snapshot of the deployed contract for hermetic console tests. Test data, not live data. Regenerate with scripts/capture-fixture.mjs.",
  captured_at: new Date().toISOString(),
  contract: CONTRACT,
  views,
  quotes,
  view_account: { code_hash: acct.result.code_hash, amount: acct.result.amount },
};

const dest = path.join(root, "tests", "fixtures", "contract-snapshot.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.relative(root, dest)} — ${VIEWS.length} views at ${out.captured_at}`);
