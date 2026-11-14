// Capture high-resolution frames from the LIVE Overcover production console.
// Nothing is staged: every number on screen is read from the contract by the page.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXEC = process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const BASE = process.argv[2] || "https://overcover.vercel.app/";
const W = 1920, H = 1080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "frames");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// scroll an element to a vertical offset from the top of the viewport
async function scrollSel(page, sel, offset = 0) {
  await page.evaluate(([s, o]) => {
    const el = document.querySelector(s);
    if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top + o, behavior: "instant" });
  }, [sel, offset]).catch(() => {});
  await sleep(1200);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name + ".png") });
  console.log("shot", name);
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXEC, args: ["--force-device-scale-factor=1"] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(4000); // let live reads land

  const shots = [
    ["01-hero", "#hero-h", -90],
    ["02-cover", "#cover", -60],
    ["03-products", "#products", -60],
    ["04-how", "#how", -60],
    ["05-quote", "#quote-h", -80],
    ["06-buy", "#buy-panel", -60],
    ["07-policies", "#policies", -60],
    ["08-observations", "#observations", -60],
    ["09-factory", "#factory", -60],
    ["10-agent", "#agent-panel", -60],
    ["11-figs", "#figs", -60],
    ["12-proof", "#proof-h", -60],
    ["13-status", "#status", -60],
    ["14-faq", "#faq", -60],
  ];
  for (const [name, sel, off] of shots) {
    await scrollSel(page, sel, off);
    await shot(page, name);
  }
  await browser.close();
  console.log("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
