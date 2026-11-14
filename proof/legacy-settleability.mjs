// Read-only settleability reconciliation for the two live Overcover testnet contracts.
//
// This script NEVER signs, never sends a transaction and never needs a key. It reads the
// pool, policies and observations over public JSON-RPC and classifies every active policy
// as it stands on-chain right now:
//
//   * SETTLEABLE_PAYS  — a finalised, undisputed, un-nullified reading exists, its challenge
//                        window has elapsed, and its value meets the product threshold, so a
//                        permissionless resolve() would pay the beneficiary.
//   * SETTLEABLE_NO_PAY — same, but the value misses the threshold (resolve() would pay nothing).
//   * BLOCKED          — a reading exists but is disputed or still inside its challenge window;
//                        resolve() refuses and the reservation stays held (transient).
//   * LOCKED           — no usable reading exists and none can ever be produced for that
//                        (metric, city, date); resolve() reverts and the reservation is stranded.
//
// It also asserts the pool identity `reserved == Σ payouts of active policies` and the
// solvency invariant `reserved <= capital`, and exits non-zero if either fails. The dump is
// written to proof/legacy-settleability.json.
//
//   node proof/legacy-settleability.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPCS = [
  process.env.OVERCOVER_RPC,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.fastnear.com",
].filter(Boolean);

const CONTRACTS = {
  v3: "contract.ovc-v3-ctl-2f6c4c.testnet",
  legacy_v1: "contract.attestor-overcover.testnet",
};

async function rpc(body) {
  let lastErr;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      });
      const j = await res.json();
      if (!j.error) return j.result;
      lastErr = new Error(j.error.cause?.name || j.error.message || "rpc error");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function view(account, method, args = {}) {
  const r = await rpc({ method: "query", params: {
    request_type: "call_function", finality: "final", account_id: account,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  }});
  if (r && r.result !== undefined) {
    const text = Buffer.from(r.result).toString("utf8");
    // The contract emits raw u128 fields (payout, premium, …) as bare JSON numbers, which
    // JSON.parse would round to a float and lose precision on. Quote any integer literal of
    // 16+ digits first so the exact value survives as a string.
    return JSON.parse(text.replace(/:(-?\d{16,})/g, ':"$1"'));
  }
  return undefined;
}

// v3 policies carry their own direction; the legacy v1 module is always "Above"
// (contract 18ec7f08, `let triggered = value >= pol.threshold_tenths`).
function triggers(policy, value) {
  const dir = policy.direction || "Above";
  return dir === "Below" ? value <= policy.threshold_tenths : value >= policy.threshold_tenths;
}

function classify(policy, obsByKey, now) {
  const o = obsByKey.get(`${policy.metric_id ?? ""}|${policy.city}|${policy.obs_date}`);
  if (!o) return { state: "LOCKED", reason: "no reading was ever reported" };
  if (o.nullified) return { state: "LOCKED", reason: "reading nullified" };
  if (o.disputed) return { state: "BLOCKED", reason: "reading disputed (unresolved)" };
  if (now < o.reported_at + (o.challenge_window_sec ?? policy.challenge_window_sec)) {
    return { state: "BLOCKED", reason: "challenge window not elapsed" };
  }
  return triggers(policy, o.value_tenths)
    ? { state: "SETTLEABLE_PAYS", reason: `value ${o.value_tenths} meets threshold ${policy.threshold_tenths}` }
    : { state: "SETTLEABLE_NO_PAY", reason: `value ${o.value_tenths} misses threshold ${policy.threshold_tenths}` };
}

const now = Math.floor(Date.now() / 1000);
const out = { generated_at: new Date().toISOString(), now, network: "testnet", contracts: {} };
let failures = 0;

for (const [label, account] of Object.entries(CONTRACTS)) {
  const pool = await view(account, "get_pool");
  const policies = (await view(account, "list_policies")) || [];
  const observations = (await view(account, "list_observations")) || [];
  const reconcile = await view(account, "reconcile");
  const invariant = await view(account, "check_invariant");

  const obsByKey = new Map(observations.map((o) => [`${o.metric_id ?? ""}|${o.city}|${o.obs_date}`, o]));
  const active = policies.filter((p) => p.status === "active");
  const rows = active.map((p) => {
    const c = classify(p, obsByKey, now);
    return { id: p.id, buyer: p.buyer, beneficiary: p.beneficiary, product_id: p.product_id,
      payout: String(p.payout), threshold: p.threshold_tenths, obs_date: p.obs_date, ...c };
  });

  const sumPayouts = active.reduce((a, p) => a + BigInt(p.payout), 0n);
  const reserved = BigInt(pool.reserved);
  const capital = BigInt(pool.capital);
  const identityHolds = sumPayouts === reserved;
  const solvent = reserved <= capital;

  const locked = rows.filter((r) => r.state === "LOCKED");
  const payable = rows.filter((r) => r.state === "SETTLEABLE_PAYS");
  const lockedReserved = locked.reduce((a, r) => a + BigInt(r.payout), 0n);
  const payableNow = payable.reduce((a, r) => a + BigInt(r.payout), 0n);

  out.contracts[label] = {
    account_id: account, pool, reconcile, invariant,
    policy_count: policies.length, active_count: active.length,
    reserved_identity_holds: identityHolds, solvent,
    locked_count: locked.length, locked_reserved: String(lockedReserved),
    payable_now_count: payable.length, payable_now: String(payableNow),
    rows,
  };

  const near = (y) => (Number(y) / 1e24).toFixed(4);
  console.log(`\n=== ${label} — ${account} ===`);
  console.log(`  capital ${near(capital)} | reserved ${near(reserved)} | active ${active.length} policies`);
  console.log(`  reserved == Σ active payouts: ${identityHolds ? "PASS" : "FAIL"}   reserved <= capital: ${solvent ? "PASS" : "FAIL"}   reconcile ${reconcile} invariant ${invariant}`);
  console.log(`  permissionless payout available now: ${near(payableNow)} NEAR across ${payable.length} policies`);
  console.log(`  stranded reservation (no usable reading): ${near(lockedReserved)} NEAR across ${locked.length} policies`);
  for (const r of rows) console.log(`    #${String(r.id).padStart(2)} ${r.state.padEnd(17)} ${near(BigInt(r.payout))} NEAR  ${r.reason}`);

  if (!identityHolds) { console.error(`  FAIL: reserved (${reserved}) != Σ active payouts (${sumPayouts})`); failures++; }
  if (!solvent) { console.error(`  FAIL: reserved (${reserved}) > capital (${capital})`); failures++; }
}

const dest = path.join(root, "proof", "legacy-settleability.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`\nEvidence: ${path.relative(root, dest)}`);
if (failures > 0) { console.error(`\n${failures} invariant failure(s).`); process.exit(1); }
console.log("All pool identities hold.");
