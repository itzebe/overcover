// Render the designed full-bleed cards (title, NEAR, lifecycle, security,
// architecture, close) to 1920x1080 PNGs with Chromium. Palette + type roles
// mirror the console (video/build.mjs): field green, paper, copper accent,
// gold kicker, serif display, mono labels.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXEC = process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "cards");
const W = 1920, H = 1080;
fs.mkdirSync(OUT, { recursive: true });

const T = {
  field: "#10251d", field2: "#17352a", paper: "#f6f4ee", ink: "#131a16",
  accent: "#8f4a12", gold: "#e0aa55", onField: "#eef3ef", onField2: "#b9c9c0",
};
const SERIF = '"DejaVu Serif", Georgia, serif';
const SANS = '"DejaVu Sans", system-ui, sans-serif';
const MONO = '"DejaVu Sans Mono", monospace';

const shell = (css, body) => `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;background:${T.field};color:${T.onField};font-family:${SANS};overflow:hidden}
  ${css}
</style>${body}`;

const kicker = (t) => `<div class="kick">${t}</div>`;

const CARDS = {
  open: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.36em;text-transform:uppercase;color:${T.gold};margin-bottom:28px}
    h1{font-family:${SERIF};font-weight:700;font-size:150px;letter-spacing:-.025em;line-height:.98}
    .sub{margin-top:30px;font-size:32px;color:${T.onField2};max-width:30ch;line-height:1.42}
    .accent{position:absolute;left:132px;bottom:210px;width:110px;height:5px;background:${T.accent}}
    .foot{position:absolute;left:132px;bottom:150px;font-family:${MONO};font-size:17px;letter-spacing:.2em;color:${T.onField2};text-transform:uppercase}
  `, `<div class="wrap">${kicker("Capital-backed parametric insurance infrastructure")}
      <h1>OVERCOVER</h1>
      <div class="sub">Insurance an autonomous business can buy — verified, reserved, and settled on-chain.</div></div>
    <div class="accent"></div><div class="foot">Built on NEAR · Testnet</div>`),

  near: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:30px}
    h2{font-family:${SERIF};font-size:88px;line-height:1.06;max-width:20ch}
    .rows{margin-top:56px;display:flex;flex-direction:column;gap:18px;max-width:1180px}
    .row{display:flex;gap:26px;align-items:baseline;border-top:1px solid rgba(238,243,239,.14);padding-top:16px}
    .k{font-family:${MONO};font-size:18px;letter-spacing:.14em;text-transform:uppercase;color:${T.gold};width:230px;flex:0 0 230px}
    .v{font-family:${MONO};font-size:24px;color:${T.onField};word-break:break-all}
    .accent{position:absolute;left:130px;top:118px;width:110px;height:5px;background:${T.accent}}
  `, `<div class="accent"></div><div class="wrap">${kicker("Why NEAR")}
      <h2>One Rust contract is the whole financial authority.</h2>
      <div class="rows">
        <div class="row"><div class="k">Network</div><div class="v">NEAR testnet</div></div>
        <div class="row"><div class="k">Contract</div><div class="v">contract.ovc-v3-ctl-2f6c4c.testnet</div></div>
        <div class="row"><div class="k">Code hash</div><div class="v">CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL</div></div>
        <div class="row"><div class="k">Runtime</div><div class="v">near-sdk 5 · WebAssembly · verifiable state</div></div>
      </div></div>`),

  lifecycle: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:26px}
    h2{font-family:${SERIF};font-size:74px;line-height:1.08;max-width:22ch}
    .steps{margin-top:64px;display:flex;align-items:stretch;gap:0}
    .step{flex:1;padding:0 22px;position:relative}
    .step:not(:first-child){border-left:1px solid rgba(238,243,239,.16)}
    .n{font-family:${MONO};font-size:16px;color:${T.gold};letter-spacing:.14em}
    .t{margin-top:14px;font-family:${SERIF};font-size:30px;line-height:1.18;color:${T.onField}}
    .d{margin-top:12px;font-size:21px;line-height:1.42;color:${T.onField2}}
    .accent{position:absolute;left:130px;top:118px;width:110px;height:5px;background:${T.accent}}
  `, `<div class="accent"></div><div class="wrap">${kicker("The product lifecycle")}
      <h2>Defined before purchase. Settled exactly once.</h2>
      <div class="steps">
        <div class="step"><div class="n">01</div><div class="t">Define</div><div class="d">Immutable product: city, index, trigger, payout.</div></div>
        <div class="step"><div class="n">02</div><div class="t">Buy &amp; reserve</div><div class="d">Premium quoted by the contract; payout reserved from the pool.</div></div>
        <div class="step"><div class="n">03</div><div class="t">Observe</div><div class="d">Signed reading, finalised by a quorum of operators.</div></div>
        <div class="step"><div class="n">04</div><div class="t">Challenge</div><div class="d">Anyone may dispute a reading by posting a bond.</div></div>
        <div class="step"><div class="n">05</div><div class="t">Settle</div><div class="d">Independent resolver; payout is one comparison, run once.</div></div>
      </div></div>`),

  security: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:26px}
    h2{font-family:${SERIF};font-size:76px;line-height:1.08;max-width:22ch}
    .grid{margin-top:60px;display:grid;grid-template-columns:1fr 1fr;gap:26px 60px;max-width:1500px}
    .item{display:flex;gap:18px;align-items:flex-start;border-top:1px solid rgba(238,243,239,.14);padding-top:16px}
    .dot{width:10px;height:10px;background:${T.accent};margin-top:10px;flex:0 0 10px}
    .t{font-family:${SERIF};font-size:30px}
    .d{font-size:20px;color:${T.onField2};margin-top:8px;line-height:1.4}
    .accent{position:absolute;left:130px;top:118px;width:110px;height:5px;background:${T.accent}}
    .note{position:absolute;left:130px;bottom:70px;font-family:${MONO};font-size:19px;color:${T.onField2};letter-spacing:.04em}
  `, `<div class="accent"></div><div class="wrap">${kicker("Security and capital integrity")}
      <h2>Receiving a reading is easy. Trusting it is the hard part.</h2>
      <div class="grid">
        <div class="item"><div class="dot"></div><div><div class="t">Signed observations</div><div class="d">Readings are cryptographically signed by operators.</div></div></div>
        <div class="item"><div class="dot"></div><div><div class="t">Operator quorum</div><div class="d">A quorum of distinct operators must agree within tolerance.</div></div></div>
        <div class="item"><div class="dot"></div><div><div class="t">Bonded disputes</div><div class="d">A challenge posts a bond; a false claim forfeits it.</div></div></div>
        <div class="item"><div class="dot"></div><div><div class="t">Deterministic settlement</div><div class="d">Payout follows the immutable product, once.</div></div></div>
        <div class="item"><div class="dot"></div><div><div class="t">Capital reservation</div><div class="d">Reserved capital can never exceed pool capital.</div></div></div>
        <div class="item"><div class="dot"></div><div><div class="t">Enforced invariant</div><div class="d">Re-checked after every state change; the call reverts otherwise.</div></div></div>
      </div></div>
      <div class="note">Execution integrity (a TEE attestation) is not proof that an observation is true.</div>`),

  architecture: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:22px}
    h2{font-family:${SERIF};font-size:66px;line-height:1.08;max-width:26ch}
    .diagram{margin-top:52px;display:flex;align-items:stretch;gap:0;font-family:${MONO}}
    .col{flex:1;padding:24px 26px;border:1px solid rgba(238,243,239,.16);background:rgba(255,255,255,.02)}
    .col.chain{background:rgba(143,74,18,.14);border-color:rgba(224,170,85,.4)}
    .h{font-size:17px;letter-spacing:.16em;text-transform:uppercase;color:${T.gold};margin-bottom:14px}
    .l{font-size:22px;color:${T.onField};line-height:1.7}
    .arrow{align-self:center;padding:0 16px;color:${T.gold};font-size:26px}
    .accent{position:absolute;left:130px;top:112px;width:110px;height:5px;background:${T.accent}}
    .foot{position:absolute;left:130px;bottom:64px;font-family:${MONO};font-size:19px;color:${T.onField2}}
  `, `<div class="accent"></div><div class="wrap">${kicker("Architecture and differentiation")}
      <h2>Infrastructure, not an interface.</h2>
      <div class="diagram">
        <div class="col"><div class="h">Observation sources</div><div class="l">Public index APIs<br>Operator signing keys</div></div>
        <div class="arrow">→</div>
        <div class="col chain"><div class="h">NEAR contract (Rust)</div><div class="l">Products · Policies<br>Pool · Observations<br>Disputes · Settlement</div></div>
        <div class="arrow">→</div>
        <div class="col"><div class="h">Clients</div><div class="l">Console (read-only)<br>Autonomous agent<br>Permissionless factory</div></div>
      </div>
      <div class="foot">Invariant enforced on-chain: reserved capital ≤ pool capital</div></div>`),

  journey: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:26px}
    h2{font-family:${SERIF};font-size:72px;line-height:1.08;max-width:24ch}
    .steps{margin-top:60px;display:flex;align-items:stretch;gap:0}
    .step{flex:1;padding:0 20px;position:relative}
    .step:not(:first-child){border-left:1px solid rgba(238,243,239,.16)}
    .n{font-family:${MONO};font-size:16px;color:${T.gold};letter-spacing:.14em}
    .t{margin-top:14px;font-family:${SERIF};font-size:28px;line-height:1.18;color:${T.onField}}
    .d{margin-top:12px;font-size:20px;line-height:1.42;color:${T.onField2}}
    .accent{position:absolute;left:130px;top:118px;width:110px;height:5px;background:${T.accent}}
  `, `<div class="accent"></div><div class="wrap">${kicker("The customer journey is live")}
      <h2>Buying cover is a working flow, not a mock-up.</h2>
      <div class="steps">
        <div class="step"><div class="n">01</div><div class="t">Discover</div><div class="d">A catalogue read live from the contract.</div></div>
        <div class="step"><div class="n">02</div><div class="t">Select &amp; quote</div><div class="d">The contract prices the cover; the page only displays it.</div></div>
        <div class="step"><div class="n">03</div><div class="t">Buy</div><div class="d">One buy_cover, signed in the buyer's own wallet.</div></div>
        <div class="step"><div class="n">04</div><div class="t">Policy</div><div class="d">An active policy with payout reserved from the pool.</div></div>
      </div></div>`),

  evidence: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:26px}
    h2{font-family:${SERIF};font-size:68px;line-height:1.08;max-width:26ch}
    .rows{margin-top:46px;display:flex;flex-direction:column;gap:0;max-width:1560px}
    .row{display:flex;gap:24px;align-items:baseline;border-top:1px solid rgba(238,243,239,.14);padding:14px 0}
    .k{font-family:${MONO};font-size:17px;letter-spacing:.1em;text-transform:uppercase;color:${T.gold};width:250px;flex:0 0 250px}
    .v{font-family:${MONO};font-size:22px;color:${T.onField};word-break:break-all;line-height:1.4}
    .v small{color:${T.onField2};font-size:19px}
    .flag{margin-top:26px;border-left:3px solid ${T.accent};padding-left:22px;font-size:23px;color:${T.onField};max-width:1500px;line-height:1.42}
    .flag b{font-family:${MONO};font-size:20px;letter-spacing:.08em;color:${T.gold};text-transform:uppercase}
    .accent{position:absolute;left:130px;top:112px;width:110px;height:5px;background:${T.accent}}
  `, `<div class="accent"></div><div class="wrap">${kicker("Verified on the public chain")}
      <h2>The purchase path is real. Here is exactly what was verified.</h2>
      <div class="rows">
        <div class="row"><div class="k">Contract</div><div class="v">contract.ovc-v3-ctl-2f6c4c.testnet <small>· NEAR testnet</small></div></div>
        <div class="row"><div class="k">Purchase call</div><div class="v">buy_cover · 0.10 NEAR payout · 0.0050 NEAR premium <small>· Success</small></div></div>
        <div class="row"><div class="k">Resulting policy</div><div class="v">policy #3 · heat-lagos · status active <small>· payout reserved</small></div></div>
        <div class="row"><div class="k">Transaction</div><div class="v">45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn</div></div>
      </div>
      <div class="flag"><b>Signed by the project's agent.</b> This on-chain purchase was signed programmatically. A human-wallet purchase on this hardened contract is the one acceptance step still outstanding — the console is ready for it.</div>
      </div>`),

  close: shell(`
    .wrap{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
    .kick{font-family:${MONO};font-size:17px;letter-spacing:.34em;text-transform:uppercase;color:${T.gold};margin-bottom:30px}
    h1{font-family:${SERIF};font-weight:700;font-size:132px;letter-spacing:-.025em;line-height:1}
    .sub{margin-top:26px;font-size:30px;color:${T.onField2};max-width:30ch;line-height:1.4}
    .rows{margin-top:50px;font-family:${MONO};font-size:22px;color:${T.onField2};line-height:2}
    .rows b{color:${T.onField};font-weight:400}
    .accent{position:absolute;left:130px;bottom:200px;width:110px;height:5px;background:${T.accent}}
  `, `<div class="wrap">${kicker("Overcover")}
      <h1>OVERCOVER</h1>
      <div class="sub">Capital-backed parametric insurance infrastructure on NEAR.</div>
      <div class="rows"><b>Console</b>&nbsp;&nbsp;overcover.vercel.app<br><b>Contract</b>&nbsp;&nbsp;contract.ovc-v3-ctl-2f6c4c.testnet<br><b>Proof</b>&nbsp;&nbsp;npm run verify:proof</div>
      </div><div class="accent"></div>`),
};

async function main() {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const HTMLDIR = path.join(__dirname, "cards-html");
  fs.mkdirSync(HTMLDIR, { recursive: true });
  for (const [name, html] of Object.entries(CARDS)) {
    fs.writeFileSync(path.join(HTMLDIR, `${name}.html`), html);
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("card", name);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
