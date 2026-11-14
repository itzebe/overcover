// End-to-end test of the HUMAN PURCHASE JOURNEY, using the REAL page code.
//
//   node --test tests/wallet-journey.test.mjs
//
// This does not re-implement the console. It lifts the entire inline <script> out
// of ui/index.html, runs it against a minimal DOM shim and a MOCK wallet, and
// feeds it the frozen contract snapshot (tests/fixtures/contract-snapshot.json)
// through a stubbed fetch. So the code under test is exactly what ships.
//
// Nothing here broadcasts a transaction: the "wallet" is a stub that records the
// actions it was asked to sign and returns a synthetic result. The test proves
// the page BUILDS the right call, attaches the contract's own premium, hands it
// to the wallet, and classifies the outcome honestly — it does not claim an
// extension approved anything. A real extension approval remains the one human
// acceptance step.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + 8, HTML.lastIndexOf("</script>"));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "contract-snapshot.json"), "utf8"));

const CONTRACT = "contract.ovc-v3-ctl-2f6c4c.testnet";       // hardened, the default
const LEGACY = "contract.attestor-overcover.testnet";       // legacy, read-only
const HARDENED_HASH = "CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL";
const LEGACY_HASH = "36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R";
const ONE_NEAR = 10n ** 24n;

// ------------------------------------------------------------------ DOM shim

function makeElement(id) {
  const listeners = {};
  const kids = new Map();
  const el = {
    id,
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    className: "",
    style: {},
    options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, ev) { for (const fn of listeners[type] || []) fn(ev || {}); },
    setAttribute() {},
    getAttribute() { return null; },
    hasAttribute() { return false; },
    removeAttribute() {},
    // The v2/v3 narrative upgrade addresses child nodes by selector; return a
    // stable stub per selector so the page can set their text without a real DOM.
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, makeElement(id + " " + sel)); return kids.get(sel); },
    querySelectorAll() { return []; },
    appendChild() {},
    removeChild() {},
    focus() {},
    select() {},
    showModal() {},
    close() {},
  };
  return el;
}

/** Build a fresh DOM + global environment, run the page script inside a vm
 *  context (so Node's getter-only globals are not touched), and return a handle
 *  with the elements and the mock wallet for assertions. `search` lets a test
 *  exercise the ?contract= selection; `codeHash` overrides the deployed module
 *  the stubbed RPC reports (so trust states can be driven). */
function bootPage({ wallet, codeHash = FIXTURE.view_account.code_hash, search = "", signTimeoutMs = undefined }) {
  const elements = new Map();
  let viewAccountCalls = 0;
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const docListeners = {};
  const document = {
    getElementById: getEl,
    createElement: (tag) => makeElement("created-" + tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    dispatch(type, ev) { for (const fn of docListeners[type] || []) fn(ev || {}); },
    body: makeElement("body"),
    documentElement: makeElement("html"),
    activeElement: null,
  };

  const sandbox = {
    document,
    location: { search },
    navigator: {},
    OvercoverWallet: wallet,
    OvercoverPolicy: null,
    OVERCOVER_SIGN_TIMEOUT_MS: signTimeoutMs,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    BigInt, Number, String, Array, Object, JSON, Math, Date, Boolean, RegExp, Error, Promise,
    Uint8Array, TextDecoder, URLSearchParams,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    // Serve the frozen contract snapshot instead of a network RPC. The page's
    // view() sends call_function; accountState() sends view_account. A quote call
    // carries args, so it is matched against the frozen quotes map. `codeHash`
    // may be a function of the view_account call count, so a test can simulate a
    // module that changes between page load and signing.
    fetch: async (_url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const rt = body.params && body.params.request_type;
      if (rt === "view_account") {
        const hash = typeof codeHash === "function" ? codeHash(viewAccountCalls++) : codeHash;
        return { ok: true, json: async () => ({ result: { code_hash: hash, amount: FIXTURE.view_account.amount } }) };
      }
      const method = body.params.method_name;
      let text;
      if (method === "quote") {
        const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString("utf8"));
        text = FIXTURE.quotes[`${args.product_id}:${args.payout}`];
      } else {
        text = FIXTURE.views[method];
      }
      if (text === undefined) throw new Error("fixture has no view for " + method);
      return { ok: true, json: async () => ({ result: { result: Array.from(Buffer.from(text, "utf8")) } }) };
    },
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "ui/index.html" });

  return { el: getEl, sandbox };
}

