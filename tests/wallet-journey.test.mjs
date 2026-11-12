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

const CONTRACT = "contract.attestor-overcover.testnet";
const ONE_NEAR = 10n ** 24n;

// ------------------------------------------------------------------ DOM shim

function makeElement(id) {
  const listeners = {};
  return {
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
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    removeChild() {},
    focus() {},
    select() {},
    showModal() {},
    close() {},
  };
}

/** Build a fresh DOM + global environment, run the page script inside a vm
 *  context (so Node's getter-only globals are not touched), and return a handle
 *  with the elements and the mock wallet for assertions. */
function bootPage({ wallet, codeHash = FIXTURE.view_account.code_hash }) {
  const elements = new Map();
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
    location: { search: "" },
    navigator: {},
    OvercoverWallet: wallet,
    OvercoverPolicy: null,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
    BigInt, Number, String, Array, Object, JSON, Math, Date, Boolean, RegExp, Error, Promise,
    Uint8Array, TextDecoder, URLSearchParams,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    // Serve the frozen contract snapshot instead of a network RPC. The page's
    // view() sends call_function; accountState() sends view_account. A quote call
    // carries args, so it is matched against the frozen quotes map.
    fetch: async (_url, opts) => {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      const rt = body.params && body.params.request_type;
      if (rt === "view_account") {
        return { ok: true, json: async () => ({ result: { code_hash: codeHash, amount: FIXTURE.view_account.amount } }) };
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

/** A wallet stub that records every action it is asked to sign. */
function mockWallet({ accountId = "buyer-demo.testnet", result = null, failWith = null } = {}) {
  const subs = new Set();
  const state = { connected: false, accountId: null };
  const calls = [];
  const emit = () => { for (const fn of subs) fn({ connected: state.connected, accountId: state.accountId, networkMismatch: false }); };
  return {
    calls,
    NETWORK_ID: "testnet",
    CONTRACT_ID: CONTRACT,
    DEFAULT_CONTRACT_ID: CONTRACT,
    configuredContract: CONTRACT,
    configure(id) { this.configuredContract = id; return id; },
    contractId() { return this.configuredContract; },
    async setup() { return this; },
    status() {
      return {
        ready: true, networkId: "testnet", contractId: CONTRACT,
        connected: state.connected, accountId: state.accountId, networkMismatch: false,
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
      if (failWith) throw new Error(failWith);
      return result;
    },
  };
}

const okResult = (hash) => ({ transaction_outcome: { id: hash }, status: { SuccessValue: "" } });
const failResult = (hash) => ({ transaction_outcome: { id: hash }, status: { Failure: { ActionError: { kind: "FunctionCallError" } } } });

/** Run one tick of the page's poll loop and wait for the quote panel to fill. */
async function settle(page, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
    if (page.el("q-product").innerHTML.includes("rain-lagos")) return;
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
  assert.equal(a.params.args.product_id, "rain-lagos");
  assert.equal(a.params.args.payout, (1n * ONE_NEAR).toString());
  assert.equal(a.params.args.beneficiary, null);
  assert.ok(Number.isInteger(a.params.args.obs_date), "obs_date must be an integer unix second");

  // The deposit is the contract's own quote, not a client-side recomputation.
  assert.equal(a.params.deposit, "50000000000000000000000", "deposit must equal the contract quote (0.05 NEAR)");

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
  // The quote panel shows the contract's own premium (0.0500 NEAR).
  assert.match(page.el("q-premium").textContent, /0\.0500 NEAR/);
});

// ---- contract/version honesty: the page must state the build it actually reads. ----

test("the page binds the wallet to the contract it reads, so a signature can never target another", async () => {
  const wallet = mockWallet({ result: okResult("HASH-BIND") });
  const page = bootPage({ wallet });
  await settle(page);
  assert.equal(wallet.configuredContract, CONTRACT,
    "the console must configure the wallet with the contract id it reads");
});

test("the legacy build is labelled as the original, vulnerable module", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet }); // fixture code_hash == the legacy module
  await settle(page);
  assert.equal(page.el("sec-banner").hidden, false, "the security banner must be shown");
  assert.match(page.el("sec-tag").textContent, /Legacy build/);
  assert.match(page.el("sec-text").innerHTML, /unauthenticated/);
  assert.match(page.el("sec-text").innerHTML, /contract\.ovc-v3-ctl-2f6c4c\.testnet/);
});

test("a hardened module is labelled as hardened, from its own code hash", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, codeHash: "CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL" });
  await settle(page);
  assert.match(page.el("sec-tag").textContent, /Hardened build/);
  assert.match(page.el("sec-text").innerHTML, /migrate\(\)/);
});

test("an unknown module is never presented as hardened", async () => {
  const wallet = mockWallet({ result: okResult("H") });
  const page = bootPage({ wallet, codeHash: "SomeUnknownHashThatIsNotOurs111111111111111" });
  await settle(page);
  assert.match(page.el("sec-tag").textContent, /Unrecognised build/);
  assert.doesNotMatch(page.el("sec-text").innerHTML, /hardened module/);
});
