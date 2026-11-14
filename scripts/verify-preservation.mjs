// State-preservation verifier for the code-only hardened v3 redeploy and the
// legacy v1 containment call.
//
// A DeployContract replaces an account's code and leaves its state untouched.
// This script proves that: it re-reads every state view from public RPC and
// compares it against the snapshot captured before the change
// (proof/preservation-snapshot.json). Only the module code hash/sha256 may
// change; for the legacy account, `paused` may flip false -> true. Everything
// else — owner, attestor, quorums, windows, the whole pool accounting, and every
// operator/resolver/metric/product/policy — must be byte-for-byte identical.
//
// It never signs and needs no key. Record the baseline, then compare:
//   node scripts/verify-preservation.mjs --snapshot      # write the baseline
//   node scripts/verify-preservation.mjs                 # compare against it
//   node scripts/verify-preservation.mjs --expect-sha256 811e0427…
//
// Exit 0 = preserved; exit 1 = a preserved field changed (do not proceed).

import fs from "node:fs";
import { createHash } from "node:crypto";

const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const SNAPSHOT = "proof/preservation-snapshot.json";
const ACCOUNTS = {
  "prod-v3": "contract.ovc-v3-ctl-2f6c4c.testnet",
  "legacy-v1": "contract.attestor-overcover.testnet",
};

const WRITE_SNAPSHOT = process.argv.includes("--snapshot");
const EXPECT_SHA = (() => {
  const i = process.argv.indexOf("--expect-sha256");
  return i !== -1 ? process.argv[i + 1] : null;
})();

async function rpc(params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }),
  });
  const j = await r.json();
  return j.result || { error: j.error };
}

async function view(account, method, args = {}) {
  const r = await rpc({
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) return { __err: r.error.cause?.name || r.error.message };
  const text = Buffer.from(r.result).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const VIEWS = [
  "get_config",
  "get_pool",
  "list_operators",
  "list_resolvers",
  "list_metrics",
  "list_products",
  "list_policies",
  "active_operator_count",
  "check_invariant",
  "reconcile",
];

function canonical(x) {
  if (Array.isArray(x)) return JSON.stringify([...x].map(canonical).sort());
  if (x && typeof x === "object")
    return JSON.stringify(
      Object.keys(x)
        .sort()
        .map((k) => [k, canonical(x[k])])
    );
  return JSON.stringify(x);
}

function diffView(before, after, allowPausedFlip) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (allowPausedFlip && k === "paused") continue;
    if (canonical(before?.[k]) !== canonical(after?.[k])) {
      changes.push({ field: k, before: before?.[k], after: after?.[k] });
    }
  }
  return changes;
}

async function current(account) {
  const code = await rpc({ request_type: "view_code", finality: "final", account_id: account });
  const buf = Buffer.from(code.code_base64, "base64");
  const state = {
    account,
    codeHash: code.hash,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    views: {},
    policies: {},
  };
  for (const m of VIEWS) state.views[m] = await view(account, m);
  const list = state.views.list_policies;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const id = entry && typeof entry === "object" ? entry.id : entry;
      if (id === undefined || id === null) continue;
      state.policies[id] = await view(account, "get_policy", { policy_id: id });
    }
  }
  return state;
}

if (WRITE_SNAPSHOT) {
  const contracts = {};
  for (const [label, account] of Object.entries(ACCOUNTS)) contracts[label] = await current(account);
  fs.writeFileSync(
    SNAPSHOT,
    JSON.stringify({ generatedAt: new Date().toISOString(), rpc: RPC, contracts }, null, 2)
  );
  console.log(`wrote ${SNAPSHOT} — ${Object.keys(contracts).join(", ")}`);
  process.exit(0);
}

let failures = 0;
const before = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));

for (const [label, snap] of Object.entries(before.contracts)) {
  const allowPausedFlip = label === "legacy-v1";
  const now = await current(snap.account);
  console.log(`\n=== ${label} (${snap.account}) ===`);
  console.log(`  module sha256  before ${snap.sha256.slice(0, 16)}…  after ${now.sha256.slice(0, 16)}…`);
  console.log(`  module bytes   before ${snap.bytes}  after ${now.bytes}`);

  if (EXPECT_SHA && label === "prod-v3") {
    const ok = now.sha256 === EXPECT_SHA;
    console.log(`  expected sha256 ${EXPECT_SHA.slice(0, 16)}…  -> ${ok ? "MATCH" : "MISMATCH"}`);
    if (!ok) failures++;
  }

  for (const m of VIEWS) {
    const changes = diffView(snap.views[m], now.views[m], allowPausedFlip);
    if (changes.length === 0) {
      console.log(`  PRESERVED  ${m}`);
    } else {
      failures += changes.length;
      console.log(`  CHANGED    ${m}`);
      for (const c of changes)
        console.log(`      ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    }
  }

  const ids = new Set([...Object.keys(snap.policies || {}), ...Object.keys(now.policies || {})]);
  for (const id of ids) {
    const changes = diffView(snap.policies[id], now.policies[id], false);
    if (changes.length === 0) {
      console.log(`  PRESERVED  policy ${id}`);
    } else {
      failures += changes.length;
      console.log(`  CHANGED    policy ${id}`);
      for (const c of changes)
        console.log(`      ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    }
  }

  const pool = now.views.get_pool || {};
  const reserved = BigInt(pool.reserved || "0");
  const capital = BigInt(pool.capital || "0");
  const invariant = reserved <= capital;
  console.log(`  INVARIANT reserved(${reserved}) <= capital(${capital}) -> ${invariant ? "HOLD" : "VIOLATED"}`);
  if (!invariant) failures++;
}

console.log(
  `\n${failures === 0 ? "PRESERVATION PASS" : `PRESERVATION FAIL (${failures} changed field(s))`} — snapshot ${SNAPSHOT}`
);
process.exit(failures === 0 ? 0 : 1);