/** A wallet stub that records every action it is asked to sign. With
 *  `defer: true` the signAndSend promise is held open until the test calls
 *  `resolveSign` / `rejectSign`, which is how a slow or dead wallet (and a late
 *  answer after the page's own deadline) is simulated. */
function mockWallet({ accountId = "buyer-demo.testnet", result = null, failWith = null, networkMismatch = false, defer = false } = {}) {
  const subs = new Set();
  const state = { connected: false, accountId: null };
  const calls = [];
  let pendingResolve = null, pendingReject = null;
  const emit = () => { for (const fn of subs) fn({ connected: state.connected, accountId: state.accountId, networkMismatch }); };
  return {
    calls,
    NETWORK_ID: "testnet",
    DEFAULT_CONTRACT_ID: CONTRACT,
    configuredContract: CONTRACT,
    configure(id) { this.configuredContract = id; return id; },
    contractId() { return this.configuredContract; },
    async setup() { return this; },
    status() {
      return {
        ready: true, networkId: "testnet", contractId: this.configuredContract,
        connected: state.connected, accountId: state.accountId, networkMismatch,
        available: [
          { id: "here-wallet", name: "HERE Wallet", type: "injected", downloadUrl: null, present: true, extensionOnly: false },
          { id: "meteor-wallet", name: "Meteor Wallet", type: "injected", downloadUrl: "https://meteor.test", present: false, extensionOnly: true },
        ],
      };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async connect() { state.connected = true; state.accountId = accountId; emit(); return accountId; },
    async disconnect() { state.connected = false; state.accountId = null; emit(); },
    functionCall({ methodName, args, gas, deposit }) {
      return { type: "FunctionCall", params: { methodName, args: args ?? {}, gas: String(gas ?? "300000000000000"), deposit: String(deposit ?? "0") } };
    },
    async signAndSend(payload) {
      calls.push(payload);
      if (defer) return new Promise((res, rej) => { pendingResolve = res; pendingReject = rej; });
      if (failWith) throw new Error(failWith);
      return result;
    },
    resolveSign(v) { if (pendingResolve) { const r = pendingResolve; pendingResolve = null; pendingReject = null; r(v); } },
    rejectSign(e) { if (pendingReject) { const r = pendingReject; pendingResolve = null; pendingReject = null; r(e); } },
  };
}

const okResult = (hash) => ({ transaction_outcome: { id: hash }, status: { SuccessValue: "" } });
const failResult = (hash) => ({ transaction_outcome: { id: hash }, status: { Failure: { ActionError: { kind: "FunctionCallError" } } } });

/** Run one tick of the page's poll loop and wait for the quote panel to fill. */
async function settle(page, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    if (page.el("q-product").innerHTML.includes("heat-lagos")) return;
  }
  throw new Error("the page never rendered the product catalogue");
}


// ------------------------------------------------------------------ tests

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("the page builds and hands the wallet exactly one buy_cover with the contract's own premium", async () => {
  const wallet = mockWallet({ result: okResult("HASH-ABC") });
  const page = bootPage({ wallet });
  await settle(page);
  const accountId = await wallet.connect();
  assert.equal(accountId, "buyer-demo.testnet");

  page.el("b-buy").dispatch("click");
  await wait(50);

  assert.equal(wallet.calls.length, 1, "exactly one transaction must be requested");
  const call = wallet.calls[0];
  assert.equal(call.receiverId, CONTRACT);

  assert.equal(call.actions.length, 1, "exactly one action — no hidden extra call");
  const a = call.actions[0];
  assert.equal(a.type, "FunctionCall");
  assert.equal(a.params.methodName, "buy_cover");

  // The payout string is the product's own max, unrounded (u128 precision).
  assert.equal(a.params.args.product_id, "heat-lagos");
  assert.equal(a.params.args.payout, "300000000000000000000000");
  assert.equal(a.params.args.beneficiary, null);
  assert.ok(Number.isInteger(a.params.args.obs_date), "obs_date must be an integer unix second");

  // The deposit is the contract's own quote, not a client-side recomputation.
  assert.equal(a.params.deposit, "15000000000000000000000", "deposit must equal the contract quote (0.015 NEAR)");

  // The observation date must clear the page's own future-date floor.
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(a.params.args.obs_date >= nowSec + 120, "obs_date must be at least 120s ahead");

  assert.match(page.el("b-status").textContent, /Transaction confirmed/);
  assert.match(page.el("b-result").innerHTML, /HASH-ABC/);
});

