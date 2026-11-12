// Proves the AI agent's spending-authorization engine against the REAL risk
// definition read from the live testnet contract.
//
//   node proof/agent-policy.mjs        # or: npm run verify:agent
//
// The decision itself is the shipped pure engine (agent/limits.mjs `evaluate`),
// which the autonomous agent calls before it will send anything. When the
// agent's own key is present locally (keys/agent.json, gitignored) the same two
// proposals are also run through the full shipped createAgent/decide path so the
// two agree. Nothing is broadcast: the agent is created in dry-run and the
// "blocked" case is refused before any network call.
//
// The "permitted" outcome is additionally backed by two real agent purchases
// already on testnet, listed from the committed evidence file
// (proof/agent-purchases.json), whose hashes and policies verify.mjs re-checks
// against the chain.
import fs from "node:fs";
import { evaluate, DEFAULT_LIMITS } from "../agent/limits.mjs";
import { parseBigIntJson } from "../agent/json.mjs";

const CONTRACT = "contract.ovc-v3-ctl-2f6c4c.testnet";
const RPC = "https://test.rpc.fastnear.com";

async function view(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  // Use the shipped exact-u128 parser, not JSON.parse: a bare number above
  // 2^53 is silently rounded by JSON.parse and would make money comparisons wrong.
  return parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
}

// The shipped createAgent/decide path is exercised with the operator's own key
// when it is present locally (keys/agent.json, gitignored). When it is not — a
// clean clone — a throwaway random key is used instead: `decide` only reads the
// product and the contract quote, so the account id is irrelevant and nothing is
// signed or broadcast (the agent is created in dry-run). This keeps the proof
// complete on a clean clone without needing any operator secret.
let key = null;
try { key = JSON.parse(fs.readFileSync(new URL("../keys/agent.json", import.meta.url), "utf8")); } catch { /* no local key: use a throwaway */ }
if (!key) {
  const { KeyPair } = await import("near-api-js");
  key = { accountId: "agent-proof-readonly.testnet", secretKey: KeyPair.fromRandom("ed25519").toString() };
}

const products = await view("list_products");
const product = products.find((p) => p.active) ?? products[0];
const maxPayout = BigInt(product.max_payout); // exact: the contract returns u128 as an integer literal
const nowSec = Math.floor(Date.now() / 1000);
const ctx = { limits: DEFAULT_LIMITS, history: [], nowMs: nowSec * 1000 };

const over = evaluate({ productId: product.id, city: product.city, payoutYocto: (maxPayout * 5n).toString(), premiumYocto: ((maxPayout * 5n) / 20n).toString(), obsDateSec: nowSec + 600, nowSec }, product, ctx);
const within = evaluate({ productId: product.id, city: product.city, payoutYocto: maxPayout.toString(), premiumYocto: (maxPayout / 20n).toString(), obsDateSec: nowSec + 600, nowSec }, product, ctx);

// Cross-check with the shipped createAgent/decide path.
let shippedPath = null;
{
  const { createAgent } = await import("../agent/agent.mjs");
  const agent = await createAgent({ accountId: key.accountId, secretKey: key.secretKey, contractId: CONTRACT, dryRun: true, auditPath: "/tmp/agent-policy-audit.jsonl" });
  const dBlocked = await agent.decide({ productId: product.id, payoutYocto: (maxPayout * 5n).toString(), obsDateSec: nowSec + 600 });
  const dOk = await agent.decide({ productId: product.id, payoutYocto: maxPayout.toString(), obsDateSec: nowSec + 600 });
  shippedPath = { blocked_allow: dBlocked.allow, permitted_allow: dOk.allow, agrees_with_engine: dBlocked.allow === over.allow && dOk.allow === within.allow };
}

// The agent's real purchases on this contract, from the committed evidence file
// (proof/agent-purchases-v3.json). verify.mjs re-derives each one from the chain.
const purchases = JSON.parse(fs.readFileSync(new URL("./agent-purchases-v3.json", import.meta.url), "utf8"));
const buys = purchases.purchases
  .map((e) => ({ productId: e.productId, payoutYocto: e.payoutYocto, premiumYocto: e.premiumYocto, tx: e.hash, policyId: e.policyId, explorer: `https://testnet.nearblocks.io/txns/${e.hash}` }));

const out = {
  contract: CONTRACT,
  product: { id: product.id, city: product.city, max_payout_yocto: product.max_payout },
  engine: { maxPayoutPerPolicy_yocto: DEFAULT_LIMITS.maxPayoutPerPolicy, maxPremiumPerPolicy_yocto: DEFAULT_LIMITS.maxPremiumPerPolicy, dailyPremiumBudget_yocto: DEFAULT_LIMITS.dailyPremiumBudget },
  blocked_case: { proposal: "payout = 5x product max", allow: over.allow, reasons: over.reasons },
  permitted_case: { proposal: "payout = product max", allow: within.allow, reasons: within.reasons },
  shipped_createAgent_path: shippedPath,
  real_onchain_agent_purchases: buys,
};
fs.writeFileSync(new URL("./agent-policy-evidence.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(over.allow === false && within.allow === true && (shippedPath ? shippedPath.agrees_with_engine : true) ? 0 : 1);
