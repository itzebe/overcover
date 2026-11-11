// Shared NEAR testnet connection + helpers for Overcover.
// Free public testnet RPCs only; no paid infrastructure.
import { connect, KeyPair, keyStores, utils, transactions, providers } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS_FILE = path.join(root, "keys", "identities.json");
export const STATE_FILE = path.join(root, "keys", "state.json");
export const WASM = path.join(
  root, "contract", "target", "wasm32-unknown-unknown", "release", "overcover.wasm"
);

// Only genuine TESTNET endpoints (free.rpc.fastnear.com is MAINNET — do not use).
export const RPC_ENDPOINTS = [
  process.env.OVERCOVER_RPC,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
].filter(Boolean);

export function loadIdentities() {
  if (!fs.existsSync(KEYS_FILE)) throw new Error(`missing ${KEYS_FILE}; run: node driver/keys.js`);
  return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
}
export function loadState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
}
export function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function makeKeyStore() {
  const ks = new keyStores.InMemoryKeyStore();
  // Tolerate a missing identities file: driver/keys.js must be able to connect
  // in order to CREATE that file on a fresh checkout.
  let ids = {};
  try { ids = loadIdentities(); } catch { ids = {}; }
  for (const v of Object.values(ids)) {
    if (v.accountId && v.secretKey) ks.setKey("testnet", v.accountId, KeyPair.fromString(v.secretKey));
  }
  return ks;
}

export async function connectNear() {
  const near = await connect({ networkId: "testnet", nodeUrl: RPC_ENDPOINTS[0], keyStore: makeKeyStore(), headers: {} });
  near.connection.provider = new providers.FailoverRpcProvider(
    RPC_ENDPOINTS.map((url) => new providers.JsonRpcProvider({ url }))
  );
  return near;
}

export const toYocto = (near) => utils.format.parseNearAmount(String(near));
export const fromYocto = (y) => Number(BigInt(y)) / 1e24;

export async function withRetry(fn, label = "op", tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = String(e?.message || e);
      if (!/429|Rate limit|Too Many|timeout|ECONNRESET|502|503|504|[-]32000/i.test(msg)) throw e;
      const wait = Math.min(1000 * 2 ** i, 20000) + Math.floor(Math.random() * 400);
      process.stderr.write(`  [retry ${i + 1}/${tries}] ${label}: ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

export async function view(near, contractId, method, args = {}) {
  return withRetry(async () => {
    const r = await near.connection.provider.query({
      request_type: "call_function",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  }, `view:${method}`);
}

function failureMessage(failure) {
  try {
    const kind = failure.ActionError?.kind ?? failure.ActionError;
    const fc = kind?.FunctionCallError;
    const s = fc?.ExecutionError ?? fc?.CompilationError ?? JSON.stringify(failure);
    return String(s).replace(/^Smart contract panicked:\s*/, "");
  } catch { return JSON.stringify(failure); }
}
export function executionFailure(outcome) {
  const f = outcome?.status?.Failure;
  return f ? failureMessage(f) : null;
}

/** Call a change method and return the outcome once FINAL. A failed execution
 *  is thrown, never returned as success. */
export async function call(near, accountId, contractId, method, args = {}, depositYocto = "0", gas = "300000000000000") {
  const account = await near.account(accountId);
  const action = transactions.functionCall(method, Buffer.from(JSON.stringify(args)), BigInt(gas), BigInt(depositYocto));
  const [hashBytes, signedTx] = await withRetry(() => account.signTransaction(contractId, [action]), `sign:${method}`);
  const hash = utils.serialize.base_encode(hashBytes);
  const outcome = await withRetry(() => near.connection.provider.sendTransactionUntil(signedTx, "EXECUTED_OPTIMISTIC"), `call:${method}`);
  const failure = executionFailure(outcome);
  if (failure) throw new Error(failure);
  try { await withRetry(() => near.connection.provider.txStatus(hash, accountId, "FINAL"), `status:${method}`); } catch {}
  return outcome;
}

export const txHash = (o) => o?.transaction_outcome?.id ?? o?.transaction?.hash ?? "?";

export async function balanceYocto(near, id) {
  const a = await near.account(id);
  return (await a.getAccountBalance()).total;
}

/** Create a throwaway top-level testnet account and transfer from it. */
export async function faucetTopLevel(near, prefix, nearAmount = "2") {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${prefix}-${Date.now().toString(36)}.testnet`;
  const res = await fetch("https://helper.testnet.near.org/account", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet ${res.status}: ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 3000));
  await near.connection.signer.keyStore.setKey("testnet", id, kp);
  return { accountId: id, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString(), nearAmount };
}

/** Create a sub-account under `parentId` funded from the parent. */
export async function createSubAccount(near, parentId, subId, publicKey, nearAmount = "5") {
  const parent = await near.account(parentId);
  return withRetry(
    () => parent.createAccount(subId, KeyPair.fromString(publicKey).getPublicKey(), toYocto(nearAmount)),
    `create:${subId}`
  );
}

export async function ensureFunded(near, accountId, minNear, topUpTo = minNear * 2) {
  const bal = fromYocto(await balanceYocto(near, accountId));
  if (bal >= minNear) return { funded: false, balance: bal };
  const t = await faucetTopLevel(near, `ovc-fund`, String((topUpTo - bal).toFixed(3)));
  const a = await near.account(t.accountId);
  await a.sendMoney(accountId, toYocto(topUpTo - bal));
  return { funded: true, top: topUpTo - bal };
}