test("a wallet that returns no hash is never reported as a purchase", async () => {
  const wallet = mockWallet({ result: { transaction_outcome: {} } });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.equal(wallet.calls.length, 1);
  assert.match(page.el("b-status").textContent, /no transaction hash/i);
  assert.match(page.el("b-result").innerHTML, /No cover was bought/);
  assert.doesNotMatch(page.el("b-status").textContent, /confirmed/i);
});

test("a contract failure result is not reported as a purchase", async () => {
  const wallet = mockWallet({ result: failResult("HASH-FAIL") });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.match(page.el("b-status").textContent, /the contract refused the transaction/);
  assert.match(page.el("b-result").innerHTML, /No cover was bought/);
  assert.doesNotMatch(page.el("b-status").textContent, /Transaction confirmed/);
});

test("a wallet rejection is surfaced as 'no cover bought', with no success claim", async () => {
  const wallet = mockWallet({ failWith: "User rejected the request" });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.match(page.el("b-status").textContent, /Purchase not completed/);
  assert.match(page.el("b-result").innerHTML, /No cover was bought/);
  assert.doesNotMatch(page.el("b-status").textContent, /confirmed/i);
});

test("a beneficiary is passed through when valid", async () => {
  const wallet = mockWallet({ result: okResult("HASH-BEN") });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-beneficiary").value = "someone-else.testnet";
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.equal(wallet.calls.length, 1);
  assert.equal(wallet.calls[0].actions[0].params.args.beneficiary, "someone-else.testnet");
});

test("an invalid beneficiary is refused before the wallet is ever asked to sign", async () => {
  const wallet = mockWallet({ result: okResult("HASH-NEVER") });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-beneficiary").value = "NOT A VALID ACCOUNT!";
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.equal(wallet.calls.length, 0, "no transaction may be requested for an invalid beneficiary");
  assert.match(page.el("b-status").textContent, /not a valid NEAR account id/);
});

test("buying is refused while no wallet is connected", async () => {
  const wallet = mockWallet({ result: okResult("HASH-NOPE") });
  const page = bootPage({ wallet });
  await settle(page);
  page.el("b-buy").dispatch("click");
  await wait(50);
  assert.equal(wallet.calls.length, 0);
  assert.match(page.el("b-status").textContent, /Connect a wallet first/);
});

test("the observation date is clamped to the future and never left in the past", async () => {
  const wallet = mockWallet({ result: okResult("HASH-OBS") });
  const page = bootPage({ wallet });
  await settle(page);
  const chosen = page.el("b-obsdate").value;
  assert.ok(chosen, "a default observation date must be filled in");
  const ms = new Date(chosen + ":00Z").getTime();
  assert.ok(ms > Date.now() + 60_000, "the default date must be comfortably in the future");
});

test("the page reads the premium from the contract, not from the product's basis points", async () => {
  const wallet = mockWallet({ result: okResult("HASH-PREM") });
  const page = bootPage({ wallet });
  await settle(page);
  // The quote panel shows the contract's own premium (0.0150 NEAR for a 300 NEAR
  // payout at 500 bp), matching the deployed quote exactly.
  assert.match(page.el("q-premium").textContent, /0\.0150 NEAR/);
});

// ---- contract/version honesty: the page must state the build it actually reads. ----

test("the page binds the wallet to the contract it reads, so a signature can never target another", async () => {
  const wallet = mockWallet({ result: okResult("HASH-BIND") });
  const page = bootPage({ wallet });
  await settle(page);
  assert.equal(wallet.configuredContract, CONTRACT,
    "the console must configure the wallet with the contract id it reads");
});

test("the default destination is the hardened contract, and buying is enabled on it", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet }); // fixture == the hardened module
  await settle(page);
  await wallet.connect();
  assert.equal(page.el("sec-tag").textContent, "Hardened build");
  assert.equal(page.el("b-buy").disabled, false, "buying must be enabled on a verified hardened build");
  assert.match(page.el("b-dest").innerHTML, new RegExp(CONTRACT.replace(/\./g, "\\.")),
    "the buy panel must state the exact destination address");
});

