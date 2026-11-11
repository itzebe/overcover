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
//
// After `new(...)` it registers the operator quorum, the independent resolvers
// and the risk-category metrics, so the deployed contract is immediately
// usable rather than half-configured.
import fs from "node:fs";
import { KeyPair } from "near-api-js";
import {
  connectNear, call, view, loadIdentities, loadState, saveState, WASM,
  toYocto, txHash, KEYS_FILE, balanceYocto,
} from "./near.js";

const CHALLENGE_BOND_NEAR = "0.1";
const SETTLE_DELAY_SEC = 0;
const CHALLENGE_WINDOW_SEC = Number(process.env.OVERCOVER_DEMO_WINDOW ?? 3600);
const QUORUM = Number(process.env.OVERCOVER_QUORUM ?? 3);
const RESOLVER_QUORUM = Number(process.env.OVERCOVER_RESOLVER_QUORUM ?? 3);
const DISPUTE_WINDOW_SEC = Number(process.env.OVERCOVER_DISPUTE_WINDOW ?? 3600);

// Risk categories. `scale` is tenths per base unit; `direction` is the trigger.
const METRICS = [
  { id: "rain", category: "precipitation", unit: "mm/10", max_value: 5000, scale: 10, direction: "Above" },
  { id: "drought", category: "drought", unit: "mm/10", max_value: 5000, scale: 10, direction: "Below" },
  { id: "heat", category: "temperature", unit: "degC/10", max_value: 700, scale: 10, direction: "Above" },
  { id: "wind", category: "wind", unit: "m/s/10", max_value: 1000, scale: 10, direction: "Above" },
];

const OPERATOR_ROLES = ["operator1", "operator2", "operator3"];
const RESOLVER_ROLES = ["resolver1", "resolver2", "resolver3"];

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

  const ownerKp = KeyPair.fromString(ids.attestor.secretKey);
  const ownerPub = Array.from(ownerKp.getPublicKey().data);
  const outcome = await call(near, contractId, contractId, "new", {
    owner: ids.owner.accountId,
    attestor: ownerPub,
    challenge_bond: toYocto(CHALLENGE_BOND_NEAR),
    settle_delay_sec: SETTLE_DELAY_SEC,
    challenge_window_sec: CHALLENGE_WINDOW_SEC,
  }, "0");
  console.log("  initialized. tx:", txHash(outcome));
  await call(near, ids.owner.accountId, contractId, "set_quorum", { quorum: QUORUM });
  await call(near, ids.owner.accountId, contractId, "set_resolver_quorum", { quorum: RESOLVER_QUORUM });
  await call(near, ids.owner.accountId, contractId, "set_dispute_window", { secs: DISPUTE_WINDOW_SEC });

  // Register the operator quorum.
  for (const role of OPERATOR_ROLES) {
    const op = ids[role];
    if (!op?.accountId) continue;
    const pub = Array.from(KeyPair.fromString(op.secretKey).getPublicKey().data);
    await call(near, ids.owner.accountId, contractId, "add_operator", { account: op.accountId, public_key: pub });
    console.log(`  operator ${op.accountId}`);
  }
  // Register the independent resolvers.
  for (const role of RESOLVER_ROLES) {
    const r = ids[role];
    if (!r?.accountId) continue;
    await call(near, ids.owner.accountId, contractId, "add_resolver", { account: r.accountId });
    console.log(`  resolver ${r.accountId}`);
  }
  // Register the risk-category metrics.
  for (const m of METRICS) {
    await call(near, ids.owner.accountId, contractId, "add_metric", {
      id: m.id, category: m.category, unit: m.unit, max_value: m.max_value, scale: m.scale, direction: m.direction,
    });
    console.log(`  metric ${m.id} (${m.category}, ${m.direction})`);
  }

  const state = loadState();
  Object.assign(state, {
    contractId,
    ownerId: ids.owner.accountId,
    challengeBondYocto: toYocto(CHALLENGE_BOND_NEAR),
    challengeWindowSec: CHALLENGE_WINDOW_SEC,
    quorum: QUORUM,
    resolverQuorum: RESOLVER_QUORUM,
    disputeWindowSec: DISPUTE_WINDOW_SEC,
    operators: OPERATOR_ROLES.map((r) => ids[r]?.accountId).filter(Boolean),
    resolvers: RESOLVER_ROLES.map((r) => ids[r]?.accountId).filter(Boolean),
  });
  saveState(state);

  console.log("config: ", await view(near, contractId, "get_config", {}));
  console.log("operators:", (await view(near, contractId, "list_operators", {})).map((o) => o.account));
  console.log("metrics:  ", (await view(near, contractId, "list_metrics", {})).map((m) => m.id));
  console.log("pool:  ", await view(near, contractId, "get_pool", {}));
}

main().catch((e) => { console.error("DEPLOY FAILED:", e.message); process.exit(1); });
