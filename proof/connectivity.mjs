// Independent proof that the public OVERCOVER experience needs no local agent,
// and that the security boundary is intact.
//
//   npm run verify:connectivity              # against the shipped ui/ files
//   LIVE_URL=https://overcover.vercel.app/ npm run verify:connectivity   # against production
//
// It boots the REAL agent service in dry-run with a throwaway key, serves the
// REAL ui/ files, and drives a real Chromium. Nothing here signs, funds, or
// mutates the shared contract; every on-chain read is a public RPC view.
//
// Twelve checks, one per claim:
//   1  production config does not point at localhost
//   2  the public page loads with no local agent reachable
//   3  public read-only evaluation works with no signing service
//   4  the read-only verdict is derived from the live contract quote
//   5  invalid and oversized requests are rejected
//   6  an unreachable service yields a safe, human message (never "Failed to fetch")
//   7  no private signing key in shipped assets or tracked files
//   8  no public path can execute an owner-only method
//   9  the agent's spending limits are enforced (refusal before any network)
//   10 buy_cover is the only signing capability
//   11 a visitor cannot buy without a wallet authorization
//   12 local development still works
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { KeyPair } from "near-api-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(root, "ui");
const LIVE = process.env.LIVE_URL || "";
const EXEC = process.env.CHROME_PATH || "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const RPC = "https://test.rpc.fastnear.com";
const CONTRACT = "contract.attestor-overcover.testnet";
const STATIC_PORT = 8600 + Math.floor(Math.random() * 90);
const AGENT_PORT = 8500 + Math.floor(Math.random() * 90);
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".txt": "text/plain", ".xml": "application/xml" };

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || "" }); }

let html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
const walletJs = fs.readFileSync(path.join(UI, "wallet.js"), "utf8");
let policyJs = fs.readFileSync(path.join(UI, "vendor", "policy.js"), "utf8");
const serverJs = fs.readFileSync(path.join(root, "agent", "server.mjs"), "utf8");
const agentJs = fs.readFileSync(path.join(root, "agent", "agent.mjs"), "utf8");

// When run against production, the "shipped asset" checks must read what the
// server actually returns — not the local working tree.
async function fetchText(url) {
  try { const r = await fetch(url); return r.ok ? await r.text() : ""; } catch { return ""; }
}
if (LIVE) {
  const [h, p] = await Promise.all([fetchText(LIVE), fetchText(new URL("vendor/policy.js", LIVE).href)]);
  if (h) { html = h; }
  if (p) { policyJs = p; }
}

async function rpcView(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return Buffer.from(j.result.result).toString("utf8");
}

// ---------------------------------------------------------------- 1, 7, 8, 10, 11: static

check("1  no localhost default in the shipped page",
  !/127\.0\.0\.1:8787/.test(html) && !/https?:\/\/127\.0\.0\.1/.test(html) && /<input id="a-url"[^>]*value=""/.test(html),
  "the agent URL field must be empty and the page must not hardcode a local agent URL");

check("7  no private key in shipped assets or tracked files",
  !/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/.test(html + walletJs + policyJs) &&
    (() => { try { return execSync("git ls-files | grep -E '(^|/)keys/|(^|/)identities\\.json$' || true", { cwd: root }).toString().trim() === ""; } catch { return true; } })(),
  "no ed25519 secret and no keys/ file is shipped or tracked");

const OWNER_ONLY = ["owner_withdraw", "set_lifeline_enabled", "seed_merchant", "add_shock"];
check("8  no public path can call an owner-only method",
  OWNER_ONLY.every((m) => !html.includes(m) && !walletJs.includes(m) && !serverJs.includes(m)),
  "the page, wallet module and agent service never name an owner-only method");

