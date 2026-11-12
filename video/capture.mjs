// Judge-demo capture harness.
//
// Drives the LIVE production console in a real Chromium and records one clip
// per scene. Nothing here is staged: every number on screen is read from the
// contract by the page itself. The clips are raw material — `video/build.mjs`
// concatenates them and adds the narration and titles.
//
//   node video/capture.mjs [baseUrl]
//
// Output: video/raw/<scene>.webm + video/raw/manifest.json
//
// The base URL defaults to production. Pass a local URL (or a file:// path) to
// record against a different deployment; the console behaves identically.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "video", "raw");
const AUDIO = path.join(ROOT, "video", "audio");
const PAD_SEC = 0.4; // a beat of silence after each line
const EXEC =
  process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";

const BASE = process.argv[2] || "https://overcover.vercel.app/";
const ONLY = process.argv[3] ? process.argv[3].split(",") : null; // optional scene-id filter
const W = 1600;
const H = 900;

// Each scene carries the narration spoken over it. `capture.mjs` synthesises
// that line to audio, measures it, and holds the recorded clip for exactly that
// length plus a short pad — so the video and the voice can never drift apart.
// The narration is the ground truth; keep it honest (see docs/JUDGE_DEMO.md).
const SCENES = [
  {
    id: "01-open",
    narrate:
      "An autonomous agent can now move money with no person in the loop — but it cannot buy insurance, because every insurer underwrites a legal person. And if we let it spend freely, one bug drains the account. So what happens when an agent needs protection, but cannot be trusted with unlimited spending?",
    async run(page, hold) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 1500);
      await holdWithSpotlight(page, hold, ["#main", "#sec-banner"]);
    },
  },
  {
    id: "02-products",
    narrate:
      "Overcover is a parametric risk mutual on N.E.A.R. Risk is defined, not negotiated: each product fixes the city, index, trigger and payout, and never changes. Buying reserves the payout from the pool, so a promise is always backed. This is the live cover, read from the contract.",
    async run(page, hold) {
      await scrollTo(page, "#cover");
      await holdWithSpotlight(page, hold, ["#products .card", "#cover-h"]);
    },
  },
  {
    id: "03-settlement",
    narrate:
      "A claim settles in seconds, not weeks. Cover is defined before purchase, and the payout is reserved when you buy. An operator reports a signed index reading; anyone can challenge it with a bond; a resolver settles the dispute. Then settlement is one comparison, run once.",
    async run(page, hold) {
      await scrollTo(page, "#how");
      await holdWithSpotlight(page, hold, ["#how .steps", "#how-h"]);
    },
  },
  {
    id: "04-quote",
    narrate:
      "This is the human journey. Pick a product and a payout. The premium is not written into the page — it is a live quote from the contract's own method, the exact number buy cover would charge. Move the slider, and the contract requotes.",
    async run(page, hold) {
      await scrollTo(page, "#q-product");
      await settle(page, 1500);
      // Move the payout slider to prove the quote is live.
      const slider = page.locator("#q-payout");
      const box = await slider.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width, box.y + box.height / 2);
        await page.mouse.down();
        for (const f of [0.8, 0.5, 0.7, 0.6]) {
          await page.mouse.move(box.x + box.width * f, box.y + box.height / 2, { steps: 8 });
          await page.waitForTimeout(500);
        }
        await page.mouse.up();
      }
      await holdWithSpotlight(page, hold - 4, ["#q-out", "#q-terms"]);
    },
  },
  {
    id: "05-buy",
    narrate:
      "To buy, you sign one transaction in your own wallet. Overcover never sees your key; access is scoped to a single method, buy cover. On the wrong network, the page refuses before it builds the call. Approve, and the policy appears from the chain.",
    async run(page, hold) {
      await scrollTo(page, "#buy-panel");
      await settle(page, 1200);
      // Open the wallet picker so the approval surface is visible.
      const btn = page.locator("#buy-wallet-connect");
      if (await btn.count()) {
        await btn.click().catch(() => {});
        await settle(page, 1500);
      }
      await holdWithSpotlight(page, hold, ["#buy-panel", "#wallet-choices", "dialog[open]"]);
    },
  },
  {
    id: "06-policies",
    narrate:
      "A person and an autonomous agent end in the same place: a verifiable on-chain policy. Here are the policies the contract has written — each names its buyer, product, payout and status. The page shows only what the contract stores, and never invents a status.",
    async run(page, hold) {
      await scrollTo(page, "#policies");
      await holdWithSpotlight(page, hold, ["#policies .scroll", "#policies-h"]);
    },
  },
  {
    id: "07-agent",
    narrate:
      "Now the autonomous agent. It has its own N.E.A.R. account and key, which stays server-side. It reads the same products and quotes, but checks its own authorization before spending. Its spending policy has hard ceilings, with no override — a proposal it may not make is refused before any transaction is sent.",
    async run(page, hold) {
      await scrollTo(page, "#agent-panel");
      await settle(page, 1500);
      await holdWithSpotlight(page, hold, ["#agent-panel", "#a-log", "#a-state"]);
    },
  },
  {
    id: "08-factory",
    narrate:
      "Anyone can add cover. A discovery agent reads a real public forecast and prepares a proposal, with the source and the hash of what it saw. Anyone submits it, and the contract decides whether it qualifies — no owner approval. A valid proposal activates as a product.",
    async run(page, hold) {
      await scrollTo(page, "#factory");
      await holdWithSpotlight(page, hold, ["#factory-body", "#factory-h"]);
    },
  },
  {
    id: "09-proof",
    narrate:
      "Don't trust the page. Every figure has a curl behind it: the pool proves it can pay, and the deployed contract is byte-for-byte the source in the repository. Overcover replaces the underwriter and the adjuster with an immutable product, reserved capital, and a signed index with bonded disputes.",
    async run(page, hold) {
      await scrollTo(page, "#figs");
      await holdWithSpotlight(page, 6, ["#figs"]);
      await scrollTo(page, "#proof-h");
      await holdWithSpotlight(page, hold - 6, ["#proof-h", "#proof"]);
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Synthesise one narration line and return its duration in seconds. */
function narrateToWav(id, text) {
  const out = path.join(AUDIO, `${id}.wav`);
  execFileSync("espeak-ng", ["-v", "en-us", "-s", "200", "-p", "42", "-a", "150", "-g", "12", "-w", out, text]);
  const dur = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], { encoding: "utf8" }).trim()
  );
  return { out, dur };
}

