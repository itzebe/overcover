// Overcover browser wallet integration.
//
// Bundled to ui/vendor/wallet-bundle.js by scripts/build-wallet.mjs. It is the
// ONLY place that touches a NEAR wallet extension. It exposes a small, explicit
// surface on window.OvercoverWallet so the console can stay dependency-free.
//
// Design rules this file must keep:
//   * It never holds, receives or derives a private key. Signing happens inside
//     the user's wallet extension; this code only asks for a signature.
//   * It never signs anything on its own. Every call to `signAndSend` is an
//     explicit, caller-supplied transaction the user approves in their wallet.
//   * It never silently switches networks. The network is fixed to testnet and
//     reported to the caller; a mainnet wallet is surfaced as a mismatch.
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";

const NETWORK_ID = "testnet";
const CONTRACT_ID = "contract.attestor-overcover.testnet";

let selector = null;
let wallet = null;
let currentAccountId = null;
let unsubscribe = null;

const listeners = new Set();
function emit() {
  const snapshot = status();
  for (const fn of listeners) {
    try { fn(snapshot); } catch (e) { /* a listener must never break the wallet */ }
  }
}

// The near-wallet-selector modules hardcode `available: true`, so a plain
// `available` check lists wallets that are not actually installed and can never
// connect. Meteor Wallet is injected-only; detect its provider so the picker can
// label it honestly instead of promising a flow that dead-ends. HERE Wallet runs
// its own app/web flow (the user enters their email or social login inside HERE),
// so it needs no injected provider and is always offered.
const EXTENSION_ONLY = { "meteor-wallet": true };
function injectedPresent(id) {
  try {
    if (id === "meteor-wallet") return !!globalThis.meteorWallet;
  } catch (e) { /* reading a cross-origin global must never break the picker */ }
  return false;
}
function installUrl(id) {
  const m = selector && selector.store.getState().modules.find((x) => x.id === id);
  return (m && m.metadata && m.metadata.downloadUrl) || null;
}

function status() {
  return {
    ready: !!selector,
    networkId: NETWORK_ID,
    contractId: CONTRACT_ID,
    connected: !!currentAccountId,
    accountId: currentAccountId,
    available: selector ? selector.store.getState().modules.map((m) => ({
      id: m.id,
      name: m.metadata.name,
      type: m.type,
      downloadUrl: m.metadata.downloadUrl || null,
      // `present` is the honest signal: is there something in this browser that
      // can actually approve a signature for this wallet right now?
      present: EXTENSION_ONLY[m.id] ? injectedPresent(m.id) : true,
      extensionOnly: !!EXTENSION_ONLY[m.id],
    })) : [],
  };
}

async function setup() {
  if (selector) return selector;
  selector = await setupWalletSelector({
    network: NETWORK_ID,
    modules: [setupHereWallet(), setupMeteorWallet()],
  });
  // Keep the account id in sync if the wallet changes it (extension switch,
  // session expiry, sign-out from inside the extension).
  unsubscribe = selector.store.observable.subscribe((state) => {
    const next = state.accounts?.[0]?.accountId ?? null;
    if (next !== currentAccountId) {
      currentAccountId = next;
      emit();
    }
  });
  // Restore a previous session without prompting.
  const restored = selector.store.getState().accounts?.[0]?.accountId ?? null;
  if (restored) currentAccountId = restored;
  emit();
  return selector;
}

/** Reject after `ms` so a wallet that opens nothing (a missing extension, a
 *  blocked popup, a wallet that never calls back) cannot leave the UI hanging
 *  forever. The user gets a clear, actionable error instead of a dead button.
 *  The delay is overridable for tests; production uses the default. */
const CONNECT_TIMEOUT_MS = Number(globalThis.OVERCOVER_CONNECT_TIMEOUT_MS) || 90000;
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Connect a named wallet module. `walletId` is one of here-wallet,
 *  meteor-wallet. Throws with a human-readable reason. */
async function connect(walletId) {
  await setup();
  const module = selector.store.getState().modules.find((m) => m.id === walletId);
  if (!module) throw new Error(`wallet "${walletId}" is not available`);
  if (EXTENSION_ONLY[walletId] && !injectedPresent(walletId)) {
    throw new Error(`${module.metadata.name} is not installed in this browser`);
  }
  const w = await selector.wallet(walletId);
  // signIn returns the accounts; HERE/Meteor are injected wallets that open their
  // own UI. No private key ever reaches this page. The function-call access key is
  // scoped to buy_cover alone (least privilege) — the console has no other write
  // path, and owner-only methods are guarded on-chain regardless. The timeout
  // guards against a wallet that never opens or never resolves, which would
  // otherwise hang the button with no feedback at all.
  const accounts = await withTimeout(
    w.signIn({ contractId: CONTRACT_ID, methodNames: ["buy_cover"] }),
    CONNECT_TIMEOUT_MS,
    `${module.metadata.name} did not respond. If a wallet window opened, finish there; otherwise install the wallet and try again.`,
  );
  const accountId = accounts?.[0]?.accountId ?? null;
  if (!accountId) throw new Error("the wallet returned no account");
  wallet = w;
  currentAccountId = accountId;
  emit();
  return accountId;
}

async function disconnect() {
  if (wallet) { try { await wallet.signOut(); } catch (e) { /* already gone */ } }
  wallet = null;
  currentAccountId = null;
  emit();
}

/** Sign and send exactly the actions the caller supplies. This function adds
 *  nothing: no extra action, no changed amount, no hidden call. It returns the
 *  wallet's own result, so the console can show the real transaction hash. */
async function signAndSend({ receiverId, actions }) {
  if (!currentAccountId) throw new Error("connect a wallet first");
  if (!wallet) {
    const active = await selector.wallet();
    if (!active) throw new Error("no wallet selected");
    wallet = active;
  }
  return wallet.signAndSendTransaction({ receiverId, actions });
}

/** Actions in the wallet-selector v10 shape. A FunctionCall action's args must
 *  be a plain object; the selector serialises it with borsh itself. */
function functionCall({ methodName, args, gas, deposit }) {
  return {
    type: "FunctionCall",
    params: {
      methodName,
      args: args ?? {},
      gas: String(gas ?? "300000000000000"),
      deposit: String(deposit ?? "0"),
    },
  };
}

window.OvercoverWallet = {
  NETWORK_ID,
  CONTRACT_ID,
  setup,
  status,
  connect,
  disconnect,
  signAndSend,
  functionCall,
  installUrl,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  _selector: () => selector,
};

// Best-effort auto-restore so a refresh keeps the connection.
setup().catch(() => { /* the console reports readiness via status().ready */ });