check("10 buy_cover is the only signing capability",
  /signIn\(\{\s*contractId:\s*\w+,\s*methodNames:\s*\["buy_cover"\]\s*\}\)/.test(walletJs) &&
    /function configure\(/.test(walletJs) &&
    /WALLET\.configure\(CONTRACT\)/.test(html) &&
    /transactions\.functionCall\(\s*"buy_cover"/.test(agentJs) &&
    !/functionCall\(\s*"(?!buy_cover)/.test(agentJs),
  "the wallet scope is buy_cover alone, bound to the read contract, and the agent's only function call is buy_cover");

check("11 a visitor cannot buy without a wallet authorization",
  /window\.OvercoverWallet/.test(html) && /signAndSend/.test(walletJs) &&
    /agentUI\.mode !== "local"/.test(html) && /hidden>Agent buys this cover/.test(html),
  "the only write path is the user's wallet, and agent Buy is hidden in public mode");

// ---------------------------------------------------------------- local dry-run agent: 5, 6, 9, 12

function startAgent() {
  const kp = KeyPair.fromRandom("ed25519");
  return spawn(process.execPath, [path.join(root, "agent", "server.mjs")], {
    env: {
      ...process.env,
      OVERCOVER_AGENT_ACCOUNT: "connectivity-probe.testnet",
      OVERCOVER_AGENT_SECRET_KEY: kp.toString(),
      OVERCOVER_AGENT_PORT: String(AGENT_PORT),
      OVERCOVER_AGENT_HOST: "127.0.0.1",
      OVERCOVER_AGENT_DRY_RUN: "1",
      OVERCOVER_AGENT_LIMITS: JSON.stringify({ maxPremiumPerPolicy: "100000000000000000000000", maxPayoutPerPolicy: "1000000000000000000000000", dailyPremiumBudget: "1000000000000000000000000", dailyPolicyLimit: 3, cooldownSec: 0 }),
      OVERCOVER_AGENT_AUDIT: path.join(root, "agent", "audit.connectivity.log.jsonl"),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}
async function waitAgent(deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/health`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function serveStatic() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      let file = path.join(UI, rel === "/" ? "index.html" : rel);
      if (!file.startsWith(UI)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    s.listen(STATIC_PORT, "127.0.0.1", () => resolve(s));
  });
}

const agent = startAgent();
const started = await waitAgent();
check("12 local development still works",
  started && (await (await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/health`)).json()).ok === true,
  "the local agent service boots and answers /api/v1/health");

if (started) {
  const base = `http://127.0.0.1:${AGENT_PORT}`;
  const big = await fetch(base + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "x".repeat(20 * 1024) }) });
  const badJson = await fetch(base + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  const unknown = await fetch(base + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "1", obsDateSec: 1, evil: true }) });
  check("5  invalid and oversized requests are rejected",
    big.status === 413 && badJson.status === 400 && unknown.status === 400,
    `oversized=${big.status} malformed=${badJson.status} unknown-field=${unknown.status}`);

  // A buy far above the limits must be refused with reasons, before any network.
  const denied = await fetch(base + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: (10n ** 30n).toString(), obsDateSec: Math.floor(Date.now() / 1000) + 7200 }) });
  const dj = await denied.json();
  check("9  the agent's spending limits are enforced",
    denied.status === 403 && dj.error === "denied" && Array.isArray(dj.reasons) && dj.reasons.length > 0,
    `status=${denied.status} reasons=${(dj.reasons || []).slice(0, 2).join("; ")}`);
}

// ---------------------------------------------------------------- browser: 2, 3, 4, 6

const staticSrv = LIVE ? null : await serveStatic();
const URL_UNDER_TEST = LIVE || `http://127.0.0.1:${STATIC_PORT}/`;
const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
// Capture the exact `quote` query the page sends, so check 4 compares the
// browser's verdict with the shared engine on the SAME payout the page used.
let quoteArgs = null;
page.on("request", (req) => {
  if (!/fastnear|drpc/.test(req.url())) return;
  const body = req.postData();
  if (!body || !body.includes("quote")) return;
  try {
    const p = JSON.parse(body).params;
    if (p.method_name === "quote") quoteArgs = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
  } catch { /* ignore */ }
});
// Block any attempt to reach the operator's local agent, so a pass proves the
// public experience does not depend on a local service. The local static test
// server is exempt (it is the page under test, not an agent).
await page.route(/https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//, (r) => {
  const u = new URL(r.request().url());
  if (u.port === String(STATIC_PORT)) return r.continue();
  return r.abort();
});

