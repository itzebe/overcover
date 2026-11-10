// Deploy the Overcover contract to NEAR testnet with a guaranteed-clean state.
//
//   OVERCOVER_DEMO_WINDOW=60 node driver/deploy.js
//
// The contract lives on a fixed subaccount (ids.contract.accountId, created by
// driver/keys.js). Because near-sdk collections keep their data in storage (not
// in the serialized state), a plain re-deploy would leave stale collection
// entries behind. So this script DELETES the contract subaccount and recreates
// it (funded from the parent identity — no faucet needed) before deploying and
// calling `new(...)`. The address stays stable; the state is always clean.
import fs from "node:fs";
import { KeyPair } from "near-api-js";
import {
  connectNear, call, view, loadIdentities, loadState, saveState, WASM,
  toYocto, txHash, KEYS_FILE, balanceYocto,
} from "./near.js";

const CHALLENGE_BOND_NEAR = "0.1";
const SETTLE_DELAY_SEC = 0;
const CHALLENGE_WINDOW_SEC = Number(process.env.OVERCOVER_DEMO_WINDOW ?? 3600);

async function accountExists(near, id) {
  try {
    const r = await near.connection.provider.query({ request_type: "view_account", finality: "final", account_id: id });
    return !!r && !!r.amount;
  } catch { return false; }
}

async function main() {
  const ids = loadIdentities();
  const near = await connectNear();
  const contractId = ids.contract.accountId;
  const parentId = ids.attestor.accountId;

  // Reset: delete the contract subaccount (funds return to the parent) and
  // recreate it fresh so collection storage starts empty.
  if (await accountExists(near, contractId)) {
    console.log(`resetting ${contractId} (delete + recreate)`);
    const acct = await near.account(contractId);
    await acct.deleteAccount(parentId);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const parent = await near.account(parentId);
  const kp = KeyPair.fromRandom("ed25519");
  await parent.createAccount(contractId, kp.getPublicKey(), toYocto("4.5"));
  ids.contract = { accountId: contractId, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
  // the keystore was built at connect time with the OLD key; register the new one
  await near.connection.signer.keyStore.setKey("testnet", contractId, kp);
  fs.writeFileSync(KEYS_FILE, JSON.stringify(ids, null, 2));
  fs.chmodSync(KEYS_FILE, 0o600);
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`recreated ${contractId}`);

  const wasm = fs.readFileSync(WASM);
  console.log(`deploying ${WASM} (${wasm.length} bytes)`);
  const acct = await near.account(contractId);
  await acct.deployContract(wasm);
  console.log("  deployed");

  const attestorKp = KeyPair.fromString(ids.attestor.secretKey);
  const attestorPub = Array.from(attestorKp.getPublicKey().data);
  const outcome = await call(near, contractId, contractId, "new", {
    owner: ids.owner.accountId,
    attestor: attestorPub,
    challenge_bond: toYocto(CHALLENGE_BOND_NEAR),
    settle_delay_sec: SETTLE_DELAY_SEC,
    challenge_window_sec: CHALLENGE_WINDOW_SEC,
  }, "0");
  console.log("  initialized. tx:", txHash(outcome));

  const state = loadState();
  Object.assign(state, {
    contractId,
    ownerId: ids.owner.accountId,
    attestorPub,
    challengeBondYocto: toYocto(CHALLENGE_BOND_NEAR),
    challengeWindowSec: CHALLENGE_WINDOW_SEC,
  });
  saveState(state);

  console.log("config:", await view(near, contractId, "get_config", {}));
  console.log("pool:  ", await view(near, contractId, "get_pool", {}));
}

main().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
