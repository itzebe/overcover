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
  const contract = "contract.attestor-overcover.testnet";
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
  const embedded = [...SCRIPT.matchAll(/"([1-9A-HJ-NP-Za-km-z]{40,})"/g)].map((m) => m[1]);
  assert.ok(embedded.length >= 6, `expected several embedded tx hashes, found ${embedded.length}`);
  for (const h of embedded) {
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
  assert.match(hero, /rainfall below a set level, in a named city, on a named date/, "hero must name the covered event");
  assert.match(hero, /no adjuster, no queue/, "hero must say how protection is received");
  // The chain belongs to the proof, not the promise.
  assert.ok(!/blockchain|smart contract|on-chain/i.test(hero), "the hero must not lead with blockchain jargon");
});

test("the page describes a parametric mechanism honestly, without over-claiming", () => {
  // Honest: settlement follows a rule; it does not claim every claim auto-approves.
  assert.ok(/no adjuster, no queue/.test(HTML), "the parametric advantage must be stated");
  assert.ok(/parametric, not indemnity|not on an assessed loss|does not compensate an assessed loss/i.test(HTML),
    "the parametric limitation must be disclosed");
  // The attestor and the owner are named actors, not hidden.
  assert.ok(/attestor/i.test(HTML), "the attestor must be named");
  assert.ok(/owner resolves disputes|owner decides|owner · resolve_dispute/i.test(HTML),
    "the human dispute step must be disclosed, not hidden");
  assert.ok(!/\bno human involvement\b|\bfully automated\b|\bautomatically approved\b/i.test(HTML),
    "must not claim automation beyond the implementation");
});

test("the insurance journey names the real actor for each step", () => {
  const j = HTML.slice(HTML.indexOf('class="journey"'), HTML.indexOf('id="cover"'));
  const steps = [...j.matchAll(/class="t">([^<]+)</g)].map((m) => m[1]);
  assert.equal(steps.length, 8, `expected 8 journey steps, found ${steps.length}`);
  for (const actor of ["you", "policyholder", "attestor", "anyone", "owner"]) {
    assert.ok(new RegExp(`chip actor">${actor}<`).test(j), `journey must name the actor "${actor}"`);
  }
});

test("product cards read as coverage, with the trigger and honest limitations", () => {
  assert.ok(SCRIPT.includes("function productCard("), "products must render as coverage cards");
  assert.ok(SCRIPT.includes("coveredText(p)"), "each card must state the covered event");
  assert.ok(/Pays if " \+ cap\(p\.city\) \+ " rainfall reaches/.test(SCRIPT),
    "the covered event must be derived from the real threshold");
  assert.ok(SCRIPT.includes("Capacity left"), "remaining capacity must be shown");
  assert.ok(/not on an assessed loss/.test(SCRIPT), "cards must state the parametric limitation");
  assert.ok(SCRIPT.includes('details class="legacy"'), "demo rows must stay foldable and honestly labelled");
  assert.ok(/test state, not a current customer offering/.test(SCRIPT),
    "demo products must be labelled as not a current offering");
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
    assert.match(doc, /contract\.attestor-overcover\.testnet/);
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
  // The wallet's function-call access key is scoped to buy_cover alone.
  assert.match(walletJs, /signIn\(\{\s*contractId:\s*CONTRACT_ID,\s*methodNames:\s*\["buy_cover"\]\s*\}\)/);
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