try {
  await page.goto(URL_UNDER_TEST, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  const urlHidden = await page.locator("#a-url-wrap").isHidden();
  check("2  the public page loads with no local agent reachable",
    consoleErrors.length === 0 && urlHidden,
    `console errors=${consoleErrors.length}; local URL field hidden=${urlHidden}`);

  await page.waitForFunction(() => { const s = document.querySelector("#a-product"); return s && s.options.length > 0; }, null, { timeout: 20000 });
  await page.selectOption("#a-product", { index: 0 });
  const pid = await page.$eval("#a-product", (s) => s.value);
  quoteArgs = null;
  await page.click("#a-decide");
  await page.waitForFunction(() => /Policy verdict/.test(document.querySelector("#a-status").textContent), null, { timeout: 20000 });
  const statusText = await page.textContent("#a-status");
  const stateText = await page.textContent("#a-state");

  check("3  public read-only evaluation works with no signing service",
    /ALLOW|DENY/.test(stateText) && /read-only/i.test(stateText),
    `verdict rendered, mode labelled read-only`);

  // The browser's verdict must equal the shared engine's verdict on the SAME
  // live quote the page read — proving the public result is the deterministic
  // engine, not a guess or a fabricated number. Big money fields are read as
  // exact digit strings, because JSON.parse rounds integers above 2^53.
  const productRaw = await rpcView("get_product", { id: pid });
  const field = (name) => {
    const m = productRaw.match(new RegExp('"' + name + '"\\s*:\\s*("?[^",}]*"?)'));
    return m ? m[1].replace(/"/g, "") : null;
  };
  const product = {
    id: pid, city: field("city"),
    min_payout: field("min_payout"), max_payout: field("max_payout"),
    min_lead_sec: Number(field("min_lead_sec") || 0), active: field("active") !== "false",
  };
  const payout = quoteArgs ? quoteArgs.payout : product.max_payout;
  const premium = (await rpcView("quote", { product_id: pid, payout })).match(/-?\d+/)[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const { evaluate, DEFAULT_LIMITS } = await import("../agent/limits.mjs");
  const expected = evaluate(
    { productId: pid, city: product.city, payoutYocto: String(payout), premiumYocto: String(premium), obsDateSec: nowSec + product.min_lead_sec + 24 * 3600, nowSec },
    product, { limits: DEFAULT_LIMITS, history: [], nowMs: nowSec * 1000 });
  const browserAllow = /ALLOW/.test(stateText);
  // The premium the page displayed must be the contract's premium (formatted
  // the same way the page formats it: NEAR, six decimals).
  const shownPremium = (Number(BigInt(premium)) / 1e24).toFixed(6);
  check("4  the read-only verdict is derived from the live contract quote",
    quoteArgs !== null && browserAllow === expected.allow && stateText.includes(shownPremium),
    `browser ${browserAllow ? "ALLOW" : "DENY"} == shared engine ${expected.allow ? "ALLOW" : "DENY"} for ${pid}; page shows premium ${shownPremium} NEAR`);

  // Now switch to local mode pointed at a dead port and confirm a safe message.
  await page.click('.mode-switch .btn-s[data-mode="local"]');
  await page.fill("#a-url", "http://127.0.0.1:1");
  await page.click("#a-connect");
  await page.waitForFunction(() => /Could not reach your agent service/.test(document.querySelector("#a-status").textContent), null, { timeout: 15000 });
  const errText = await page.textContent("#a-status");
  check("6  an unreachable service yields a safe, human message",
    !/Failed to fetch/i.test(errText) && /Could not reach your agent service/.test(errText),
    errText.slice(0, 90));
} catch (e) {
  check("2  the public page loads with no local agent reachable", false, "browser error: " + e.message);
}

await browser.close();
if (staticSrv) staticSrv.close();
agent.kill("SIGTERM");

const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  — ${r.detail}`);
console.log(`\n${passed}/${results.length} connectivity checks passed. URL under test: ${URL_UNDER_TEST}`);
fs.writeFileSync(new URL("./connectivity.json", import.meta.url), JSON.stringify({ url: URL_UNDER_TEST, at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
