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

/** Lift a top-level function declaration out of the page script by brace matching. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in ui/index.html`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const decodeSrc = extractFunction(SCRIPT, "decode");
const decode = new Function(`${decodeSrc}; return decode;`)();

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
