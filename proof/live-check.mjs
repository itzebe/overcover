// Independent check of the LIVE production console (not a local copy):
// loads https://overcover.vercel.app/ at mobile..desktop widths, fails on any
// console error or uncaught exception, asserts no horizontal overflow, and
// screenshots each width into proof/shots/.
import fs from "node:fs";
import { chromium } from "playwright-core";

const LIVE = process.env.LIVE_URL || "https://overcover.vercel.app/";
const EXEC = process.env.CHROME_PATH || "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const WIDTHS = [320, 390, 768, 1280, 1440];
const OUT = new URL("./shots/", import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXEC, headless: true });
const results = [];
let failed = false;
for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("uncaught: " + e.message));
  await page.goto(LIVE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const title = await page.title();
  const hasContract = await page.evaluate(() => document.body.innerText.includes("contract.attestor-overcover.testnet"));
  const capitalShown = await page.evaluate(() => /14\.0\d+ NEAR|14\.05/.test(document.body.innerText));
  await page.screenshot({ path: new URL(`live-${width}.png`, OUT).pathname, fullPage: false });
  const ok = errors.length === 0 && overflow <= 0;
  if (!ok) failed = true;
  results.push({ width, ok, console_errors: errors.length, overflow_px: overflow, title, shows_contract: hasContract, shows_capital: capitalShown });
  await page.close();
}
await browser.close();
console.log(JSON.stringify({ url: LIVE, results }, null, 2));
process.exit(failed ? 1 : 0);
