// Create the Overcover testnet identity set (REAL testnet keypairs).
//
// Secret keys are written only to keys/identities.json (git-ignored). Top-level
// accounts come from the free testnet faucet; the owner and contract accounts
// are subaccounts funded from an existing identity, so re-runs never depend on
// the faucet being available.
//
//   node driver/keys.js
import fs from "node:fs";
import { KeyPair } from "near-api-js";
import { connectNear, loadIdentities, KEYS_FILE, toYocto, balanceYocto } from "./near.js";

// role -> preferred top-level account name (without .testnet)
const PREFERRED = {
  attestor: "attestor-overcover",
  lp_alice: "lp-alice-overcover",
  lp_bob: "lp-bob-overcover",
  biz_grower: "grower-overcover",
  watchdog: "watchdog-overcover",
};

async function createTopLevel(baseName, publicKey) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const name = attempt === 0 ? baseName : `${baseName}${attempt}`;
    const id = `${name}.testnet`;
    const res = await fetch("https://helper.testnet.near.org/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
    });
    if (res.ok) return id;
    const body = await res.text();
    if (/exists|already|taken|AccountAlreadyExists/i.test(body)) continue;
    if (/rate limit/i.test(body)) throw new Error(`faucet rate-limited; keep existing accounts`);
    throw new Error(`faucet failed for ${id}: ${res.status} ${body.slice(0, 200)}`);
  }
  throw new Error(`no free name for ${baseName}`);
}

async function accountExists(near, id) {
  try {
    const r = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return !!r && !!r.amount;
  } catch { return false; }
}

async function ensureSub(near, ids, parentRole, subName, amountNear) {
  const parentId = ids[parentRole].accountId;
  const id = `${subName}.${parentId}`;
  if (await accountExists(near, id)) return id;
  const parent = await near.account(parentId);
  const kp = KeyPair.fromRandom("ed25519");
  await parent.createAccount(id, kp.getPublicKey(), toYocto(amountNear));
  ids[subName] = { accountId: id, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
  fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
  fs.chmodSync(KEYS_FILE, 0o600);
  await new Promise((r) => setTimeout(r, 3000));
  return id;
}

async function main() {
  const near = await connectNear();
  let ids = {};
  try { ids = loadIdentities(); } catch { ids = {}; }
  fs.mkdirSync(new URL("../keys/", import.meta.url), { recursive: true });

  for (const [role, base] of Object.entries(PREFERRED)) {
    if (ids[role]?.accountId && ids[role]?.secretKey && (await accountExists(near, ids[role].accountId))) {
      console.log(`  ${role.padEnd(10)} ${ids[role].accountId} (kept)`);
      continue;
    }
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = await createTopLevel(base, kp.getPublicKey().toString());
    ids[role] = { accountId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
    console.log(`  ${role.padEnd(10)} ${accountId} (created)`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Owner and contract as subaccounts of the attestor (no faucet needed).
  const ownerId = await ensureSub(near, ids, "attestor", "owner", "2");
  const contractId = await ensureSub(near, ids, "attestor", "contract", "5");
  ids.owner = { ...(ids.owner ?? {}), accountId: ownerId, role: "admin" };
  ids.contract = ids.contract ?? { accountId: contractId };

  fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
  fs.chmodSync(KEYS_FILE, 0o600);
  console.log(`\nowner:    ${ownerId}`);
  console.log(`contract: ${contractId}`);
  for (const [r, v] of Object.entries(ids)) {
    if (!v.accountId) continue;
    try { const b = Number(BigInt(await balanceYocto(near, v.accountId))) / 1e24; console.log(`  ${r.padEnd(10)} ${v.accountId.padEnd(34)} ${b.toFixed(3)} NEAR`); } catch {}
  }
}

main().catch((e) => { console.error("KEYS FAILED:", e.message); process.exit(1); });
