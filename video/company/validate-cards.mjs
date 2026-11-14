// Validate every designed card fits 1920x1080 with no overflow or clipping.
// Reads the HTML cards.mjs writes to cards-html/.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXEC = process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const W = 1920, H = 1080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "cards-html");
if (!fs.existsSync(dir)) { console.log("no cards-html dir; run cards.mjs first"); process.exit(1); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: W, height: H } });
let bad = 0;
for (const f of files) {
  await page.goto("file://" + path.join(dir, f), { waitUntil: "load" });
  const res = await page.evaluate(([W, H]) => {
    const out = [];
    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) {
        out.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) });
      }
    });
    return { overflow: out, scrollH: document.body.scrollHeight, scrollW: document.body.scrollWidth };
  }, [W, H]);
  const ok = res.overflow.length === 0 && res.scrollH <= H + 1 && res.scrollW <= W + 1;
  if (!ok) { bad++; console.log("OVERFLOW", f, JSON.stringify(res).slice(0, 400)); }
  else console.log("ok", f);
}
await browser.close();
console.log(bad === 0 ? "ALL CARDS FIT" : `${bad} cards overflow`);
process.exit(bad === 0 ? 0 : 1);