test("the legacy build is disclosed and its buy button is disabled", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, search: "?contract=" + LEGACY, codeHash: LEGACY_HASH });
  await settle(page);
  await wallet.connect();
  assert.equal(page.el("sec-tag").textContent, "Legacy build");
  assert.match(page.el("sec-text").innerHTML, /unauthenticated/);
  assert.equal(page.el("b-buy").disabled, true, "no purchase may be offered on the legacy address");
  assert.match(page.el("b-hint").textContent, /legacy address/i);
});

test("a legacy address reporting an unexpected module is refused, not trusted by its name", async () => {
  // Same address, but the deployed module is not the approved one.
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, search: "?contract=" + LEGACY, codeHash: "SomeUnknownHash1111111111111111111111111" });
  await settle(page);
  assert.equal(page.el("sec-tag").textContent, "Untrusted build");
  assert.equal(page.el("b-buy").disabled, true);
});

test("an unknown contract address is untrusted and cannot be signed against", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, search: "?contract=evil.example.testnet", codeHash: HARDENED_HASH });
  await settle(page);
  assert.equal(page.el("sec-tag").textContent, "Untrusted build");
  assert.match(page.el("sec-text").innerHTML, /not<\/b> an approved|not an approved/);
  assert.equal(page.el("b-buy").disabled, true, "an unapproved address must never be signable");
});

test("a malformed ?contract= is ignored and the hardened default stands", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, search: "?contract=NOT%20A%20VALID%20ACCOUNT!!" });
  await settle(page);
  assert.equal(wallet.configuredContract, CONTRACT, "a malformed contract id must not steer the read or the signature");
  assert.equal(page.el("sec-tag").textContent, "Hardened build");
});

test("a contract whose module has not been read yet is 'unknown' and un-signable", async () => {
  // The read has not returned a code hash: trust is unknown, so buying must be
  // refused until the module is verified — never assumed.
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, codeHash: null });
  await settle(page);
  assert.equal(page.el("sec-tag").textContent, "Verifying…");
  assert.match(page.el("sec-text").innerHTML, /approved Overcover build/);
  assert.equal(page.el("b-buy").disabled, true, "an unverified module must never be signable");
});

test("the hardened disclosure opens only for a legacy or untrusted build, never hides a warning", async () => {
  // A verified hardened build: the disclosure is collapsed by default (it is
  // evidence, not the pitch) and the class is the quiet default.
  const w1 = mockWallet({ result: okResult("H") });
  const hardened = bootPage({ wallet: w1 });
  await settle(hardened);
  assert.equal(hardened.el("sec-banner").className, "sec-status");
  assert.notEqual(hardened.el("sec-banner").open, true, "the hardened disclosure is collapsed by default");
  assert.match(hardened.el("sec-text").innerHTML, /separate build and is not yet deployed/,
    "the hardened disclosure must state the SEC-6/7/9 build is not deployed");

  // A legacy build: the disclosure is forced open and carries the bad-state class,
  // so the warning is never hidden behind a collapsed control.
  const w2 = mockWallet({ result: okResult("H") });
  const legacy = bootPage({ wallet: w2, search: "?contract=" + LEGACY, codeHash: LEGACY_HASH });
  await settle(legacy);
  assert.equal(legacy.el("sec-banner").className, "sec-status legacy");
  assert.equal(legacy.el("sec-banner").open, true, "a legacy warning must be open, not collapsed");
  assert.match(legacy.el("sec-summary").textContent, /blocked/i);
});

// ---- adversarial: the destination is re-verified immediately before signing. ----

test("doBuy re-verifies the module and refuses if it changed before signing", async () => {
  // The first read (page load) reports the hardened module, so the button is
  // enabled. The second read (immediately before signing) reports a different
  // module — simulating a contract substituted between load and signature.
  let calls = 0;
  const wallet = mockWallet({ result: okResult("HASH-SHOULD-NOT-HAPPEN") });
  const page = bootPage({ wallet, codeHash: () => (calls++ === 0 ? HARDENED_HASH : "SomeOtherModule1111111111111111111111111111") });
  await settle(page);
  await wallet.connect();
  assert.equal(page.el("b-buy").disabled, false, "the button is enabled from the first read");
  page.el("b-buy").dispatch("click");
  await wait(60);
  assert.equal(wallet.calls.length, 0, "no transaction may be signed once the module no longer matches");
  assert.match(page.el("b-status").textContent, /refusing to sign|not the verified hardened build/i);
});

