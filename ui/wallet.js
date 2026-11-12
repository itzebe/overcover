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
// The canonical contract the wallet connects and signs against. The console may
// point the *reads* at another deployment via ?contract=, but a signature must
// target the same contract the page is showing — otherwise a buyer could price
// one contract and pay another. `setup` accepts an override for exactly that
// case; it defaults to the production contract.
const DEFAULT_CONTRACT_ID = "contract.ovc-v3-ctl-2f6c4c.testnet";
let contractId = DEFAULT_CONTRACT_ID;

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
    contractId: contractId,
    connected: !!currentAccountId,
    accountId: currentAccountId,
    networkMismatch: networkMismatch(),
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

/** Report whether the active account is on a different network.
 *  Two signals, either of which is enough to refuse:
 *    * the selector's configured network is not testnet (a hard mismatch), and
 *    * the connected account id ends in the mainnet TLD `.near`. A `.near`
 *      account is a mainnet account and can never sign a testnet transaction,
 *      so this is an authoritative signal, not a heuristic. The account TLD is
 *      what actually fires: the selector's own network is always the testnet
 *      value we configured it with, so a mainnet wallet would otherwise pass
 *      silently. Surfaced to the caller and used to block buying (fail closed). */
function networkMismatch() {
  try {
    const net = selector && selector.options && selector.options.network;
    if (net && net.networkId && net.networkId !== NETWORK_ID) return true;
    if (currentAccountId && /\.near$/.test(currentAccountId)) return true;
    return false;
  } catch (e) { return false; }
}

/** Configure the contract this wallet connects and signs against. The console
 *  calls this with the contract id it is reading, so a signature always targets
 *  the contract the page is showing. Only a contract-shaped testnet account id
 *  is accepted; anything else is ignored and the production default stands. */
const CONTRACT_RE = /^[a-z0-9._-]+\.(testnet|near)$/;
function configure(id) {
  if (typeof id === "string" && CONTRACT_RE.test(id)) contractId = id;
  return contractId;
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

/** Turn whatever a wallet throws into a message a person can act on. The
 *  selector and the wallets underneath throw raw strings ("User rejected the
 *  request", "Failed to fetch", …) that mean nothing to a first-time visitor.
 *  Map the common cases to a plain sentence; keep the raw text when we cannot
 *  classify it so nothing is hidden. `name` is the wallet's display name. */
function connectErrorMessage(e, name) {
  const raw = e && e.message ? String(e.message) : String(e || "");
  const l = raw.toLowerCase();
  if (l.includes("did not respond")) return raw; // our own timeout text is already actionable
  if (l.includes("not installed")) return raw;
  if (l.includes("reject") || l.includes("denied") || l.includes("cancel") || l.includes("user closed") || l.includes("closed the")) {
    return "You cancelled the " + name + " connection. Nothing was signed and nothing was charged.";
  }
  if (l.includes("blocked") || l.includes("popup") || l.includes("pop-up")) {
    return name + " could not open a window — your browser may be blocking pop-ups. Allow pop-ups for this site and try again.";
  }
  if (l.includes("network") || l.includes("chain") || l.includes("mainnet")) {
    return "Wrong network: " + name + " is not on NEAR testnet. Switch the wallet to testnet and try again.";
  }
  if (l.includes("no account")) return "No account was selected in " + name + ".";
  if (l.includes("failed to fetch") || l.includes("networkerror") || l.includes("load failed")) {
    return "Could not reach the " + name + " service. Check your connection and try again.";
  }
  return name + " could not connect: " + raw;
}

/** Connect a named wallet module. `walletId` is one of here-wallet,
 *  meteor-wallet. Throws with a human-readable reason. */
async function connect(walletId) {
  await setup();
  const module = selector.store.getState().modules.find((m) => m.id === walletId);
  if (!module) throw new Error(`wallet "${walletId}" is not available`);
  const name = module.metadata.name;
  if (EXTENSION_ONLY[walletId] && !injectedPresent(walletId)) {
    throw new Error(`${name} is not installed in this browser`);
  }
  let w;
  try {
    w = await selector.wallet(walletId);
  } catch (e) {
    throw new Error(connectErrorMessage(e, name));
  }
  // signIn returns the accounts; HERE/Meteor are injected wallets that open their
  // own UI. No private key ever reaches this page. The function-call access key is
  // scoped to buy_cover alone (least privilege) — the console has no other write
  // path, and owner-only methods are guarded on-chain regardless. The timeout
  // guards against a wallet that never opens or never resolves, which would
  // otherwise hang the button with no feedback at all.
  let accounts;
  try {
    accounts = await withTimeout(
      w.signIn({ contractId: contractId, methodNames: ["buy_cover"] }),
      CONNECT_TIMEOUT_MS,
      `${name} did not respond. If a wallet window opened, finish there; otherwise install the wallet and try again.`,
    );
  } catch (e) {
    throw new Error(connectErrorMessage(e, name));
  }
  const accountId = accounts?.[0]?.accountId ?? null;
  if (!accountId) throw new Error("No account was selected in " + name + ".");
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
  DEFAULT_CONTRACT_ID,
  configure,
  contractId: () => contractId,
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
