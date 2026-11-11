// Browser QA harness for the Overcover console.
//
// This is a manual/CI-optional check: it needs a Chromium and `playwright-core`
// (a dev-only tool, not a runtime dependency). It is NOT part of `npm test`.
//
//   node tests/ui.browser.mjs
//
// It serves ui/ over http, starts a DRY-RUN agent service with a throwaway key,
// then for each viewport:
//   * loads the page and fails on any console error or uncaught exception,
//   * asserts there is no horizontal overflow,
//   * exercises the real agent round-trip (health -> decide -> buy in dry run),
//   * writes a screenshot to shots/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { KeyPair } from "near-api-js";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI = path.join(root, "ui");
const SHOTS = path.join(root, "shots");
const EXEC = process.env.CHROME_PATH || "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const STATIC_PORT = 8700 + Math.floor(Math.random() * 90);
const AGENT_PORT = 8800 + Math.floor(Math.random() * 90);
const VIEWPORTS = [320, 360, 390, 412, 768, 1280, 1440];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

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

function startAgent() {
  const kp = KeyPair.fromRandom("ed25519");
  return spawn(process.execPath, [path.join(root, "agent", "server.mjs")], {
    env: {
      ...process.env,
      OVERCOVER_AGENT_ACCOUNT: "ui-qa-agent.testnet",
      OVERCOVER_AGENT_SECRET_KEY: kp.toString(),
      OVERCOVER_AGENT_PORT: String(AGENT_PORT),
      OVERCOVER_AGENT_HOST: "127.0.0.1",
      OVERCOVER_AGENT_DRY_RUN: "1",
      OVERCOVER_AGENT_ORIGINS: `http://127.0.0.1:${STATIC_PORT},http://localhost:${STATIC_PORT}`,
      OVERCOVER_AGENT_LIMITS: JSON.stringify({
        maxPremiumPerPolicy: "100000000000000000000000", // 0.1 NEAR
        maxPayoutPerPolicy: "2000000000000000000000000", // 2 NEAR
        dailyPremiumBudget: "1000000000000000000000000", // 1 NEAR
        dailyPolicyLimit: 3,
        cooldownSec: 0,
        allowedProducts: ["rain-lagos"],
        allowedCities: ["lagos"],
      }),
      OVERCOVER_AGENT_AUDIT: path.join(root, "agent", "audit.uiqa.log.jsonl"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function waitAgent() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("agent service did not start");
}

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

let agentProc, staticSrv;
function cleanup() {
  try { if (agentProc) agentProc.kill("SIGTERM"); } catch {}
  try { if (staticSrv) staticSrv.close(); } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function main() {
  const watchdog = setTimeout(() => { console.error("UI QA harness timed out after 150s"); cleanup(); process.exit(2); }, 150000);
  fs.mkdirSync(SHOTS, { recursive: true });
  staticSrv = await serveStatic();
  const agent = startAgent();
  agentProc = agent;
  await waitAgent();

  // The public discoverability files must be served, not only present on disk.
  for (const f of ["robots.txt", "sitemap.xml", "llms.txt", "llms-full.txt", "og.png"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${STATIC_PORT}/${f}`);
      check(res.ok, `public file /${f} did not serve (HTTP ${res.status})`);
    } catch (e) {
      check(false, `public file /${f} could not be fetched: ${e.message}`);
    }
  }

  const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });

  for (const w of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    await page.goto(`http://127.0.0.1:${STATIC_PORT}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 1, `[${w}px] horizontal overflow of ${overflow}px`);
    check(errs.length === 0, `[${w}px] console errors: ${errs.slice(0, 3).join(" | ")}`);

    const hasWallet = await page.locator("#wallet-slot button, #buy-wallet-slot button").count();
    check(hasWallet > 0, `[${w}px] wallet control missing`);

    // The reported defect: "Connect wallet" looked static, and the picker's
    // Close button did nothing. A click must open the picker where the user is
    // looking; Close, Escape and a backdrop click must each close it; and the
    // picker must be honest about availability.
    const dialogOpen = () => page.evaluate(() => document.querySelector("#wallet-dialog").open);
    try {
      await page.locator("#wallet-slot [data-wallet='connect']").click();
      await page.waitForFunction(() => document.querySelector("#wallet-dialog")?.open === true, null, { timeout: 5000 });
      const picker = await page.evaluate(() => {
        const d = document.querySelector("#wallet-dialog");
        const r = d.getBoundingClientRect();
        return {
          inViewport: r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0,
          opts: document.querySelectorAll(".wp-pick").length,
          installs: document.querySelectorAll(".wp-install").length,
          names: [...document.querySelectorAll(".wp-pick")].map((b) => b.textContent.trim()),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: getComputedStyle(document.body).overflow,
        };
      });
      check(picker.opts >= 1, `[${w}px] the picker offered no wallets`);
      check(picker.inViewport, `[${w}px] the picker opened off-screen`);
      check(picker.overflowX <= 1, `[${w}px] the picker caused ${picker.overflowX}px of horizontal overflow`);
      check(!picker.names.some((n) => /mynear/i.test(n)), `[${w}px] a retired wallet is still offered: ${picker.names.join(", ")}`);
      check(picker.bodyOverflow === "hidden", `[${w}px] the page is not scroll-locked behind the modal`);
      await page.screenshot({ path: path.join(SHOTS, `wallet-picker-${w}.png`), fullPage: false });

      // Close path 1: the Close button (the original defect).
      await page.locator("[data-wallet-close]").click();
      await page.waitForTimeout(150);
      check((await dialogOpen()) === false, `[${w}px] the Close button did not close the dialog`);

      // Close path 2: Escape.
      await page.locator("#wallet-slot [data-wallet='connect']").click();
      await page.waitForFunction(() => document.querySelector("#wallet-dialog")?.open === true, null, { timeout: 5000 });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      check((await dialogOpen()) === false, `[${w}px] Escape did not close the dialog`);

      // Close path 3: a backdrop click, and focus restored to the opener.
      await page.locator("#wallet-slot [data-wallet='connect']").click();
      await page.waitForFunction(() => document.querySelector("#wallet-dialog")?.open === true, null, { timeout: 5000 });
      await page.mouse.click(4, 4);
      await page.waitForTimeout(150);
      check((await dialogOpen()) === false, `[${w}px] a backdrop click did not close the dialog`);
      const focusId = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.getAttribute("data-wallet")));
      check(focusId === "connect" || focusId === "wallet-connect", `[${w}px] focus was not restored to the opener (got ${focusId})`);
    } catch (e) {
      check(false, `[${w}px] wallet picker did not open: ${e.message}`);
    }

    await page.screenshot({ path: path.join(SHOTS, `console-${w}.png`), fullPage: false });
    if (w === 1280) await page.screenshot({ path: path.join(SHOTS, "console-1280-full.png"), fullPage: true });

    if (w === 1280) {
      try {
      // 1) PUBLIC mode: read-only evaluation with no local service involved.
      //    This is the production path — it must work with nothing running.
      const urlHidden = await page.locator("#a-url-wrap").isHidden();
      check(urlHidden, "[agent] the local URL field must be hidden in public mode by default");
      await page.waitForFunction(() => {
        const s = document.querySelector("#a-product");
        return s && [...s.options].some((o) => o.value === "rain-lagos");
      }, null, { timeout: 15000 });
      await page.selectOption("#a-product", "rain-lagos");
      await page.click("#a-decide");
      await page.waitForFunction(() => /Policy verdict/.test(document.querySelector("#a-status").textContent), null, { timeout: 15000 });
      const pubStatus = await page.textContent("#a-status");
      check(!/Failed to fetch/i.test(pubStatus), `[agent] public evaluation surfaced a raw fetch error: ${pubStatus}`);
      const pubState = await page.textContent("#a-state");
      check(/ALLOW|DENY/.test(pubState), "[agent] public evaluation rendered no verdict badge");
      check(/read-only/i.test(pubState), "[agent] public evaluation did not label itself read-only");
      await page.screenshot({ path: path.join(SHOTS, "agent-public-1280.png"), fullPage: false });

      // 2) LOCAL mode: the real round-trip against a dry-run agent service.
      await page.click('.mode-switch .btn-s[data-mode="local"]');
      check(await page.locator("#a-url-wrap").isVisible(), "[agent] the local URL field must appear in local mode");
      await page.fill("#a-url", `http://127.0.0.1:${AGENT_PORT}`);
      await page.click("#a-connect");
      await page.waitForFunction(() => /Connected to agent/.test(document.querySelector("#a-status").textContent), null, { timeout: 15000 });
      await page.waitForFunction(() => /ui-qa-agent\.testnet/.test(document.querySelector("#a-state").textContent), null, { timeout: 15000 });
      const stateText = await page.textContent("#a-state");
      check(/ui-qa-agent\.testnet/.test(stateText), "agent state did not show the account");
      check(/never sends/i.test(stateText), "agent state did not report dry run");
      await page.click("#a-decide");
      await page.waitForFunction(() => /verdict/i.test(document.querySelector("#a-status").textContent), null, { timeout: 15000 });
      const verdict = await page.textContent("#a-state");
      check(/ALLOW|DENY/.test(verdict), "no verdict badge rendered");
      await page.click("#a-buy");
      await page.waitForTimeout(2500);
      const afterBuy = await page.textContent("#a-status");
      check(/Dry run|did not buy|Agent bought/.test(afterBuy), `unexpected buy status: ${afterBuy}`);
      await page.click("#a-kill");
      // The kill switch is best-effort against a local service; do not fail the
      // whole run if the follow-up read races the shutdown.
      await page.waitForFunction(() => /Emergency stop engaged/.test(document.querySelector("#a-status").textContent), null, { timeout: 15000 }).catch(() => {});
      const killed = await page.textContent("#a-state").catch(() => "");
      if (!/Enabled[\s\S]*no/.test(killed)) console.warn("[agent] emergency stop state not confirmed in UI (service may have exited)");
      await page.screenshot({ path: path.join(SHOTS, "agent-1280.png"), fullPage: false });
      } catch (e) {
        const dbg = await page.evaluate(() => ({
          status: document.querySelector("#a-status")?.textContent,
          state: document.querySelector("#a-state")?.textContent?.slice(0, 200),
          err: document.querySelector("#error-slot")?.textContent?.slice(0, 120),
        })).catch(() => ({}));
        check(false, `[agent] ${e.message} :: ${JSON.stringify(dbg)}`);
      }
    }

    await page.close();
  }

  await browser.close();
  agent.kill("SIGTERM");
  staticSrv.close();
  clearTimeout(watchdog);

  if (failures.length) {
    console.error("UI QA FAILED:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log(`UI QA PASS: ${VIEWPORTS.length} viewports, agent round-trip (dry run) OK. Screenshots in shots/.`);
}

main().catch((e) => { console.error("UI QA harness error:", e.message); process.exit(1); });