test("doBuy signs exactly one buy_cover and never an owner-only method", async () => {
  const wallet = mockWallet({ result: okResult("HASH-ONE") });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  page.el("b-buy").dispatch("click");
  await wait(60);
  assert.equal(wallet.calls.length, 1);
  const methods = wallet.calls[0].actions.map((x) => x.params.methodName);
  assert.equal(methods.length, 1);
  assert.equal(methods[0], "buy_cover", "the console may sign only buy_cover");
  assert.equal(wallet.calls[0].receiverId, CONTRACT);
});

// ---- adversarial: the authorization is bound to the network as well as the
// account and module. A wallet that is not on NEAR testnet must not be able to
// buy, and the refusal must happen before any transaction is built. ----

test("a wallet on the wrong network cannot buy, and the button says why", async () => {
  const wallet = mockWallet({ result: okResult("SHOULD-NOT-HAPPEN"), networkMismatch: true });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  assert.equal(page.el("b-buy").disabled, true, "buying must be disabled on a non-testnet wallet");
  assert.match(page.el("b-hint").textContent, /not on NEAR testnet/i, "the hint must state the network problem");
});

test("doBuy refuses a wrong-network wallet before building or signing any call", async () => {
  const wallet = mockWallet({ result: okResult("SHOULD-NOT-HAPPEN"), networkMismatch: true });
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();
  // Even if the control were enabled programmatically, the guard must hold.
  page.el("b-buy").dispatch("click");
  await wait(60);
  assert.equal(wallet.calls.length, 0, "no transaction may be signed from a non-testnet wallet");
  assert.match(page.el("b-status").textContent, /not on NEAR testnet/i);
});

test("networkMismatch() fires on a .near (mainnet) account, not only on the selector's own network", async () => {
  // The selector is always configured with our testnet network, so comparing it
  // to NETWORK_ID alone is dead. The account TLD is the authoritative signal.
  const WALLET_JS = fs.readFileSync(path.join(root, "ui", "wallet.js"), "utf8");
  const fnBody = WALLET_JS.slice(WALLET_JS.indexOf("function networkMismatch()"));
  const body = fnBody.slice(0, fnBody.indexOf("\n}") + 2);
  const make = (accountId, networkId) =>
    new Function("selector", "currentAccountId", "NETWORK_ID", `${body}; return networkMismatch();`)(
      { options: { network: { networkId } } }, accountId, "testnet");
  assert.equal(make("alice.near", "testnet"), true, "a mainnet .near account must be reported as a mismatch");
  assert.equal(make("alice.testnet", "testnet"), false, "a testnet account on the testnet selector is not a mismatch");
  assert.equal(make("alice.testnet", "mainnet"), true, "a selector configured for mainnet is a mismatch");
});

// ---- adversarial: duplicate submission -----------------------------------
// A double-click (or a programmatic second call) while a buy is in flight must
// not produce a second transaction. The guard is buyState.busy, re-checked at
// the top of doBuy before any premium read or wallet request.
test("a second buy while one is in flight signs nothing extra", async () => {
  let resolveSign;
  const wallet = mockWallet({ result: okResult("HASH-DUP") });
  wallet.signAndSend = (payload) => {
    wallet.calls.push(payload);
    return new Promise((r) => { resolveSign = () => r(okResult("HASH-DUP")); });
  };
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(30); // first buy is now blocked awaiting the wallet
  assert.equal(wallet.calls.length, 1, "the first click requests one transaction");
  assert.equal(page.el("b-buy").disabled, true, "the buy button is disabled while a buy is in flight");
  assert.match(page.el("b-buy").textContent, /Waiting for your wallet/, "the button says it is waiting");

  page.el("b-buy").dispatch("click");
  page.el("b-buy").dispatch("click");
  await wait(20);
  assert.equal(wallet.calls.length, 1, "a second click while in flight must not sign another transaction");

  resolveSign();
  await wait(30);
  assert.equal(wallet.calls.length, 1, "no extra transaction appears after the first completes");
});

