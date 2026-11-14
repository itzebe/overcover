// Capture the REAL human purchase journey from the LIVE production console.
//
// This is read-only: it never connects a wallet and never signs or sends
// anything. It records the genuine application screens a person walks through
// — discover, select, terms, price, the purchase surface, the wallet approval
// step, and the live policy register that confirms an active policy.
//
//   node capture-journey.mjs [baseUrl]
//
// Every figure on screen is read from the contract by the page itself.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXEC = process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const BASE = process.argv[2] || "https://overcover.vercel.app/";
const W = 1920, H = 1080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "frames-journey");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrollSel(page, sel, offset = 0) {
  await page.evaluate(([s, o]) => {
    const el = document.querySelector(s);
    if (el) window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top + o, behavior: "instant" });
  }, [sel, offset]).catch(() => {});
  await sleep(1100);
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
  await sleep(4500); // let live reads land

  // 1. Discover — what cover is and how a parametric product works.
  await scrollSel(page, "#how", -70);
  await shot(page, "j1-discover");

  // 2. Select — choose the sellable product and read its terms + price.
  await scrollSel(page, "#cover", -70);
  const chosen = await page.evaluate(() => {
    const sel = document.getElementById("q-product");
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.value && o.value !== "") || sel.options[0];
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    return opt ? opt.textContent.trim() : null;
  }).catch(() => null);
  await sleep(2500); // the page re-reads the contract quote
  await shot(page, "j2-select");

  // Capture the genuine on-page text of each step, so the evidence report is
  // grounded in what the application actually rendered (not OCR guesses).
  const text = await page.evaluate(() => {
    const grab = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.replace(/\s+\n/g, "\n").trim() : null;
    };
    return {
      url: location.href,
      cover: grab("#cover"),
      quote: grab("#q-out"),
      quoteTerms: grab("#q-terms"),
      buyPanel: grab("#buy-panel"),
      policies: grab("#policies"),
      policiesHead: grab("#pol-h"),
    };
  });
  fs.writeFileSync(path.join(OUT, "journey-text.json"), JSON.stringify(text, null, 2));

  // 3. Terms + price — the quote panel (premium, reserve, rate, capacity).
  await scrollSel(page, "#q-out", -140);
  await shot(page, "j3-price");

  // 4. The purchase surface — the panel a human signs in.
  await scrollSel(page, "#buy-panel", -60);
  await shot(page, "j4-purchase");

  // 5. The wallet approval step — the genuine picker the page opens.
  await page.evaluate(() => {
    const b = document.getElementById("buy-wallet-connect") ||
              document.querySelector('[data-wallet="connect"]');
    if (b) b.click();
  }).catch(() => {});
  await sleep(1500);
  await shot(page, "j5-wallet");
  await page.evaluate(() => {
    const c = document.querySelector("[data-wallet-close]");
    if (c) c.click();
  }).catch(() => {});
  await sleep(800);

  // 6. The live policy register — the resulting policy confirmation surface.
  await scrollSel(page, "#policies", -60);
  await shot(page, "j6-policies");

  // 7. The legacy-v1 disclosure — the console labels it and disables buying.
  await page.goto(BASE + "?contract=contract.attestor-overcover.testnet",
    { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(4000);
  await scrollSel(page, "#sec-banner", -70);
  await shot(page, "j7-legacy-banner");

  console.log("chosen product:", chosen);
  await browser.close();
  console.log("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