async function settle(page, ms) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(ms);
}

async function scrollTo(page, sel) {
  await page
    .evaluate((s) => {
      const el = document.querySelector(s);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, sel)
    .catch(() => {});
  await sleep(1400);
}

/** Hold the frame for `hold` seconds while moving a spotlight over the given
 *  selectors, so the eye is led to the thing being narrated. */
async function holdWithSpotlight(page, hold, selectors) {
  const targets = [];
  for (const sel of selectors) {
    const box = await page.locator(sel).first().boundingBox().catch(() => null);
    if (box) targets.push({ x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 160) });
  }
  const deadline = Date.now() + hold * 1000;
  let i = 0;
  while (Date.now() < deadline) {
    if (targets.length) {
      const t = targets[i % targets.length];
      await page.mouse.move(t.x, t.y, { steps: 20 }).catch(() => {});
      i++;
    }
    await sleep(Math.max(400, (deadline - Date.now()) / Math.max(1, targets.length || 1)));
  }
}

async function main() {
  if (!ONLY) fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(AUDIO, { recursive: true });
  // Synthesise every line first so each clip is held for its own narration.
  for (const scene of SCENES) {
    const { dur } = narrateToWav(scene.id, scene.narrate);
    scene.hold = Math.max(3, dur + PAD_SEC);
  }
  const total = SCENES.reduce((a, s) => a + s.hold, 0);
  console.log(`narration: ${SCENES.length} lines, ${total.toFixed(1)}s total\n`);
  const browser = await chromium.launch({ executablePath: EXEC });
  const manifest = [];
  for (const scene of SCENES.filter((s) => !ONLY || ONLY.includes(s.id))) {
    process.stdout.write(`scene ${scene.id} (${scene.hold.toFixed(1)}s) … `);
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      recordVideo: { dir: RAW, size: { width: W, height: H } },
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
    await settle(page, 2500);
    const video = page.video();
    await scene.run(page, scene.hold);
    await ctx.close(); // flushes the video
    const tmp = await video.path();
    const dest = path.join(RAW, `${scene.id}.webm`);
    fs.renameSync(tmp, dest);
    const { size } = fs.statSync(dest);
    manifest.push({ id: scene.id, hold: Number(scene.hold.toFixed(3)), narrate: scene.narrate, file: `raw/${scene.id}.webm`, bytes: size });
    console.log(`${size} bytes`);
  }
  await browser.close();
  let scenes = manifest;
  const mf = path.join(RAW, "manifest.json");
  if (ONLY && fs.existsSync(mf)) {
    const prev = JSON.parse(fs.readFileSync(mf, "utf8")).scenes.filter((s) => !ONLY.includes(s.id));
    scenes = [...prev, ...manifest].sort((a, b) => a.id.localeCompare(b.id));
  }
  fs.writeFileSync(mf, JSON.stringify({ base: BASE, width: W, height: H, scenes }, null, 2));
  console.log(`\nwrote ${manifest.length} clips + manifest.json to video/raw/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
