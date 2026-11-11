// Accessibility check for the Overcover console.
//
// Runs axe-core (WCAG 2.2 AA rules) against the real page at several widths, and
// again with the wallet dialog open — the modal is where the reported defect lived,
// so it must be checked too. Needs a Chromium and `playwright-core`; it is NOT part
// of `npm test`.
//
//   node tests/axe.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(root, "ui");
const EXEC = process.env.CHROME_PATH || "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const PORT = 9100 + Math.floor(Math.random() * 80);
const WIDTHS = [320, 360, 390, 768, 1024, 1280, 1440];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain", ".xml": "application/xml" };

const axeSource = fs.readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");

function serveStatic() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(UI, rel === "/" ? "index.html" : rel);
      if (!file.startsWith(UI)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });
}

async function runAxe(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
  });
}

async function main() {
  const srv = await serveStatic();
  const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
  let failed = false;

  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    const pageV = await runAxe(page);
    if (pageV.length) {
      failed = true;
      console.error(`[${w}px] page violations: ${JSON.stringify(pageV)}`);
    } else {
      console.log(`[${w}px] page: 0 violations`);
    }

    // The modal must also be clean.
    await page.locator("#wallet-slot [data-wallet='connect']").click();
    await page.waitForFunction(() => document.querySelector("#wallet-dialog")?.open === true, null, { timeout: 5000 });
    const dlgV = await runAxe(page);
    if (dlgV.length) {
      failed = true;
      console.error(`[${w}px] dialog violations: ${JSON.stringify(dlgV)}`);
    } else {
      console.log(`[${w}px] dialog: 0 violations`);
    }
    await page.close();
  }

  await browser.close();
  srv.close();
  if (failed) { console.error("AXE FAILED"); process.exit(1); }
  console.log(`AXE PASS: 0 violations at ${WIDTHS.join(", ")} px (page and wallet dialog).`);
}

main().catch((e) => { console.error("axe harness error:", e.message); process.exit(1); });