// ---- adversarial: wallet disconnection during execution ---------------------
// A wallet that disconnects while the buy is in flight, or that rejects after a
// delay, must still leave the control usable and must never claim a purchase.
test("a wallet that rejects mid-flight leaves the control usable and buys nothing", async () => {
  let rejectSign;
  const wallet = mockWallet({ result: okResult("HASH-NEVER") });
  wallet.signAndSend = (payload) => {
    wallet.calls.push(payload);
    return new Promise((_, rej) => { rejectSign = () => rej(new Error("User rejected the request")); });
  };
  const page = bootPage({ wallet });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(30);
  assert.equal(page.el("b-buy").disabled, true, "the control is disabled while a buy is in flight");
  assert.equal(wallet.calls.length, 1, "one transaction was requested");

  rejectSign(); // the user declines, or the extension closes
  await wait(40);

  assert.match(page.el("b-status").textContent, /Purchase not completed/, "a rejection is not a purchase");
  assert.match(page.el("b-result").innerHTML, /No cover was bought/);
  assert.equal(page.el("b-buy").disabled, false, "the control is usable again after a rejection");
});

// ---- adversarial: the wallet never answers (RPC timeout / dead extension) ----
// signAndSend must be bounded: a wallet that never calls back cannot leave the
// button disabled forever, and the outcome must be reported as UNKNOWN — never
// as success, never as a definite failure.
test("a wallet that never answers times out with an honest 'outcome unknown', not a hang or a fake success", async () => {
  const wallet = mockWallet({ result: okResult("HASH-SHOULD-NOT-CLAIM") });
  wallet.signAndSend = (payload) => {
    wallet.calls.push(payload);
    return new Promise(() => {}); // never resolves or rejects
  };
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(120);

  assert.equal(wallet.calls.length, 1, "exactly one transaction was requested");
  assert.match(page.el("b-status").textContent, /No answer from your wallet/, "the status says the wallet did not answer");
  assert.match(page.el("b-result").innerHTML, /outcome unknown/i, "the outcome is reported as unknown");
  assert.doesNotMatch(page.el("b-status").textContent, /confirmed/i, "a timeout is never a confirmed purchase");
  assert.doesNotMatch(page.el("b-result").innerHTML, /Cover in force/, "a timeout never claims cover is in force");
  // The wallet promise is still outstanding, so the outcome is genuinely
  // unknown: buying must stay BLOCKED (disabled) until the wallet answers, or a
  // retry could send a second signed buy_cover for the same intent.
  assert.equal(page.el("b-buy").disabled, true, "buying stays blocked while the wallet request is unresolved");
  assert.match(page.el("b-hint").textContent, /has not answered/i, "the block is explained, not silent");
});

// ---- adversarial: retry across the timeout boundary -------------------------
// The exact sequence the mission asks for: purchase -> pending wallet -> the
// page's deadline -> "outcome unknown" -> the user retries -> the ORIGINAL
// wallet promise then resolves. Two independently signed buy_cover calls for one
// intent must be impossible.
test("a retry after a timeout cannot sign a second purchase while the first is unresolved", async () => {
  const wallet = mockWallet({ defer: true });
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(120); // the deadline fires; the wallet is still pending
  assert.equal(wallet.calls.length, 1, "the first purchase was requested");
  assert.match(page.el("b-result").innerHTML, /outcome unknown/i);
  assert.equal(page.el("b-buy").disabled, true, "the buy control is blocked, not released");

  // The user tries again. It must be refused BEFORE any second signing request.
  page.el("b-buy").dispatch("click");
  await wait(40);
  assert.equal(wallet.calls.length, 1, "a retry must not reach the wallet while the first is unresolved");
  assert.match(page.el("b-status").textContent, /has not answered the previous request|has not answered yet/i);

  // The original promise now resolves with a confirmed transaction. It is
  // reconciled honestly: cover in force, from the wallet's own hash.
  wallet.resolveSign(okResult("HASH-LATE-1"));
  await wait(60);
  assert.match(page.el("b-status").textContent, /confirmed/i, "a late confirmed answer is recovered, not discarded");
  assert.match(page.el("b-result").innerHTML, /HASH-LATE-1/, "the recovered hash is the wallet's own");
  assert.equal(wallet.calls.length, 1, "still exactly one signing request — no duplicate purchase");
  assert.equal(page.el("b-buy").disabled, false, "buying is unblocked once the wallet has answered");
});

