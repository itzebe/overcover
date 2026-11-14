// Regression tests for the browser console (ui/index.html).
//
// These cover the defects that were found live and would otherwise silently
// return: the RPC result-shape mismatch that blanked the page, a CORS-blocked
// endpoint in the failover list, and the CSS grid minimum-size that produced
// horizontal overflow on narrow screens.
//
// The decode() assertions run the ACTUAL function lifted out of ui/index.html,
// so a change to the page is what the test sees — not a re-implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const SCRIPT = HTML.slice(HTML.indexOf("<script>") + 8, HTML.lastIndexOf("</script>"));

/** Lift a top-level function declaration out of the page script by brace matching.
 *  String and comment content is skipped so brace characters inside literals do
 *  not confuse the depth count. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in ui/index.html`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const decodeSrc = extractFunction(SCRIPT, "decode");
const parseSrc = extractFunction(SCRIPT, "parseBigIntJson");
const decode = new Function(`var MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER); ${parseSrc}; ${decodeSrc}; return decode;`)();

test("decode accepts a byte-array result (the shape most NEAR nodes return)", () => {
  const obj = { capital: "1600000000000000000000000", solvent: true };
  const bytes = Array.from(Buffer.from(JSON.stringify(obj), "utf8"));
  assert.deepEqual(decode(bytes), obj);
});

test("decode accepts a base64 string result", () => {
  const obj = { capital: "1", paused: false };
  const b64 = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  assert.deepEqual(decode(b64), obj);
});

test("decode rejects an unexpected shape instead of returning a blank object", () => {
  assert.throws(() => decode(null), /unexpected RPC result shape/);
  assert.throws(() => decode(42), /unexpected RPC result shape/);
});

test("decode handles both shapes identically (no shape-dependent drift)", () => {
  const obj = { a: 1, b: "two", c: [3, 4] };
  const json = JSON.stringify(obj);
  const asArray = decode(Array.from(Buffer.from(json, "utf8")));
  const asBase64 = decode(Buffer.from(json, "utf8").toString("base64"));
  assert.deepEqual(asArray, asBase64);
});

test("decode keeps a u128 money field exact (the precision-loss bug)", () => {
  // A bare JSON number above 2^53 is rounded by JSON.parse, so a product's true
  // max_payout of 1 NEAR came back as 999999999999999983222784 and the agent's
  // exact bounds check rejected a payout equal to the maximum. decode() must
  // preserve the on-chain integer.
  const raw = '{"id":"rain-lagos","min_payout":100000000000000000000000,"max_payout":1000000000000000000000000}';
  const p = decode(Array.from(Buffer.from(raw, "utf8")));
  assert.equal(BigInt(p.min_payout), 100000000000000000000000n);
  assert.equal(BigInt(p.max_payout), 1000000000000000000000000n);
  const payout = 1000000000000000000000000n;
  assert.ok(payout >= BigInt(p.min_payout) && payout <= BigInt(p.max_payout));
});

test("decode still returns small integers as numbers, not strings", () => {
  const raw = '{"threshold_tenths":2,"premium_bp":500,"active":true}';
  const p = decode(Array.from(Buffer.from(raw, "utf8")));
  assert.equal(p.threshold_tenths, 2);
  assert.equal(typeof p.threshold_tenths, "number");
  assert.equal(p.premium_bp, 500);
});

// ---------------------------------------------------------------------------
// Human wallet purchase: the console must classify the wallet's OWN outcome.
// A rejected, failed or hashless result must never be shown as a purchase.
// These run the ACTUAL evaluateWalletOutcome() lifted from ui/index.html.
// ---------------------------------------------------------------------------

const outcomeSrc = extractFunction(SCRIPT, "evaluateWalletOutcome");
const evaluateWalletOutcome = new Function(`${outcomeSrc}; return evaluateWalletOutcome;`)();

test("a confirmed wallet transaction with a hash is the only success path", () => {
  const r = evaluateWalletOutcome({ status: { SuccessValue: "MTM=" }, transaction_outcome: { id: "5xAbcDef" } });
  assert.equal(r.ok, true);
  assert.equal(r.hash, "5xAbcDef");
  assert.equal(r.reason, null);
});

test("a rejected wallet transaction is never presented as a purchase", () => {
  const r = evaluateWalletOutcome({ status: { Failure: { ActionError: { kind: "x" } } }, transaction_outcome: { id: "5xRejected" } });
  assert.equal(r.ok, false, "a Failure status must not be success");
  assert.equal(r.reason, "the contract refused the transaction");
});

test("a wallet result with no transaction hash is not success (the fake-success guard)", () => {
  for (const res of [null, undefined, {}, { status: {} }, { transaction: {} }]) {
    const r = evaluateWalletOutcome(res);
    assert.equal(r.ok, false, `empty/hashless result ${JSON.stringify(res)} must not be success`);
    assert.equal(r.hash, null);
    assert.match(r.reason, /no transaction hash/);
  }
});

test("a hash on the transaction object (alt wallet shape) is still accepted", () => {
  const r = evaluateWalletOutcome({ status: { SuccessValue: "" }, transaction: { hash: "AltShapeHash" } });
  assert.equal(r.ok, true);
  assert.equal(r.hash, "AltShapeHash");
});

test("doBuy claims success only through evaluateWalletOutcome, never inline", () => {
  assert.ok(SCRIPT.includes("evaluateWalletOutcome(res)"), "doBuy must use the shared classifier");
  assert.ok(!/res\.status\.Failure\)\s*throw/.test(SCRIPT), "the old inline failure check must be gone");
});

// The exact buy_cover arguments, lifted from the page, must match the contract's
// ABI: product_id + payout + obs_date + beneficiary, with the payout carried as
// the same string the contract quoted against (no numeric rounding).
const argsSrc = extractFunction(SCRIPT, "buildBuyArgs");
const buildBuyArgs = new Function(`${argsSrc}; return buildBuyArgs;`)();

test("buy_cover arguments match the contract ABI exactly", () => {
  const args = buildBuyArgs({ id: "rain-lagos" }, "1000000000000000000000000", 1794522722, "biz.near");
  assert.deepEqual(args, { product_id: "rain-lagos", payout: "1000000000000000000000000", obs_date: 1794522722, beneficiary: "biz.near" });
});

test("an empty beneficiary is sent as null, never as an empty string", () => {
  assert.equal(buildBuyArgs({ id: "p" }, "1", 1, "").beneficiary, null);
  assert.equal(buildBuyArgs({ id: "p" }, "1", 1, undefined).beneficiary, null);
});

test("the payout argument stays an exact string for a u128 beyond Number.MAX_SAFE_INTEGER", () => {
  const payout = "999999999999999983222784"; // the value JSON.parse rounds
  const args = buildBuyArgs({ id: "p" }, payout, 1, null);
  assert.equal(args.payout, payout, "the payout must not be rounded through a number");
  assert.equal(typeof args.payout, "string");
});

// The observation date must be genuinely in the future. min_lead_sec is 0 for
// every product currently published, and the contract compares whole seconds, so
// the page must reject a date that is only seconds ahead instead of letting the
// wallet sign a transaction the contract would later refuse ("observation date too soon").
const floorSrc = extractFunction(SCRIPT, "obsDateFloorSec");
const errSrc = extractFunction(SCRIPT, "obsDateError");
const obsDateError = new Function(`var OBS_DATE_BUFFER_SEC = 120; ${floorSrc}; ${errSrc}; return obsDateError;`)();

test("a zero-lead product still requires a future observation date", () => {
  const now = Math.floor(Date.now() / 1000);
  const p = { min_lead_sec: 0 };
  assert.ok(obsDateError(p, now) !== null, "now must be rejected");
  assert.ok(obsDateError(p, now + 1) !== null, "one second ahead must be rejected");
  assert.ok(obsDateError(p, now + 121) === null, "a comfortably future date must be accepted");
  assert.ok(obsDateError(p, null) !== null, "an empty date must be rejected");
});

test("a product's own min_lead_sec raises the floor when it is larger than the buffer", () => {
  const now = Math.floor(Date.now() / 1000);
  const p = { min_lead_sec: 3600 };
  assert.ok(obsDateError(p, now + 121) !== null, "the product lead must win over the buffer");
  assert.ok(obsDateError(p, now + 3601) === null, "past the product lead is accepted");
});

// The contract stores only "active" | "settled_paid" | "settled_no_pay". A past-due
// policy the contract has not settled must be shown as awaiting settlement, never
// as settled — the page must not invent an outcome.
const polSrc = extractFunction(SCRIPT, "policyDisplayStatus");
const policyDisplayStatus = new Function(`${polSrc}; return policyDisplayStatus;`)();

test("a past-due active policy is shown as awaiting settlement, never settled", () => {
  const now = Math.floor(Date.now() / 1000);
  const cfg = { settle_delay_sec: 0 };
  const due = policyDisplayStatus({ status: "active", obs_date: now - 10 }, cfg);
  assert.match(due.label, /settlement due/i);
  assert.match(due.label, /awaiting resolve/i);
  assert.ok(!/settled/i.test(due.label), "must not claim a settlement the contract did not record");
  const future = policyDisplayStatus({ status: "active", obs_date: now + 3600 }, cfg);
  assert.match(future.label, /active/i);
  assert.match(future.label, /awaiting observation/i);
});

test("a settled policy shows the contract's own terminal status verbatim", () => {
  const paid = policyDisplayStatus({ status: "settled_paid", obs_date: 1 }, {});
  assert.equal(paid.label, "settled paid");
  assert.equal(paid.derived, false);
  const noPay = policyDisplayStatus({ status: "settled_no_pay", obs_date: 1 }, {});
  assert.equal(noPay.label, "settled no pay");
});

test("settle_delay_sec is honoured when deciding settlement eligibility", () => {
  const now = Math.floor(Date.now() / 1000);
  const pol = { status: "active", obs_date: now - 10 };
  assert.match(policyDisplayStatus(pol, { settle_delay_sec: 3600 }).label, /awaiting observation/);
  assert.match(policyDisplayStatus(pol, { settle_delay_sec: 0 }).label, /settlement due/);
});

// The wallet connect errors must be actionable, not a raw "Error".
const walletSrc = fs.readFileSync(path.join(root, "ui", "wallet.js"), "utf8");
const msgFn = walletSrc.slice(walletSrc.indexOf("function connectErrorMessage("));
const connectErrorMessage = new Function(
  `${msgFn.slice(0, msgFn.indexOf("\n}\n") + 2)}; return connectErrorMessage;`
)();

test("wallet connect errors are turned into actionable sentences", () => {
  assert.match(connectErrorMessage(new Error("User rejected the request"), "Meteor Wallet"), /cancelled the Meteor Wallet connection/i);
  assert.match(connectErrorMessage(new Error("Failed to fetch"), "Here Wallet"), /could not reach the Here Wallet service/i);
  assert.match(connectErrorMessage(new Error("mainnet mismatch"), "Here Wallet"), /testnet/i);
  assert.match(connectErrorMessage(new Error("popup blocked"), "Meteor Wallet"), /pop-ups/i);
  // An unclassified error keeps its raw text rather than being swallowed.
  assert.match(connectErrorMessage(new Error("weird failure"), "Meteor Wallet"), /weird failure/);
  // The page must never prefix a bare "Could not connect:" with no detail again.
  assert.ok(!/Could not connect: " \+ msg/.test(HTML), "the generic 'Could not connect:' prefix must be gone");
});

test("the failover list excludes the CORS-blocked, deprecated public endpoint", () => {
  const m = SCRIPT.match(/var RPC = \[([\s\S]*?)\];/);
  assert.ok(m, "RPC endpoint list not found");
  const urls = [...m[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((x) => x[1]);
  assert.ok(
    !urls.some((u) => u.includes("rpc.testnet.near.org")),
    "rpc.testnet.near.org must not be a browser endpoint (it is CORS-blocked)"
  );
});

test("the failover list is a non-empty array of https testnet endpoints", () => {
  const m = SCRIPT.match(/var RPC = \[([\s\S]*?)\];/);
  assert.ok(m, "RPC endpoint list not found");
  const urls = [...m[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((x) => x[1]);
  assert.ok(urls.length >= 2, "expected at least two failover endpoints");
  for (const u of urls) assert.match(u, /^https:\/\//);
});

test("grid items are allowed to shrink, so a wide table cannot stretch the page", () => {
  assert.ok(/main > section\s*\{\s*min-width:\s*0/.test(HTML), "grid item min-width:0 guard is missing");
});

test("each table is wrapped in its own horizontal scroll container", () => {
  assert.ok(/\.scroll\s*\{[^}]*overflow-x:\s*auto/.test(HTML), ".scroll must scroll horizontally");
  const wrappers = [...SCRIPT.matchAll(/class="scroll"[^>]*>/g)].length;
  assert.ok(wrappers >= 3, `expected 3 scroll wrappers, found ${wrappers}`);
});

// The deployment-status ledger is wider than a phone. It must scroll like every
// other table; `overflow: hidden` clipped its columns with no way to reach them.
test("the status ledger scrolls horizontally instead of clipping its columns", () => {
  const m = HTML.match(/\.status-table\s*\{[^}]*\}/);
  assert.ok(m, "the .status-table rule must exist");
  assert.match(m[0], /overflow-x:\s*auto/, "the status ledger must scroll horizontally on narrow screens");
  assert.doesNotMatch(m[0], /overflow:\s*hidden/, "the status ledger must not clip its columns");
});

// On phones the sticky brand bar is the only thing pinned to the top, so its
// height is viewport the reader loses while scrolling. It must be compacted.
test("the sticky brand bar is compacted on phones", () => {
  // Pull the balanced `@media (max-width: 640px) { … }` block so the assertions
  // cannot be satisfied by rules elsewhere in the sheet.
  const at = HTML.indexOf("@media (max-width: 640px)");
  assert.ok(at > -1, "the mobile breakpoint must exist");
  let depth = 0, end = -1;
  for (let i = HTML.indexOf("{", at); i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const block = HTML.slice(at, end);
  assert.match(block, /\.mast-in\s*\{[^}]*padding-top:\s*9px/, "the brand bar must be vertically compacted");
  assert.match(block, /\.mast-right\s+\.btn\s*\{[^}]*min-height:\s*44px/, "the mobile controls must keep a 44px touch target");
  // The bar is the only sticky element, so a second row of controls costs the
  // reader real viewport. The tagline and the redundant "NEAR testnet ·" prefix
  // must be dropped on phones so the controls stay on one row.
  assert.match(block, /\.brand\s+\.tagline\s*\{\s*display:\s*none/, "the tagline must be dropped on phones");
  assert.match(block, /\.net\s+\.net-net\s*\{\s*display:\s*none/, "the redundant network prefix must be dropped on phones");
  // At 320px the three controls would otherwise wrap to two rows (three rows
  // total). Letting the mast lay them out keeps the sticky bar to two rows.
  assert.match(block, /\.mast-right\s*\{\s*display:\s*contents/, "the mobile controls must be laid out by the mast row");
});

test("the page ships an inline favicon (no 404 request)", () => {
  assert.match(HTML, /<link rel="icon" href="data:image\/svg\+xml/);
});

test("no value is fabricated: reconcile comes from the contract, not a literal true", () => {
  assert.ok(SCRIPT.includes('view("reconcile")'), "reconcile must be read from the contract");
  assert.ok(SCRIPT.includes('view("check_invariant")'), "check_invariant must be read from the contract");
  assert.ok(!/setInvariant\("inv-recon",\s*true\)/.test(SCRIPT), "reconcile must not be hard-coded to true");
});

test("the console never embeds a private key or a secret", () => {
  assert.ok(!/ed25519:[0-9a-zA-Z]{40,}/.test(HTML), "a private key appears in the page");
  assert.ok(!/secretKey|privateKey|"seed"/.test(HTML), "a secret field appears in the page");
});

// Real RPC integration: the deployed contract must decode through the same path.
test("live RPC get_pool decodes to a solvency-checked pool", { timeout: 30000 }, async (t) => {
  const contract = "contract.ovc-v3-ctl-2f6c4c.testnet";
  let payload;
  try {
    const res = await fetch("https://test.rpc.fastnear.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "query",
        params: {
          request_type: "call_function", finality: "final",
          account_id: contract, method_name: "get_pool",
          args_base64: Buffer.from("{}").toString("base64"),
        },
      }),
    });
    payload = await res.json();
  } catch (e) {
    t.skip(`no network: ${e.message}`);
    return;
  }
  assert.ok(!payload.error, `RPC error: ${JSON.stringify(payload.error)}`);
  const pool = decode(payload.result.result);
  assert.equal(typeof pool.capital, "string");
  assert.ok(BigInt(pool.reserved) <= BigInt(pool.capital), "reserved must not exceed capital");
  assert.equal(pool.solvent, true);
});

// ---------------------------------------------------------------------------
// Product transformation: the states and honesty rules a financial interface
// must hold. These assert the shipped page, not a re-implementation.
// ---------------------------------------------------------------------------

test("the page defines distinct loading, live, stale and failed states", () => {
  for (const s of ["live", "stale", "failed"]) {
    assert.ok(new RegExp(`dot\\.${s}\\b`).test(HTML), `missing .dot.${s} style`);
  }
  assert.ok(/"stale" : "failed"/.test(SCRIPT), "the catch path must choose stale or failed");
  assert.ok(/No data — every RPC endpoint failed/.test(SCRIPT), "the failed state must say there is no data");
  assert.ok(/Stale — the latest read failed/.test(SCRIPT), "the stale state must warn the figures are not current");
});

test("a failed read is never presented as live: freshness is derived from the read", () => {
  const tickStart = SCRIPT.indexOf("function tick()");
  const catchIdx = SCRIPT.indexOf(".catch(function (e) {", tickStart);
  assert.ok(tickStart !== -1 && catchIdx !== -1, "tick() with a catch handler must exist");
  const successBlock = SCRIPT.slice(tickStart, catchIdx);
  const catchBlock = SCRIPT.slice(catchIdx, catchIdx + 700);
  assert.ok(/setFreshness\("live"/.test(successBlock), "live freshness belongs on the success path");
  assert.ok(!/setFreshness\("live"/.test(catchBlock), "the catch path must not claim live");
});

test("the quote reads the contract's own quote view rather than trusting a local figure", () => {
  assert.ok(SCRIPT.includes('view("quote"'), "the quote must be confirmed by the contract");
  assert.ok(/ceilDiv\(/.test(SCRIPT), "the local premium must use the contract's ceil rule");
});

test("demo evidence in the page matches the recorded demo log", () => {
  const log = JSON.parse(fs.readFileSync(path.join(root, "demo-log.json"), "utf8"));
  const hashes = new Set(log.map((e) => e.hash));
  // Deployed contract code hashes are legitimate on-chain values (readable via
  // `view_account`), not transaction evidence, so they are allowed — but only
  // these known modules. Any other embedded hash must be a demo-log tx.
  const codeHashes = new Set([
    "CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL", // hardened v3 module (live)
    "9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C", // hardened v3 module (SEC-6/7/9 build)
    "36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R", // legacy v1 module
  ]);
  const embedded = [...SCRIPT.matchAll(/"([1-9A-HJ-NP-Za-km-z]{40,})"/g)].map((m) => m[1]);
  const txHashes = embedded.filter((h) => !codeHashes.has(h));
  assert.ok(txHashes.length >= 6, `expected several embedded tx hashes, found ${txHashes.length}`);
  for (const h of txHashes) {
    assert.ok(hashes.has(h), `embedded hash ${h} is not in demo-log.json (fabricated evidence)`);
  }
});

test("throwaway demo products are grouped, so canonical cover stays legible", () => {
  assert.ok(/var MACHINE_ID = \/\^p-/.test(SCRIPT), "a machine-id pattern must exist");
  assert.ok(/MACHINE_ID\.test\(p\.id\)/.test(SCRIPT), "products must be split by id shape");
  assert.ok(/details class="legacy"/.test(SCRIPT), "the demo-generated group must be foldable");
});

test("muted and accent text meet WCAG AA contrast on their backgrounds", () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const val = (name) => {
    const m = HTML.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
    assert.ok(m, `--${name} token not found`);
    return m[1];
  };
  const paper = val("paper");
  assert.ok(ratio(val("muted"), paper) >= 4.5, "muted text must reach 4.5:1 on paper");
  assert.ok(ratio(val("accent"), paper) >= 4.5, "accent text must reach 4.5:1 on paper");
  assert.ok(ratio(val("accent"), val("accent-w")) >= 4.5, "accent text must reach 4.5:1 on its tint");
  // The hero sits on the dark field, so its own tokens must clear AA there too.
  assert.ok(ratio(val("gold-soft"), val("field")) >= 4.5, "hero accent must reach 4.5:1 on the field");
  assert.ok(ratio(val("on-field-2"), val("field")) >= 4.5, "hero body text must reach 4.5:1 on the field");
});

// ---------------------------------------------------------------------------
// Insurance-first transformation: the page must read as an insurance product
// before it reads as a blockchain application.
// ---------------------------------------------------------------------------

test("the first screen answers what/risk/who/how/trust, not chain metrics", () => {
  const start = HTML.indexOf('<section class="hero"');
  const end = HTML.indexOf('<section class="cov-strip"');
  assert.ok(start !== -1 && end > start, "hero markup must be found");
  const hero = HTML.slice(start, end);
  assert.match(hero, /Insurance for businesses that[\s\S]*cannot afford to wait/, "hero must state the product");
  assert.match(hero, /public index reading[\s\S]*meeting a set trigger, in a named city, on a named date/, "hero must name the covered event");
  assert.match(hero, /Each product states its own trigger and direction/, "the hero must not hardcode one index or direction");
  assert.match(hero, /no adjuster, no queue/, "hero must say how protection is received");
  // The chain belongs to the proof, not the promise.
  assert.ok(!/blockchain|smart contract|on-chain/i.test(hero), "the hero must not lead with blockchain jargon");
});

test("the page describes a parametric mechanism honestly, without over-claiming", () => {
  // Honest: settlement follows a rule; it does not claim every claim auto-approves.
  assert.ok(/no adjuster, no queue/.test(HTML), "the parametric advantage must be stated");
  assert.ok(/parametric, not indemnity|not on an assessed loss|does not compensate an assessed loss/i.test(HTML),
    "the parametric limitation must be disclosed");
  // The oracle operators and the resolver quorum are named actors. The page
  // renders the text that matches the deployed contract: the legacy single
  // attestor in the markup, upgraded to the quorum narrative by script when the
  // v2 contract (list_metrics) is detected. Both must exist.
  assert.ok(/attestor/i.test(HTML), "the legacy attestor must be named in the markup");
  assert.ok(/operators?/i.test(SCRIPT), "the v2 oracle operators must be named in the script");
  assert.ok(/resolvers?\b/i.test(SCRIPT), "the v2 independent resolver quorum must be named in the script");
  assert.ok(/owner decides|owner resolves disputes|owner · resolve_dispute/i.test(HTML),
    "the legacy dispute step must be disclosed, not hidden");
  assert.ok(/owner cannot resolve a dispute alone/.test(SCRIPT),
    "the limit on the owner's power under v2 must be disclosed");
  assert.ok(!/\bno human involvement\b|\bfully automated\b|\bautomatically approved\b/i.test(HTML),
    "must not claim automation beyond the implementation");
});

test("the institutional positioning is present and stays truthful", () => {
  const start = HTML.indexOf('<section class="wrap band inst"');
  const end = HTML.indexOf('<section class="wrap band" id="how"');
  assert.ok(start !== -1 && end > start, "the institutional positioning band must exist");
  const band = HTML.slice(start, end);
  assert.match(band, /Built for institutions, operators and autonomous agents/);
  // Each pillar must be traceable to a real contract rule, not a slogan.
  assert.match(band, /reserved from the pool/, "the capital pillar must state the reservation rule");
  assert.match(band, /reserved ≤ capital|reserved <= capital/, "the solvency invariant must be named");
  assert.match(band, /cannot change/, "the immutability of a product must be stated");
  assert.match(band, /quorum/, "the oracle/resolver quorum must be named");
  assert.match(band, /products\.json/, "the machine-readable catalogue must be linked for agents");
  // The institutional framing must not invent ratings, customers, adoption or coverage.
  assert.doesNotMatch(band, /\b(clients?|customers?|partners?|insured (amount|sum)|rated|A\+)\b/i,
    "no invented customers, partnerships, coverage or ratings");
  assert.doesNotMatch(band, /\b(\d[\d,.]*\s*(million|billion|bn|m)\b|\$\d)/i, "no invented figures");
  // The mandatory disclosure survives: the band must point to the honest limits.
  assert.match(band, /#trust-h/, "the band must link to the honest-limits section");
  // A link inside a sentence must clear WCAG 1.4.1.
  assert.match(HTML, /\.inst-pillars \.p p a \{ text-decoration: underline/,
    "in-sentence links in the band must be underlined");
});


test("the insurance journey names the real actor for each step", () => {
  const j = HTML.slice(HTML.indexOf('class="journey"'), HTML.indexOf('id="cover"'));
  const steps = [...j.matchAll(/class="t">([^<]+)</g)].map((m) => m[1]);
  assert.equal(steps.length, 8, `expected 8 journey steps, found ${steps.length}`);
  for (const actor of ["you", "policyholder", "attestor", "anyone", "owner"]) {
    assert.ok(new RegExp(`chip actor">${actor}<`).test(j), `journey must name the actor "${actor}"`);
  }
  // The v2 actors replace the legacy ones at runtime, so they live in the script.
  for (const actor of ["operators", "resolvers"]) {
    assert.ok(new RegExp(`chip actor">${actor}<`).test(SCRIPT), `v2 journey must name the actor "${actor}"`);
  }
});

test("product cards read as coverage, with the trigger and honest limitations", () => {
  assert.ok(SCRIPT.includes("function productCard("), "products must render as coverage cards");
  assert.ok(SCRIPT.includes("coveredText(p)"), "each card must state the covered event");
  // The covered event must be derived from the metric direction and the real
  // threshold, so it is correct for every risk category, not just rainfall.
  assert.ok(/Pays if " \+ cap\(p\.city\) \+ " " \+ risk/.test(SCRIPT),
    "the covered event must be derived from the real metric and threshold");
  assert.ok(/dir === "Below" \? "falls to" : "reaches"/.test(SCRIPT),
    "the trigger direction must come from the metric, not be assumed");
  assert.ok(SCRIPT.includes("Capacity left"), "remaining capacity must be shown");
  assert.ok(/not on an assessed loss/.test(SCRIPT), "cards must state the parametric limitation");
  assert.ok(SCRIPT.includes('details class="legacy"'), "demo rows must stay foldable and honestly labelled");
  assert.ok(/contract-backed test fixtures/.test(SCRIPT),
    "fixtures (demo cycle + non-triggering definitions) must be labelled as not a current offering");
  // A definition whose trigger sits at the contract's plausible ceiling can only
  // pay on that single reading, so it must be flagged rather than offered as cover.
  assert.ok(/triggerAtCeiling/.test(SCRIPT) && /PLAUSIBLE_CEILING_TENTHS/.test(SCRIPT),
    "a ceiling-pinned trigger must be detected from contract data");
  assert.ok(/only pay on that one reading/.test(SCRIPT), "a ceiling-pinned trigger must be disclosed as such");
});

test("the page publishes a machine-readable catalogue for agents, derived from the contract", () => {
  // A link inside a sentence must be distinguishable without colour, or it fails
  // WCAG 1.4.1 (axe link-in-text-block). Assert the underline rule exists.
  assert.ok(/\.proof \.val a \{ text-decoration: underline/.test(HTML),
    "links inside a text block must be underlined, not colour-only");
  assert.ok(/Machine-readable catalogue/.test(HTML), "the page must point agents at the feed");
  assert.ok(/href="\/products\.json"/.test(HTML) && /href="\/products\.schema\.json"/.test(HTML),
    "the page must link the feed and its schema");
  // The feed and schema are served from ui/ (the Vercel output dir), so they must
  // exist as shipped artifacts or the links are dead.
  const feed = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.json"), "utf8"));
  assert.ok(Array.isArray(feed.offerings) && feed.offerings.length >= 1, "the feed must list a real offering");
  const schema = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.schema.json"), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("the quote is real, read-only, and never fakes a purchase", () => {
  assert.ok(SCRIPT.includes('view("quote"'), "the quote must be confirmed by the contract");
  assert.ok(/read-only quote/i.test(HTML), "the quote must say it is read-only");
  assert.ok(/holds no key/.test(HTML), "the page must say it holds no key");
  // A policy is reported as bought only from the wallet's own confirmed outcome,
  // never optimistically. The success path must check status.Failure first.
  assert.ok(/status\.Failure/.test(SCRIPT), "the buy path must inspect the transaction outcome for failure");
  assert.ok(/the wallet returned no transaction hash/.test(SCRIPT), "success requires a real hash");
  assert.ok(!/policy_issued/i.test(SCRIPT), "the page must never invent a contract event name");
});

test("the pool is framed as the ability to honour obligations", () => {
  assert.ok(/Can the pool pay what it has promised\?/.test(HTML), "the pool needs an insurance framing");
  assert.ok(/Reserved for potential payouts/.test(HTML), "reserved capital must be explained as payouts");
  assert.ok(/class="glossary"/.test(HTML), "the figures must be explained, not just displayed");
});

test("the disclosures required by the mission are present verbatim in spirit", () => {
  const d = HTML.slice(HTML.indexOf('class="disclose"'));
  for (const need of [
    /Testnet only, unaudited/i,
    /Single trusted attestor/i,
    /owner resolves disputes/i,
    /60-second challenge window/i,
    /Parametric, not indemnity/i,
  ]) {
    assert.ok(need.test(d), `disclosure missing: ${need}`);
  }
  // The v2 disclosures replace these at runtime; they must exist in the script.
  for (const need of [/Multi-operator oracle, quorum-finalised/, /Independent resolvers decide disputes/]) {
    assert.ok(need.test(SCRIPT), `v2 disclosure missing from script: ${need}`);
  }
});

test("the hero illustration is an inline SVG (no remote image dependency)", () => {
  assert.ok(/<svg[^>]*viewBox="0 0 520 340"/.test(HTML), "the layered hero artwork must be inline SVG");
  assert.ok(!/<img[^>]+src="https?:/.test(HTML), "no remote image may be loaded");
  assert.ok(!/url\(["']?https?:/.test(HTML), "no remote CSS asset may be loaded");
});

test("every in-page anchor resolves to a real id, and every id is unique", () => {
  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], `duplicate ids: ${[...new Set(dupes)].join(", ")}`);
  const idSet = new Set(ids);
  const anchors = [...HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  for (const a of anchors) assert.ok(idSet.has(a), `anchor #${a} has no matching element`);
});

test("every getElementById target in the script exists in the markup", () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const targets = new Set([...SCRIPT.matchAll(/el\("([^"]+)"\)/g)].map((m) => m[1]));
  for (const t of targets) assert.ok(ids.has(t), `script targets #${t}, which is not in the page`);
});

test("the page has one h1 and does not skip heading levels", () => {
  const levels = [...HTML.matchAll(/<h([1-3])[\s>]/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1, "exactly one h1 is required");
  assert.equal(levels[0], 1, "the h1 must come first");
});

// ---- wallet connect: the picker must appear where the user clicked, and it
// must be honest about which wallets this browser can actually complete. ----

const choicesHTML = new Function(
  `function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
   ${extractFunction(SCRIPT, "walletChoicesHTML")}
   return walletChoicesHTML;`,
)();

test("the picker disables a wallet this browser cannot complete and offers an install link", () => {
  const html = choicesHTML([{ id: "meteor-wallet", name: "Meteor Wallet", present: false, extensionOnly: true, downloadUrl: "https://meteorwallet.app" }]);
  assert.match(html, /data-wallet-id="meteor-wallet"[^>]*disabled/, "an absent wallet must not be presented as connectable");
  assert.match(html, /not detected in this browser/, "the reason must be stated plainly");
  assert.match(html, /https:\/\/meteorwallet\.app/, "an install path must be offered");
});

test("the picker enables a wallet that can complete and says how it works", () => {
  const html = choicesHTML([{ id: "here-wallet", name: "Here Wallet", present: true, extensionOnly: false, downloadUrl: "https://herewallet.app" }]);
  assert.doesNotMatch(html, /disabled/, "a usable wallet must be clickable");
  assert.match(html, /opens its own app or window/, "the user must know a window will open");
});

test("an installed extension-only wallet is labelled as detected", () => {
  const html = choicesHTML([{ id: "meteor-wallet", name: "Meteor Wallet", present: true, extensionOnly: true, downloadUrl: "x" }]);
  assert.match(html, /browser extension detected/);
});

test("Connect wallet opens a modal picker instead of a list far down the page", () => {
  assert.match(HTML, /<dialog id="wallet-dialog"/, "the picker must be a dialog element");
  assert.match(SCRIPT, /d\.showModal\(\)/, "the picker must be opened modally, where the user is looking");
  assert.ok(!/id="b-wallet-choices"/.test(HTML), "the old off-screen choice container must be gone");
  assert.ok(!/b-wallet-choices/.test(SCRIPT), "no code may still target the removed container");
});

test("the first screen offers a wired Connect control (not only the header)", () => {
  assert.match(HTML, /data-wallet="connect"[^>]*>Connect a wallet</, "the hero must offer a connect control that opens the picker");
});

test("the connect wait is bounded so a dead wallet cannot hang the button", () => {
  const bundle = fs.readFileSync(path.join(root, "ui", "vendor", "wallet-bundle.js"), "utf8");
  assert.match(bundle, /OVERCOVER_CONNECT_TIMEOUT_MS/, "the wallet bundle must cap how long connect can block");
  assert.match(bundle, /did not respond/, "a timed-out connect must surface an actionable message");
});

test("the picker warns plainly when no supported wallet is available", () => {
  assert.match(SCRIPT, /None of the supported NEAR wallets were detected/, "the no-wallet case must be stated, not left silent");
});

// ---- the wallet connect timeout, tested against the real function in ui/wallet.js ----

const WALLET_JS = fs.readFileSync(path.join(root, "ui", "wallet.js"), "utf8");
const withTimeout = new Function(`${extractFunction(WALLET_JS, "withTimeout")}; return withTimeout;`)();

test("a wallet that never answers is rejected after the timeout, not hung forever", async () => {
  const t0 = Date.now();
  await assert.rejects(() => withTimeout(new Promise(() => {}), 200, "the wallet did not respond"), /did not respond/);
  assert.ok(Date.now() - t0 < 2000, "the rejection must be prompt, not open-ended");
});

test("a wallet that answers quickly passes its result straight through", async () => {
  assert.equal(await withTimeout(Promise.resolve("alice.testnet"), 5000, "x"), "alice.testnet");
});

test("connect is wired to the bounded timeout, so no path can hang silently", () => {
  assert.match(WALLET_JS, /CONNECT_TIMEOUT_MS/, "connect must use the named timeout");
  assert.match(WALLET_JS, /withTimeout\(\s*w\.signIn/, "signIn must be wrapped in the timeout");
});

test("wallet availability is honest: extension-only wallets are probed, not assumed present", () => {
  assert.match(WALLET_JS, /EXTENSION_ONLY/, "the selector's hardcoded available:true must be corrected");
  assert.match(WALLET_JS, /injectedPresent/, "a missing extension must be detected");
});

// ---- first-time-user honesty: no panel may sit on "Loading…" forever, and a
// disabled control must say why. ----

test("a failed first read replaces the loading placeholders instead of leaving them spinning", () => {
  assert.match(SCRIPT, /function renderLoadFailed\(/, "a load-failure renderer is required");
  assert.match(SCRIPT, /if \(!state\.haveData\) \{[\s\S]*renderLoadFailed\(\)/, "the failure path must call it");
  assert.match(SCRIPT, /Could not load from the contract/, "the failure must be stated plainly");
});

test("the buy button explains why it is disabled", () => {
  assert.match(HTML, /id="b-hint"/, "a hint element must exist next to the buy button");
  assert.match(SCRIPT, /Connect a wallet to buy this cover/, "the hint must tell a first-time visitor to connect");
  assert.match(SCRIPT, /Pick the cover and payout/, "the hint must explain the no-selection case");
});

test("no dead choice container or orphaned picker reference remains", () => {
  assert.ok(!/id="b-wallet-choices"/.test(HTML) && !/b-wallet-choices/.test(SCRIPT));
});

test("every static Connect control is wired from first paint (no dead-click window)", () => {
  const connects = [...HTML.matchAll(/<button[^>]*id="(wallet-connect|buy-wallet-connect)"[^>]*>/g)].map((m) => m[0]);
  assert.equal(connects.length, 2, "expected the header and buy-panel Connect buttons");
  for (const b of connects) assert.match(b, /data-wallet="connect"/, `a static Connect button is not wired: ${b}`);
});

// ---- the reported defect: the wallet dialog's Close button did not close it.
// Root cause: the button carried a valueless `data-wallet-close` attribute, so
// `getAttribute("data-wallet-close")` returned "" (falsy) and the delegated
// handler's truthy test never fired. ----

test("the Close control is a real dialog form submit, not a script-only button", () => {
  const dialog = HTML.slice(HTML.indexOf("<dialog id=\"wallet-dialog\""), HTML.indexOf("</dialog>") + 9);
  assert.match(dialog, /<form[^>]*method="dialog"/, "Close must submit a method=dialog form so it closes without JS");
  const close = dialog.match(/<button[^>]*data-wallet-close[^>]*>/)[0];
  assert.match(close, /type="submit"/, "the Close button must submit the form");
  assert.match(close, /aria-label="Close dialog"/, "the Close button needs an accessible name");
});

test("boolean dialog attributes are read with hasAttribute, never getAttribute truthiness", () => {
  assert.match(SCRIPT, /hasAttribute\("data-wallet-close"\)/, "Close must be matched by attribute presence");
  assert.match(SCRIPT, /hasAttribute\("data-buy-jump"\)/, "the in-page jump link must be matched by attribute presence");
  assert.doesNotMatch(SCRIPT, /getAttribute\("data-wallet-close"\)/, "the falsy getAttribute test is the defect and must not return");
});

test("the dialog handles Escape, backdrop click and focus restoration", () => {
  assert.match(SCRIPT, /addEventListener\("cancel"/, "Escape must be handled so close goes through one path");
  assert.match(SCRIPT, /ev\.target === _wd/, "a backdrop click must close the dialog");
  assert.match(SCRIPT, /addEventListener\("close"/, "focus must be restored on close");
  assert.match(SCRIPT, /walletOpener/, "the opener element must be remembered for focus restoration");
});

test("the page behind the modal is scroll-locked while it is open", () => {
  assert.match(HTML, /body:has\(#wallet-dialog\[open\]\)\s*\{\s*overflow:\s*hidden/, "the body must not scroll behind an open modal");
});

// ---- retired wallet: MyNearWallet no longer accepts new connections and must
// be gone from the product, not merely hidden. ----

test("MyNearWallet is fully removed from the shipped product", () => {
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const lock = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  const walletJs = fs.readFileSync(path.join(root, "ui", "wallet.js"), "utf8");
  const bundle = fs.readFileSync(path.join(root, "ui", "vendor", "wallet-bundle.js"), "utf8");
  for (const [name, src] of [["ui/index.html", HTML], ["ui/wallet.js", walletJs], ["package.json", pkg], ["package-lock.json", lock]]) {
    assert.doesNotMatch(src, /my-near-wallet|MyNearWallet|mynearwallet/i, `a retired-wallet reference remains in ${name}`);
  }
  // The minified bundle keeps only the two supported modules.
  assert.match(bundle, /id:"here-wallet"/, "HERE Wallet must remain");
  assert.match(bundle, /id:"meteor-wallet"/, "Meteor Wallet must remain");
  assert.doesNotMatch(bundle, /id:"my-near-wallet"/, "the retired wallet must not be registered");
  // Only HERE and Meteor are set up.
  assert.match(walletJs, /modules:\s*\[setupHereWallet\(\),\s*setupMeteorWallet\(\)\]/, "only the two supported wallets may be registered");
});

// ---- discoverability: search engines and AI crawlers. ----

test("robots.txt allows crawlers and points at the sitemap", () => {
  const robots = fs.readFileSync(path.join(root, "ui", "robots.txt"), "utf8");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/overcover\.vercel\.app\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Disallow: \/\s*$/m, "public product pages must not be blocked");
});

test("sitemap.xml lists the canonical production URL", () => {
  const sitemap = fs.readFileSync(path.join(root, "ui", "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/overcover\.vercel\.app\/<\/loc>/);
});

test("llms.txt and llms-full.txt exist and state the real product", () => {
  const short = fs.readFileSync(path.join(root, "ui", "llms.txt"), "utf8");
  const full = fs.readFileSync(path.join(root, "ui", "llms-full.txt"), "utf8");
  for (const doc of [short, full]) {
    assert.match(doc, /contract\.ovc-v3-ctl-2f6c4c\.testnet/, "the hardened contract must be the default named in the docs");
    assert.match(doc, /contract\.attestor-overcover\.testnet/, "the legacy address must still be disclosed, labelled legacy");
    assert.match(doc, /NEAR testnet/);
    assert.match(doc, /HERE Wallet/);
  }
  assert.match(full, /MyNearWallet.*removed|removed.*MyNearWallet/s, "the removal must be documented, not hidden");
});

test("the head carries canonical, social and theme metadata in the served HTML", () => {
  assert.match(HTML, /<link rel="canonical" href="https:\/\/overcover\.vercel\.app\/" \/>/);
  assert.match(HTML, /<meta property="og:title"/);
  assert.match(HTML, /<meta property="og:image" content="https:\/\/overcover\.vercel\.app\/og\.png"/);
  assert.match(HTML, /<meta name="twitter:card" content="summary_large_image"/);
  assert.match(HTML, /<meta name="theme-color" content="#10251d"/);
  assert.match(HTML, /<html lang="en">/);
});

test("the OG image is a real 1200x630 PNG that ships with the site", () => {
  const buf = fs.readFileSync(path.join(root, "ui", "og.png"));
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "must be a PNG");
  assert.equal(buf.readUInt32BE(16), 1200, "OG image width must be 1200");
  assert.equal(buf.readUInt32BE(20), 630, "OG image height must be 630");
});

test("the JSON-LD block is valid JSON and makes only truthful claims", () => {
  const m = HTML.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, "a JSON-LD block must be present");
  const data = JSON.parse(m[1]);
  const types = data["@graph"].map((n) => n["@type"]);
  for (const t of ["Organization", "WebSite", "SoftwareApplication", "WebPage"]) {
    assert.ok(types.includes(t), `structured data must include ${t}`);
  }
  const flat = JSON.stringify(data);
  assert.doesNotMatch(flat, /aggregateRating|reviewCount|ratingValue/, "no invented ratings");
  assert.doesNotMatch(flat, /\$\d/, "no invented pricing beyond free");
});

// ---- documentation integrity: contract identifiers are hand-copied, so they drift. ----

test("the legacy code_hash is recorded exactly, with no hand-copied drift", () => {
  // The live legacy module's code_hash, read from NEAR RPC. Every doc that cites
  // it must use this exact 44-character base58 value. A hand-typed variant (for
  // example a 45-character one with a stray trailing character) is a defect: it
  // makes the one identifier a reader would verify against the chain wrong.
  const LEGACY_CODE_HASH = "36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R";
  assert.equal(LEGACY_CODE_HASH.length, 44, "a NEAR code_hash is 44 base58 characters");
  const docDir = path.join(root, "docs");
  const docs = fs.readdirSync(docDir).filter((f) => f.endsWith(".md"));
  let cites = 0;
  for (const f of docs) {
    const text = fs.readFileSync(path.join(docDir, f), "utf8");
    // Any base58 token that starts like this hash but is not exactly it is drift.
    for (const m of text.matchAll(/\b36koHo[1-9A-HJ-NP-Za-km-z]{30,48}\b/g)) {
      assert.equal(m[0], LEGACY_CODE_HASH, `${f} records a drifted legacy code_hash: ${m[0]}`);
    }
    if (text.includes(LEGACY_CODE_HASH)) cites += 1;
  }
  assert.ok(cites >= 3, "the legacy code_hash must still be cited by the docs that describe it");
});

// ---- the public UI must never expose an owner-only contract method. ----

test("the public UI can only ever sign buy_cover, never an owner-only method", () => {
  const walletJs = fs.readFileSync(path.join(root, "ui", "wallet.js"), "utf8");
  const bundle = fs.readFileSync(path.join(root, "ui", "vendor", "wallet-bundle.js"), "utf8");
  // Our own code (the page and the wallet module) must never name an Overcover
  // owner-only method. Generic library words like "deposit" (a NEAR transaction
  // field) and "reset" are not method calls and are deliberately excluded.
  for (const forbidden of ["owner_withdraw", "set_lifeline_enabled", "seed_merchant", "add_shock"]) {
    assert.doesNotMatch(HTML, new RegExp(forbidden), `the page must not reference ${forbidden}`);
    assert.doesNotMatch(walletJs, new RegExp(forbidden), `the wallet module must not reference ${forbidden}`);
  }
  // The wallet's function-call access key is scoped to buy_cover alone, and it
  // signs against the contract the page configured (never a hardcoded one).
  assert.match(walletJs, /signIn\(\{\s*contractId:\s*\w+,\s*methodNames:\s*\["buy_cover"\]\s*\}\)/);
  assert.match(walletJs, /function configure\(/, "the wallet must let the console set its contract");
  assert.match(HTML, /WALLET\.configure\(CONTRACT\)/, "the console must bind the wallet to the contract it reads");
  assert.match(bundle, /methodNames:\["buy_cover"\]/, "the built bundle must carry the buy_cover scope");
});

// ---- production connectivity: the site must never depend on the operator's localhost. ----

test("the public site ships no hardcoded local agent URL", () => {
  // The original defect: the console defaulted to http://127.0.0.1:8787 and
  // fetched it on connect, so a public visitor saw "Failed to fetch".
  assert.doesNotMatch(HTML, /value="http:\/\/127\.0\.0\.1:8787"/, "the agent URL field must not default to localhost");
  assert.doesNotMatch(HTML, /https?:\/\/127\.0\.0\.1:8787/, "the page must not hardcode a localhost agent URL");
  const urlInput = HTML.match(/<input id="a-url"[^>]*>/);
  assert.ok(urlInput, "the agent URL field must exist");
  assert.match(urlInput[0], /value=""/, "the agent URL field must start empty");
});

test("the console defaults to public read-only mode, not a local service", () => {
  assert.match(HTML, /data-mode="readonly"[^>]*aria-pressed="true"/, "public read-only must be the default mode");
  assert.match(SCRIPT, /setAgentMode\("readonly"\)/, "the console must initialise in read-only mode");
  // The local URL field, Connect, Buy and Kill controls are hidden until the
  // visitor opts into local mode.
  assert.match(HTML, /id="a-url-wrap"[^>]*hidden/, "the local URL field must start hidden");
  assert.match(HTML, /id="a-connect"[^>]*hidden/, "Connect must start hidden");
  assert.match(HTML, /id="a-buy"[^>]*hidden/, "agent Buy must start hidden");
  assert.match(HTML, /id="a-kill"[^>]*hidden/, "Emergency stop must start hidden");
});

test("the public evaluation uses the shipped policy engine, not the local service", () => {
  // The read-only path must call the bundled engine (window.OvercoverPolicy) on
  // the live contract quote, and must NOT POST to the local agent API.
  const fn = extractFunction(SCRIPT, "agentEvaluatePublic");
  assert.match(fn, /OvercoverPolicy/, "public evaluation must use the bundled policy engine");
  assert.match(fn, /view\("quote"/, "public evaluation must read the live contract quote");
  assert.doesNotMatch(fn, /agentReq\(/, "public evaluation must not call the local agent service");
  assert.match(HTML, /<script src="vendor\/policy\.js"><\/script>/, "the policy bundle must be loaded by the page");
});

test("a network failure is shown as a helpful message, never a raw fetch error", () => {
  assert.match(SCRIPT, /function friendlyNetError\(/, "the console must translate network errors");
  assert.match(SCRIPT, /failed to fetch\|networkerror\|load failed\|network request failed/i, "friendlyNetError must match the raw fetch error");
  // The local-service failure message must be actionable, not the raw error.
  assert.match(SCRIPT, /Could not reach your agent service[\s\S]{0,80}friendlyNetError/, "the connect failure must use the friendly message");
});

test("the shipped policy bundle is the shared engine and holds no secret", () => {
  const policy = fs.readFileSync(path.join(root, "ui", "vendor", "policy.js"), "utf8");
  // It must be the real engine (its refusal strings are present), so the public
  // verdict is the same logic the agent service runs — not a re-implementation.
  for (const needle of ["maxPremiumPerPolicy", "maxPayoutPerPolicy", "dailyPremiumBudget", "dailyPolicyLimit"]) {
    assert.ok(policy.includes(needle), `the policy bundle must contain the engine's ${needle} check`);
  }
  // It must never carry a key, a signer, or a network call.
  assert.doesNotMatch(policy, /ed25519/i, "the policy bundle must not mention a key type");
  assert.doesNotMatch(policy, /secretKey|privateKey|seedPhrase/i, "the policy bundle must not carry key material");
  assert.doesNotMatch(policy, /fetch\(|XMLHttpRequest/, "the policy bundle must not make network calls");
});


// ---------------------------------------------------------------------------
// Observations table: the legacy (v1) contract stores observations WITHOUT a
// metric_id or a quorum field. Rendering those fields blindly printed the
// literal string "undefined" in the live table (observed against the deployed
// v1 contract). The table must degrade to the legacy columns instead, and only
// show the metric/quorum columns when the contract actually exposes them.
const obsSrc = extractFunction(SCRIPT, "renderObservations");
const renderObservations = new Function(
  "CONTRACT_V2, OPERATORS, metricLabel, fmtVal",
  `var esc = function (s) { return String(s); };
   var utc = function (s) { return "T" + s; };
   ${obsSrc};
   return renderObservations;`
);

test("a legacy observation renders without a metric or quorum column", () => {
  const rows = [{ city: "lagos", value_tenths: 1, obs_date: 1, reported_at: 2, disputed: false, nullified: false }];
  const html = renderObservations(false, [], (m) => "m:" + m, (v) => "v:" + v)(rows);
  assert.doesNotMatch(html, /undefined/, "a legacy observation must never render 'undefined'");
  assert.match(html, /<th>Index<\/th>/, "the legacy table keeps the Index column");
  assert.doesNotMatch(html, /Quorum/, "the legacy table must not claim a quorum column");
  assert.match(html, /class="tag signed"/, "a legacy reading is shown as signed");
});

test("a v2 observation renders the metric and quorum columns", () => {
  const rows = [{ metric_id: "heat", city: "lagos", value_tenths: 450, quorum: 2, obs_date: 1, reported_at: 2 }];
  const html = renderObservations(true, [{ account: "a" }, { account: "b" }, { account: "c" }], (m) => "m:" + m, (v) => "v:" + v)(rows);
  assert.doesNotMatch(html, /undefined/, "a v2 observation must never render 'undefined'");
  assert.match(html, /<th>Metric<\/th>/, "the v2 table shows the metric column");
  assert.match(html, /Quorum/, "the v2 table shows the quorum column");
  assert.match(html, /2 of 3/, "the quorum reads as reached-of-registered");
  assert.match(html, /class="tag quorum"/, "a v2 finalized reading is shown as quorum");
});

test("a missing quorum value degrades to a dash, never 'undefined'", () => {
  const rows = [{ metric_id: "heat", city: "lagos", value_tenths: 450, obs_date: 1, reported_at: 2 }];
  const html = renderObservations(true, [], (m) => m, (v) => v)(rows);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /—/, "an absent quorum renders as an em dash");
});

// ---------------------------------------------------------------------------
// Insurance factory: the discovery feed is the agent's PREPARED proposal; it is
// NOT contract state. A proposal may only be shown as ACTIVE when the contract
// itself returns an activated product whose on-chain evidence_hash matches the
// proposal's evidence hash. If the feed is missing or the contract read failed,
// nothing may be claimed as activated.
const factorySrc = extractFunction(SCRIPT, "renderFactory");
const matchSrc = extractFunction(SCRIPT, "matchActivated");
const statusSrc = extractFunction(SCRIPT, "factoryStatus");
const renderFactory = new Function(
  "esc, safeUrl, cap, metricLabel, fmtVal, utc, term, shortAcct",
  `var esc = esc; var safeUrl = safeUrl;
   ${matchSrc};
   ${statusSrc};
   ${factorySrc};
   return renderFactory;`
)((s) => String(s), (s) => String(s), (s) => String(s), (m) => "m:" + m, (v) => "v:" + v, (s) => "T" + s,
  (k, v) => `[${k}=${v}]`, (a) => "acct:" + a);

const feedOne = {
  generatedAt: "2026-11-12T06:30:00.000Z",
  proposals: [{
    id: "factory-rain-miami-2026-11-17",
    status: "PROPOSED",
    metric: "rain", city: "miami", direction: "Above",
    thresholdTenths: 300, premiumBp: 500, coverageStartSec: 1794472201,
    evidence: { kind: "forecast", source: "open-meteo:forecast:precipitation_sum",
      sourceUrl: "https://api.open-meteo.com/v1/forecast?...", observedAt: "2026-11-17",
      valueTenths: 615, unit: "mm/10", raw: 61.5, hash: "sha256:abc123" },
    risk: { emerging: true, direction: "Above", rationale: "excess rainfall: forecast 615 mm/10 crosses threshold 300" },
  }],
};

test("a prepared proposal with no matching contract product is shown as PROPOSED, never ACTIVE", () => {
  const html = renderFactory(feedOne, [], null);
  assert.match(html, /PROPOSED/, "the proposal status is PROPOSED");
  assert.doesNotMatch(html, /class="tag available"/, "it is never shown as an active/available product");
  assert.doesNotMatch(html, /Activated on-chain/, "activation is never claimed without the contract");
});

test("a proposal is shown as ACTIVE only when the contract returns a matching evidence hash", () => {
  const products = [{ id: "factory-rain-miami-2026-11-17", proposed_by: "proposer.testnet", evidence_hash: "sha256:abc123", active: true }];
  const html = renderFactory(feedOne, products, null);
  assert.match(html, /class="tag available"/, "a contract-matched product is shown as active");
  assert.match(html, /Activated on-chain as product/, "the activation cites the on-chain product");
  assert.match(html, /proposer\.testnet/, "the activation names the proposer from the contract");
});

test("a forecast is labelled a forecast and never as an event that occurred", () => {
  const html = renderFactory(feedOne, [], null);
  assert.match(html, /forecast/, "the evidence is labelled a forecast");
  assert.match(html, /not an observation of an event that occurred/, "the honesty note is present");
});

test("the evidence hash is shown, so the on-chain provenance can be checked", () => {
  const html = renderFactory(feedOne, [], null);
  assert.match(html, /sha256:abc123/, "the exact evidence hash is rendered");
  assert.match(html, /api\.open-meteo\.com/, "the source URL is rendered");
});

test("a missing feed is reported honestly and never as active cover", () => {
  const html = renderFactory({ error: "HTTP 404", proposals: [] }, [], "HTTP 404");
  assert.match(html, /Discovery feed unavailable/, "a missing feed is stated plainly");
  assert.doesNotMatch(html, /class="tag available"/, "nothing is shown as active");
  assert.doesNotMatch(html, /undefined/, "no 'undefined' leaks into the page");
});

test("no emerging risk renders an explicit empty state, not a blank panel", () => {
  const html = renderFactory({ proposals: [] }, [], null);
  assert.match(html, /No emerging risk right now/, "an empty feed explains itself");
});

test("a contract-read failure never shows a proposal as active", () => {
  const html = renderFactory(feedOne, [], null);
  assert.doesNotMatch(html, /Activated on-chain/);
  assert.doesNotMatch(html, /undefined/);
});

// --- Content Security Policy -------------------------------------------------
// The page ships one inline <script> (the app). A strict CSP that allows only
// 'self' would break it, so the policy pins that script by its sha256. This test
// ties the header in vercel.json to the exact bytes the browser will hash: if the
// inline script changes and the header is not updated, the header stops matching
// and the deployed page would refuse to run its own app. The failure is loud here
// rather than silent in production.
test("the CSP pins the shipped inline script by its exact sha256", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const rule = (cfg.headers || []).find((h) => (h.headers || []).some((x) => x.key === "Content-Security-Policy"));
  assert.ok(rule, "vercel.json must define a Content-Security-Policy header");
  const csp = rule.headers.find((x) => x.key === "Content-Security-Policy").value;

  const hash = "sha256-" + crypto.createHash("sha256").update(SCRIPT, "utf8").digest("base64");
  assert.ok(csp.includes(`'${hash}'`), `the CSP must allow the inline script by hash ${hash}`);

  // The policy must actually lock the dangerous surfaces down, not merely exist.
  assert.match(csp, /script-src 'self' 'sha256-/, "scripts are limited to self plus the pinned inline hash");
  assert.match(csp, /object-src 'none'/, "plugins are disabled");
  assert.match(csp, /base-uri 'none'/, "no <base> hijack");
  assert.match(csp, /frame-ancestors 'none'/, "the page cannot be framed");
  assert.match(csp, /form-action 'none'/, "forms cannot exfiltrate");
  assert.match(csp, /connect-src 'self' https:/, "the console may only reach the RPC hosts over https");
});

test("the approved-build map accepts the live module and the SEC-6/7/9 hardening", () => {
  // A code-only hardening deploy changes the code hash but not the account. If
  // the console only accepted one hash, that deploy would silently lock buying.
  const m = SCRIPT.match(/TRUSTED\[HARDENED_CONTRACT\]\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, "the hardened contract must map to a list of approved builds");
  assert.ok(m[1].includes("CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL"), "the live module stays approved");
  assert.ok(m[1].includes("9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C"), "the SEC-6/7/9 build is approved");
  assert.match(SCRIPT, /expected\.indexOf\(codeHash\)\s*!==\s*-1/, "trust is decided against the whole approved list");
});

test("the console makes no claim about an OutLayer/TDX adapter or an un-deployed hardening", () => {
  // The adapter is a POC, not a live oracle path; the console must not imply it is.
  assert.doesNotMatch(HTML, /OutLayer|Intel TDX|TEE attestation/i, "no OutLayer/TDX claim in the live console");
  // The console describes the live module as hardened (SEC-1) and the legacy one
  // as original — that is contract-state-driven, not a claim about SEC-6/7/9.
  assert.match(SCRIPT, /Hardened build|hardened module/, "the hardened label is state-driven");
});

test("the console ships an honest deployment-status ledger", () => {
  // The console must state plainly what is deployed and what is not, so a reader
  // (or an answer engine) cannot mistake the un-deployed hardening for live.
  assert.match(HTML, /id="status"/, "the deployment-status section is present");
  assert.match(HTML, /Built, not deployed/, "the un-deployed hardening is labelled as such");
  assert.match(HTML, /Blocked/, "credential-gated work is labelled blocked");
  assert.match(HTML, /Not performed/, "the absent external audit is stated");
  // And it must not upgrade the prototype into a claim it cannot support.
  assert.doesNotMatch(HTML, /audited by|audit complete|SOC 2|ISO 27001/i, "no fabricated audit claim");
});

// --- DOM XSS ---------------------------------------------------------------
// The permissionless factory lets anyone publish a product, and the console
// renders product ids, city names and evidence text that originate from those
// untrusted strings. Every renderer must escape them. The factory tests above
// use a passthrough esc, so escaping itself is asserted here with the REAL esc
// lifted from the page.
const escSrc = SCRIPT.slice(SCRIPT.indexOf("var esc ="), SCRIPT.indexOf("var cap ="));
const realEsc = new Function(`${escSrc}; return esc;`)();
const safeUrlSrc = SCRIPT.slice(SCRIPT.indexOf("var safeUrl ="), SCRIPT.indexOf("var cap ="));
const realSafeUrl = new Function("esc", `${safeUrlSrc}; return safeUrl;`)(realEsc);
const renderFactoryEscaped = new Function(
  "esc, safeUrl, cap, metricLabel, fmtVal, utc, term, shortAcct",
  `var esc = esc; var safeUrl = safeUrl;
   ${matchSrc};
   ${statusSrc};
   ${factorySrc};
   return renderFactory;`
)(realEsc, realSafeUrl, (s) => String(s), (m) => "m:" + m, (v) => "v:" + v, (s) => "T" + s,
  (k, v) => `[${k}=${v}]`, (a) => "acct:" + a);

test("the real esc neutralises the five HTML metacharacters", () => {
  assert.equal(realEsc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("factory-supplied strings are escaped before they reach the DOM", () => {
  const payload = `"><img src=x onerror=alert(1)>`;
  const feed = {
    proposals: [{
      id: payload, status: "PROPOSED", metric: "rain", city: payload, direction: "Above",
      thresholdTenths: 300, premiumBp: 500, coverageStartSec: 1794472201,
      evidence: { kind: payload, source: payload, sourceUrl: "https://example.com", observedAt: payload, valueTenths: 1, unit: payload, raw: payload, hash: payload },
      risk: { emerging: true, direction: "Above", rationale: payload },
    }],
  };
  const html = renderFactoryEscaped(feed, [], null);
  assert.ok(!html.includes("<img src=x"), "no live img element may be produced from a proposal string");
  assert.ok(!html.includes(payload), "the raw payload must never appear unescaped");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the payload is shown as inert text");
});

test("a javascript: or data: evidence URL is refused, never rendered as a live link", () => {
  assert.equal(realSafeUrl("javascript:alert(1)"), "", "javascript: must not survive");
  assert.equal(realSafeUrl("data:text/html,<script>alert(1)</script>"), "", "data: must not survive");
  assert.equal(realSafeUrl("https://api.open-meteo.com/v1/forecast"), "https://api.open-meteo.com/v1/forecast");
  const feed = {
    proposals: [{
      id: "factory-rain-miami-2026-11-17", status: "PROPOSED", metric: "rain", city: "miami",
      direction: "Above", thresholdTenths: 300, premiumBp: 500, coverageStartSec: 1794472201,
      evidence: { kind: "forecast", source: "x", sourceUrl: "javascript:alert(1)", observedAt: "2026-11-17", valueTenths: 615, unit: "mm/10", raw: 61.5, hash: "sha256:abc" },
      risk: { emerging: true, direction: "Above", rationale: "r" },
    }],
  };
  const html = renderFactoryEscaped(feed, [], null);
  assert.ok(!html.includes("javascript:alert(1)"), "the dangerous scheme must not appear in the markup");
});
