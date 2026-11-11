// Create the Overcover testnet identity set (REAL testnet keypairs).
//
// Secret keys are written only to keys/identities.json (git-ignored).
//
// Funding strategy, in order of preference:
//   1. The free testnet faucet, for as many top-level accounts as it will grant.
//   2. Funded sub-accounts of an already-funded identity, once the faucet
//      rate-limits (it allows roughly eight accounts per window).
//
// This means a fresh run needs the faucet for at least ONE account and can
// provision the whole graph from there, so a rate-limited faucet is no longer a
// hard failure. The owner and contract accounts are always sub-accounts.
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
  // The autonomous agent's own independent account.
  agent: "agent-overcover",
  // Independent oracle operators (the quorum) and dispute resolvers.
  operator1: "op1-overcover",
  operator2: "op2-overcover",
  operator3: "op3-overcover",
  resolver1: "res1-overcover",
  resolver2: "res2-overcover",
  resolver3: "res3-overcover",
};

// How much to seed each role's sub-account with when the faucet is unavailable.
const SEED_NEAR = {
  lp_alice: "4", lp_bob: "3", biz_grower: "4", watchdog: "2",
  agent: "3", operator1: "1.5", operator2: "1.5", operator3: "1.5",
  resolver1: "1", resolver2: "1", resolver3: "1",
};

async function faucet(baseName, publicKey) {
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
    if (/rate limit/i.test(body)) return null; // caller falls back to a sub-account
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

/** Create (or reuse) a sub-account of `parentRole`, funded from the parent. */
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

  // The attestor is the funding root: it must be a top-level (faucet) account.
  if (!(ids.attestor?.accountId && ids.attestor?.secretKey && (await accountExists(near, ids.attestor.accountId)))) {
    const kp = KeyPair.fromRandom("ed25519");
    const accountId = await faucet(PREFERRED.attestor, kp.getPublicKey().toString());
    if (!accountId) throw new Error("faucet rate-limited and no existing attestor; retry when the faucet resets");
    ids.attestor = { accountId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
    fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
    fs.chmodSync(KEYS_FILE, 0o600);
    console.log(`  ${"attestor".padEnd(10)} ${accountId} (faucet)`);
  } else {
    console.log(`  ${"attestor".padEnd(10)} ${ids.attestor.accountId} (kept)`);
  }

  for (const [role, base] of Object.entries(PREFERRED)) {
    if (role === "attestor") continue;
    if (ids[role]?.accountId && ids[role]?.secretKey && (await accountExists(near, ids[role].accountId))) {
      console.log(`  ${role.padEnd(10)} ${ids[role].accountId} (kept)`);
      continue;
    }
    const kp = KeyPair.fromRandom("ed25519");
    const topLevel = await faucet(base, kp.getPublicKey().toString());
    if (topLevel) {
      ids[role] = { accountId: topLevel, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
      console.log(`  ${role.padEnd(10)} ${topLevel} (faucet)`);
      fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
      fs.chmodSync(KEYS_FILE, 0o600);
    } else {
      // Faucet is rate-limited: fund this role as a sub-account of the attestor.
      ids[role] = { accountId: `${role}-${base}.${ids.attestor.accountId}`, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
      fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
      fs.chmodSync(KEYS_FILE, 0o600);
      const id = await ensureSub(near, ids, "attestor", role === "biz_grower" ? "grower" : role, SEED_NEAR[role] ?? "1");
      ids[role].accountId = id;
      fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
      console.log(`  ${role.padEnd(10)} ${id} (sub-account of attestor)`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Owner and contract as subaccounts of the attestor (no faucet needed).
  const ownerId = await ensureSub(near, ids, "attestor", "owner", "2");
  const contractId = await ensureSub(near, ids, "attestor", "contract", "6");
  ids.owner = { ...(ids.owner ?? {}), accountId: ownerId, role: "admin" };
  ids.contract = ids.contract ?? { accountId: contractId };

  fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
  fs.chmodSync(KEYS_FILE, 0o600);
  console.log(`\nowner:    ${ownerId}`);
  console.log(`contract: ${contractId}`);
  for (const [r, v] of Object.entries(ids)) {
    if (!v.accountId) continue;
    try { const b = Number(BigInt(await balanceYocto(near, v.accountId))) / 1e24; console.log(`  ${r.padEnd(10)} ${v.accountId.padEnd(40)} ${b.toFixed(3)} NEAR`); } catch {}
  }
}

main().catch((e) => { console.error("KEYS FAILED:", e.message); process.exit(1); });