// ---- adversarial: a late NON-confirming answer ------------------------------
// If the outstanding promise resolves without a transaction hash, the page must
// not claim cover; the outcome is a definite "no cover was bought".
test("a late wallet answer with no hash is reported as no cover, never as success", async () => {
  const wallet = mockWallet({ defer: true });
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(120);
  wallet.resolveSign({ transaction_outcome: {} }); // answered, but no hash
  await wait(60);
  assert.doesNotMatch(page.el("b-result").innerHTML, /Cover in force/);
  assert.match(page.el("b-status").textContent, /No cover was bought/i);
  assert.equal(page.el("b-buy").disabled, false, "the block is released once the wallet has answered");
});

// ---- adversarial: a late wallet REJECTION -----------------------------------
test("a late wallet rejection is reported as no cover, and unblocks buying", async () => {
  const wallet = mockWallet({ defer: true });
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(120);
  wallet.rejectSign(new Error("User rejected the request"));
  await wait(60);
  assert.match(page.el("b-status").textContent, /Purchase not completed/i);
  assert.match(page.el("b-result").innerHTML, /No cover was bought/);
  assert.equal(page.el("b-buy").disabled, false);
});

// ---- adversarial: the persistent "do not retry" notice ----------------------
// The block must be visible even after the changing hint line is rewritten, so a
// user cannot be left pressing a disabled control with no explanation. The
// dedicated notice appears on the timeout and clears once the wallet answers.
test("a timeout shows a persistent 'outcome unknown — do not retry' notice that clears when the wallet answers", async () => {
  const wallet = mockWallet({ defer: true });
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  assert.equal(page.el("b-pending").hidden, true, "no notice before a purchase");
  page.el("b-buy").dispatch("click");
  await wait(120); // deadline fires, wallet still pending
  assert.equal(page.el("b-pending").hidden, false, "the notice is shown on timeout");
  assert.match(page.el("b-pending").innerHTML, /outcome unknown/i);
  assert.match(page.el("b-pending").innerHTML, /do not retry/i);

  wallet.resolveSign(okResult("HASH-NOTICE"));
  await wait(60);
  assert.equal(page.el("b-pending").hidden, true, "the notice clears once the wallet has answered");
  assert.equal(wallet.calls.length, 1, "still exactly one signing request");
});

// ---- adversarial: a late answer must not overwrite a newer purchase ---------
// A late answer from an old request may only clear the block; it must never
// mutate state that belongs to a newer purchase. After reconciliation the user
// can buy again, and that second purchase is a single, separate request.
test("a reconciled late answer does not corrupt a subsequent purchase", async () => {
  const wallet = mockWallet({ defer: true });
  const page = bootPage({ wallet, signTimeoutMs: 40 });
  await settle(page);
  await wallet.connect();

  page.el("b-buy").dispatch("click");
  await wait(120);
  wallet.resolveSign(okResult("HASH-FIRST"));
  await wait(60);
  assert.equal(page.el("b-buy").disabled, false);

  // A fresh purchase after reconciliation signs exactly once more. (The mock
  // wallet defers again, so this second request is itself held open — the point
  // is only that it is a single, new signing request, not a duplicate.)
  page.el("b-buy").dispatch("click");
  await wait(15);
  assert.equal(wallet.calls.length, 2, "the second purchase is a single new signing request");
  assert.equal(page.el("b-pending").hidden, true, "the old notice is not resurrected by a new purchase");
});

// ---- adversarial: reload during a pending settlement ------------------------
// The console holds no pending state of its own. On load it must render the
// contract's own view: an active policy past its observation date is shown as
// awaiting settlement, never as settled and never as paid.
test("a reload during a pending settlement shows the contract's status, not a local guess", async () => {
  const wallet = mockWallet({ result: okResult("HASH-RELOAD") });
  const page = bootPage({ wallet });
  await settle(page); // simulates a fresh page load with a settlement still pending
  const pol = page.el("policies").innerHTML;
  // The fixture holds one settled policy (#1) and one still awaiting resolve (#2).
  const pendingRow = pol.slice(pol.indexOf("#2"), pol.indexOf("#1"));
  assert.match(pendingRow, /settlement due|awaiting resolve/i, "the pending policy is shown from the contract state");
  assert.doesNotMatch(pendingRow, /settled paid/, "a reload must never render the unsettled policy as paid");
});
