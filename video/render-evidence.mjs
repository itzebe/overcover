// Render the human-purchase evidence panel to a static HTML page that the
// capture harness records as a scene. The panel is built entirely from the
// verified JSON written by video/verify-human-purchase.mjs, so the video can
// only ever show numbers the chain actually returned.
//
//   node video/verify-human-purchase.mjs   # writes video/evidence/human-purchase.json
//   node video/render-evidence.mjs         # writes video/evidence/human-panel.html
//
// If the evidence file is missing the script fails; the panel is never rendered
// from stale or invented data.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EVIDENCE = path.join(ROOT, "video", "evidence", "human-purchase.json");
const OUT = path.join(ROOT, "video", "evidence", "human-panel.html");

if (!fs.existsSync(EVIDENCE)) {
  console.error("run `node video/verify-human-purchase.mjs` first (no video/evidence/human-purchase.json)");
  process.exit(1);
}
const e = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));

const T = {
  field: "#10251d",
  paper: "#f6f4ee",
  ink: "#131a16",
  ink2: "#42504a",
  accent: "#8f4a12",
  gold: "#e0aa55",
  onField: "#eef3ef",
  onField2: "#b9c9c0",
  ok: "#2f7d54",
};

const W = Number(process.env.VIDEO_W || 1920);
const H = Number(process.env.VIDEO_H || 1080);
const near = (y) => (Number(BigInt(y)) / 1e24).toFixed(2);
const nearP = (y) => (Number(BigInt(y)) / 1e24).toFixed(4);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const legacyTag = e.contract.includes("attestor") ? "legacy v1 build" : "hardened v3 build";
const checks = e.checks;
const pass = Object.values(checks).every(Boolean);
const checkRows = [
  ["Transaction succeeded", checks.txStatusSuccess],
  ["Return value is policy " + e.policy.id, checks.policyIdMatchesSuccessValue],
  ["Policy buyer is the transaction signer", checks.buyerIsSigner],
  ["Deposit covers the premium", checks.depositCoversPremium],
  ["Called the Overcover contract", checks.receiverIsContract],
  ["Method is buy_cover", checks.methodIsBuyCover],
];

const html = `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; background:${T.field}; color:${T.onField};
    font-family:"DejaVu Sans", system-ui, sans-serif; overflow:hidden; }
  .wrap { position:absolute; inset:0; padding:64px 72px 118px 72px; display:flex; flex-direction:column; }
  .kick { font-family:"DejaVu Sans Mono", monospace; font-size:15px; letter-spacing:.3em;
    text-transform:uppercase; color:${T.gold}; }
  h1 { font-family:"DejaVu Serif", Georgia, serif; font-size:46px; line-height:1.1; margin-top:14px; }
  .sub { color:${T.onField2}; font-size:17px; margin-top:10px; }
  .cols { display:grid; grid-template-columns:1.35fr 1fr; gap:34px; margin-top:30px; }
  .card { border:1px solid rgba(238,243,239,.16); border-radius:10px; padding:24px 26px; background:rgba(255,255,255,.02); }
  .card h2 { font-size:13px; letter-spacing:.22em; text-transform:uppercase; color:${T.gold};
    font-family:"DejaVu Sans Mono", monospace; font-weight:400; margin-bottom:16px; }
  .row { display:flex; justify-content:space-between; gap:18px; padding:7px 0;
    border-bottom:1px solid rgba(238,243,239,.08); font-size:16px; }
  .row:last-child { border-bottom:none; }
  .row .k { color:${T.onField2}; }
  .row .v { font-family:"DejaVu Sans Mono", monospace; text-align:right; word-break:break-all; max-width:70%; }
  .tag { display:inline-block; font-family:"DejaVu Sans Mono", monospace; font-size:12px; letter-spacing:.14em;
    text-transform:uppercase; color:${T.field}; background:${T.gold}; padding:2px 8px; border-radius:4px; }
  .hash { color:${T.gold}; }
  .checks { margin-top:26px; display:grid; grid-template-columns:1fr 1fr; gap:8px 40px; }
  .chk { display:flex; align-items:center; gap:12px; font-size:16px; color:${T.onField}; }
  .chk .b { width:22px; height:22px; border-radius:50%; display:flex; align-items:center; justify-content:center;
    font-size:14px; background:${pass ? T.ok : T.accent}; color:#fff; flex:none; }
  .foot { margin-top:auto; color:${T.onField2}; font-size:14px; font-family:"DejaVu Sans Mono", monospace; }
  .badge { position:absolute; top:64px; right:72px; text-align:right; }
</style>
<div class="wrap">
  <div class="badge"><span class="tag">${esc(legacyTag)}</span></div>
  <div class="kick">The human purchase · verified on-chain</div>
  <h1>A real person's cover — the transaction and the policy, re-read from NEAR.</h1>
  <div class="sub">Not a screenshot. Every value below is fetched from NEAR testnet RPC when this video is built.</div>
  <div class="cols">
    <div class="card">
      <h2>The transaction</h2>
      <div class="row"><span class="k">Hash</span><span class="v hash">${esc(e.tx.hash)}</span></div>
      <div class="row"><span class="k">Signer</span><span class="v">${esc(e.tx.signer)}</span></div>
      <div class="row"><span class="k">Called</span><span class="v">${esc(e.tx.receiver)} · ${esc(e.tx.method)}</span></div>
      <div class="row"><span class="k">Deposit</span><span class="v">${nearP(e.tx.deposit)} NEAR</span></div>
      <div class="row"><span class="k">Result</span><span class="v">${esc(e.tx.status)} → policy ${esc(e.tx.successValue)}</span></div>
      <div class="row"><span class="k">Block</span><span class="v">${esc(e.tx.blockHash)}</span></div>
    </div>
    <div class="card">
      <h2>The resulting policy</h2>
      <div class="row"><span class="k">Policy</span><span class="v">#${esc(String(e.policy.id))}</span></div>
      <div class="row"><span class="k">Product</span><span class="v">${esc(e.policy.product_id)}</span></div>
      <div class="row"><span class="k">Payout</span><span class="v">${near(e.policy.payout)} NEAR</span></div>
      <div class="row"><span class="k">Premium</span><span class="v">${nearP(e.policy.premium)} NEAR</span></div>
      <div class="row"><span class="k">Buyer</span><span class="v">${esc(e.policy.buyer)}</span></div>
      <div class="row"><span class="k">Status</span><span class="v">${esc(e.policy.status)}</span></div>
    </div>
  </div>
  <div class="checks">
    ${checkRows.map(([t, ok]) => `<div class="chk"><span class="b">${ok ? "✓" : "!"}</span>${esc(t)}</div>`).join("")}
  </div>
  <div class="foot">Verified ${esc(e.verifiedAt)} · ${esc(e.network)} · ${esc(e.contract)}</div>
</div>`;

fs.writeFileSync(OUT, html);
console.log(`wrote video/evidence/human-panel.html (${pass ? "all checks pass" : "CHECKS FAILED"})`);
