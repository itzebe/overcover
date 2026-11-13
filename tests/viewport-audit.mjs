// Viewport audit for the console: no page-level horizontal overflow, no product
// console errors, exactly one h1, and a sticky brand bar that does not eat the
// mobile viewport. This is the machine-checkable half of the acceptance criteria
// ("no accidental horizontal overflow", "no console errors", "excessive sticky
// header height").
//
// Needs a Chromium and `playwright-core`; it is NOT part of `npm test` because
// the other gates already cover the page, and it exits 0 (skipped) cleanly when
// no browser is present. Run with: npm run ui:viewports
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(root, "ui");
const EXEC =
  process.env.CHROME_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
if (!fs.existsSync(EXEC)) {
  console.log(`ui:viewports SKIP — no Chromium at ${EXEC} (set CHROME_PATH)`);
  process.exit(0);
}

const WIDTHS = [320, 360, 390, 430, 768, 1280, 1440];
const MAX_HEADER = 130; // px of sticky chrome tolerated before it crowds the page

// The page reads the contract from public NEAR RPC endpoints. Those endpoints
// rate-limit a burst of page loads (this audit opens seven back-to-back, ~11
// reads each) and answer 429 WITHOUT a CORS header, which the browser reports as
// a console error even though the page fails over correctly and still renders an
// honest live/stale state. Proxying the RPC through Node keeps the page's real
// data path but removes that transport-level noise, so the gate measures the
// page (overflow, layout, real script errors) instead of the public endpoint's
// rate limiter.
const RPC_HOSTS = ["test.rpc.fastnear.com", "rpc.testnet.fastnear.com", "near-testnet.drpc.org"];
const isRpc = (u) => RPC_HOSTS.some((h) => u.includes(h));
async function proxyRpc(route) {
  const req = route.request();
  const cors = { "content-type": "application/json", "access-control-allow-origin": "*" };
  const jsonRpcError = (message) =>
    JSON.stringify({ jsonrpc: "2.0", id: "proxy", error: { code: -32000, message } });
  try {
    const res = await fetch(req.url(), {
      method: req.method(),
      headers: { "content-type": req.headers()["content-type"] || "application/json" },
      body: req.method() === "GET" ? undefined : req.postData(),
    });
    // A rate-limited (429) or otherwise non-200 endpoint is presented to the page
    // as a JSON-RPC error at HTTP 200 — the shape the console already handles by
    // failing over to the next endpoint. This keeps the page's real failover path
    // exercised without emitting a transport-level console error that has nothing
    // to do with the page under test.
    if (res.status !== 200) {
      await route.fulfill({ status: 200, headers: cors, body: jsonRpcError("upstream " + res.status) });
      return;
    }
    await route.fulfill({ status: 200, headers: cors, body: await res.text() });
  } catch {
    await route.fulfill({ status: 200, headers: cors, body: jsonRpcError("rpc unreachable") });
  }
}

// Serve ui/ over HTTP so the page's own fetches (factory.json, products.json)
// succeed and their transport noise cannot be mistaken for a product error.
const MIME = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".txt": "text/plain", ".xml": "application/xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(UI, rel);
  if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const failures = [];

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  // Keep the page's real RPC data path, but take the public endpoints' rate
  // limiting out of the measurement (see proxyRpc above).
  await page.route((u) => isRpc(u.toString()), proxyRpc);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(500);

  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const vw = doc.clientWidth;
    // An element that overflows is fine only when an ancestor is a deliberate
    // horizontal scroll container (.scroll / overflow-x:auto). Those are the
    // designed reflow for wide tables; anything else is an accidental overflow.
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== doc; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && !inScroller(el)) {
        offenders.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 30), right: Math.round(r.right) });
      }
    }
    const header = document.querySelector("header.mast");
    const net = document.querySelector("#netlabel");
    return {
      overflow: doc.scrollWidth - vw,
      offenders: offenders.slice(0, 6),
      headerH: header ? Math.round(header.getBoundingClientRect().height) : 0,
      sections: document.querySelectorAll("main > section").length,
      h1: document.querySelectorAll("h1").length,
      readState: net ? net.textContent.trim() : "",
    };
  });

  if (report.overflow > 1) failures.push(`${width}px: page overflow ${report.overflow}px`);
  if (report.offenders.length) failures.push(`${width}px: elements past the viewport edge: ${JSON.stringify(report.offenders)}`);
  if (errors.length) failures.push(`${width}px: console errors: ${errors.slice(0, 3).join(" | ")}`);
  if (report.headerH > MAX_HEADER) failures.push(`${width}px: sticky header is ${report.headerH}px (> ${MAX_HEADER}px)`);
  if (report.sections < 5) failures.push(`${width}px: only ${report.sections} main sections rendered`);
  if (report.h1 !== 1) failures.push(`${width}px: expected exactly one h1, found ${report.h1}`);
  // The console must reach the live read state against the contract; if the
  // data path broke, this audit must fail rather than pass on layout alone.
  if (!/live$/.test(report.readState)) failures.push(`${width}px: console did not reach the live read state (got "${report.readState}")`);

  console.log(`[${width}px] overflow=${report.overflow} header=${report.headerH}px sections=${report.sections} h1=${report.h1} read=${report.readState || "?"} consoleErrors=${errors.length}`);
  await page.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error("\nui:viewports FAIL\n" + failures.map((f) => " - " + f).join("\n"));
  process.exit(1);
}
console.log(`\nui:viewports PASS: no overflow, no console errors, header <= ${MAX_HEADER}px at ${WIDTHS.join(", ")} px`);
