// Code-only redeploy of the hardened v3 module (SEC-6 / SEC-7 / SEC-9).
//
//   node driver/redeploy-v3.mjs --plan   # print the operation; needs no key, sends nothing
//   node driver/redeploy-v3.mjs          # DeployContract the new wasm to the SAME account
//
// Why this exists. `driver/upgrade.js` bundles a v1->v2 `migrate()` and targets the
// legacy address; `driver/deploy.js` DELETES and recreates the subaccount, wiping
// state. Neither is right for replacing the code of the live v3 account while
// keeping its pool, products, policies, providers and observations. A bare
// `DeployContract` carries no `new()`/`migrate()`: it replaces code only.
//
// It fails closed. It refuses unless the wasm's sha256 equals OVC_EXPECTED_SHA and
// the wasm contains the SEC-9 guard string, so a stale or foreign artifact cannot
// be shipped by accident.
//
// The signing key is operator-held and never printed. Provide it via the
// gitignored keys/v3-operator.json ({ "account_id": ..., "secret_key": ... }) or
// OVC_V3_SECRET_KEY. This environment holds no key material, so it only runs --plan.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, keyStores, KeyPair, providers } from "near-api-js";

const root = new URL("..", import.meta.url).pathname;
const ACCOUNT = process.env.OVC_V3_ACCOUNT_ID || "contract.ovc-v3-ctl-2f6c4c.testnet";
const KEY_FILE = process.env.OVC_V3_KEY_FILE || `${root}keys/v3-operator.json`;
const WASM = process.env.OVERCOVER_WASM || `${root}contract/target/wasm32-unknown-unknown/release/overcover.wasm`;
const RPC = process.env.OVERCOVER_RPC || "https://test.rpc.fastnear.com";
const EXPECTED_SHA = process.env.OVC_EXPECTED_SHA || "";
const GUARD = "observation date too far in the future";
const PLAN = process.argv.includes("--plan");

async function rpcViewCode(account) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "view_code", finality: "final", account_id: account },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

function loadKey() {
  if (process.env.OVC_V3_SECRET_KEY) {
    return { account_id: ACCOUNT, secret_key: process.env.OVC_V3_SECRET_KEY };
  }
  if (!fs.existsSync(KEY_FILE)) {
    throw new Error(`no signing key: set OVC_V3_SECRET_KEY or create ${KEY_FILE} (gitignored, mode 0600). The operator holds this key; it is never committed or printed.`);
  }
  const v = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  if (!v.account_id || !v.secret_key) throw new Error(`${KEY_FILE} must contain account_id and secret_key`);
  if (v.account_id !== ACCOUNT) throw new Error(`key is for ${v.account_id}, not the target ${ACCOUNT}`);
  return v;
}

async function main() {
  if (!fs.existsSync(WASM)) throw new Error(`wasm not found: ${WASM}; build it first (cargo build --release --target wasm32-unknown-unknown)`);
  const wasm = fs.readFileSync(WASM);
  const sha = createHash("sha256").update(wasm).digest("hex");

  // Fail closed on a stale/foreign artifact BEFORE anything is signed.
  if (EXPECTED_SHA && sha !== EXPECTED_SHA) {
    throw new Error(`refusing: wasm sha256 ${sha} != OVC_EXPECTED_SHA ${EXPECTED_SHA}`);
  }
  if (!wasm.toString("latin1").includes(GUARD)) {
    throw new Error(`refusing: ${WASM} lacks the SEC-9 guard string ("${GUARD}"). Rebuild from the intended commit.`);
  }

  const cur = await rpcViewCode(ACCOUNT);
  const curSha = createHash("sha256").update(Buffer.from(cur.code_base64, "base64")).digest("hex");

  console.log(`target account : ${ACCOUNT} (testnet)`);
  console.log(`current code   : code_hash ${cur.hash}`);
  console.log(`                 sha256    ${curSha}`);
  console.log(`new code       : sha256    ${sha}  (${wasm.length} bytes)`);
  console.log(`operation      : DeployContract(${ACCOUNT}, <wasm>) — code only, no new()/migrate()`);
  console.log(`rollback       : re-run with the previous module (sha256 ${curSha}); also code-only.`);

  if (PLAN) {
    console.log("\n--plan: nothing sent.");
    return;
  }

  const k = loadKey();
  const ks = new keyStores.InMemoryKeyStore();
  await ks.setKey("testnet", k.account_id, KeyPair.fromString(k.secret_key));
  const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks, headers: {} });
  near.connection.provider = new providers.JsonRpcProvider({ url: RPC });

  console.log(`\ndeploying to ${ACCOUNT} …`);
  const acct = await near.account(ACCOUNT);
  const outcome = await acct.deployContract(wasm);
  const txHash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? "?";
  console.log(`  sent tx ${txHash}`);

  const after = await rpcViewCode(ACCOUNT);
  const afterSha = createHash("sha256").update(Buffer.from(after.code_base64, "base64")).digest("hex");
  console.log(`  new code_hash ${after.hash}`);
  console.log(`  new sha256    ${afterSha}`);
  if (afterSha !== sha) throw new Error(`post-deploy sha256 ${afterSha} != deployed wasm ${sha}; investigate before proceeding`);
  console.log("\nOK: deployed module matches the built wasm. Re-run `npm run verify:proof` and `node proof/controlled-v3-evidence.mjs`.");
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
