// Verify the designed cards: text presence, no overflow, and WCAG contrast of
// the text colours used. Renders each card HTML headless and inspects the DOM.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXEC = process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const W = 1920, H = 1080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "cards-html");

function lum(rgb) {
  const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); }
const parse = (s) => { const m = s.match(/\d+/g); return m ? m.slice(0, 3).map(Number) : null; };

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: W, height: H } });
let issues = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  await page.goto("file://" + path.join(dir, f), { waitUntil: "load" });
  const res = await page.evaluate(() => {
    const field = getComputedStyle(document.body).backgroundColor;
    const out = [];
    document.querySelectorAll("h1,h2,.t,.d,.k,.v,.sub,.n,.l,.h,.foot,.note,.flag,.kick").forEach((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, text: (el.innerText || "").slice(0, 60), color: cs.color,
        size: parseFloat(cs.fontSize), weight: cs.fontWeight, inView: r.top >= -1 && r.bottom <= 1081 && r.width > 0 });
    });
    return { field, out, scrollH: document.body.scrollHeight, scrollW: document.body.scrollWidth };
  });
  const fieldRGB = parse(res.field);
  const overflows = res.scrollH > H + 1 || res.scrollW > W + 1;
  if (overflows) { console.log("OVERFLOW", f); issues++; }
  for (const el of res.out) {
    if (!el.text) continue;
    const c = parse(el.color);
    const large = el.size >= 24 || (el.size >= 18.66 && Number(el.weight) >= 700);
    const need = large ? 3.0 : 4.5;
    const r = c && fieldRGB ? ratio(c, fieldRGB) : 0;
    const ok = r >= need;
    if (!ok) { console.log(`  LOW CONTRAST ${f} ${el.tag} ${r.toFixed(2)} (need ${need}) "${el.text}"`); issues++; }
  }
  console.log("checked", f);
}
await browser.close();
console.log(issues === 0 ? "CARDS OK: no overflow, all text clears WCAG AA" : `${issues} issues`);
process.exit(issues === 0 ? 0 : 1);
