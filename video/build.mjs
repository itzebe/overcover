// Build the judge-demo video from the captured clips.
//
//   1. Renders the on-brand title/lower-third overlays with Chromium (crisp
//      typography, the console's own palette and type roles).
//   2. Composites each clip to the exact narration length, adds its lower-third,
//      and concatenates the scenes.
//   3. Lays the narration audio under the picture and muxes to MP4 + WebM.
//
// Run `node video/capture.mjs` first. Requires ffmpeg, ffprobe, espeak-ng.
//
//   node video/build.mjs
//
// Output: video/out/overcover-demo.mp4 and .webm, plus video/out/poster.png.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RAW = path.join(ROOT, "video", "raw");
const AUDIO = path.join(ROOT, "video", "audio");
const OVER = path.join(ROOT, "video", "overlays");
const OUT = path.join(ROOT, "video", "out");
const EXEC =
  process.env.CHROMIUM_PATH ||
  "/home/openhands/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome";
const W = Number(process.env.VIDEO_W || 1920);
const H = Number(process.env.VIDEO_H || 1080);
const FPS = 30;
const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";

// The verified human-purchase record the video cites. Written by
// `video/verify-human-purchase.mjs`; if it is absent the build refuses to run
// so a video can never show a human purchase that was not just re-verified.
const EVIDENCE_PATH = path.join(ROOT, "video", "evidence", "human-purchase.json");
if (!fs.existsSync(EVIDENCE_PATH)) {
  console.error("run `node video/verify-human-purchase.mjs && node video/render-evidence.mjs` first");
  process.exit(1);
}
const EVIDENCE = JSON.parse(fs.readFileSync(EVIDENCE_PATH, "utf8"));
const near2 = (y) => (Number(BigInt(y)) / 1e24).toFixed(2);
const near4 = (y) => (Number(BigInt(y)) / 1e24).toFixed(4);

const T = {
  field: "#10251d",
  field2: "#17352a",
  paper: "#f6f4ee",
  ink: "#131a16",
  accent: "#8f4a12",
  gold: "#e0aa55",
  onField: "#eef3ef",
  onField2: "#b9c9c0",
};

// Scene titles shown in the lower-third, keyed by scene id.
const TITLES = {
  "01-open": "The problem",
  "02-products": "Cover, read from the contract",
  "03-settlement": "How a claim settles",
  "04-quote": "The contract quotes the premium",
  "05-buy": "One signature, in your own wallet",
  "06-human": "The human purchase — verified on-chain",
  "07-human-policy": "Policy 15, in the live console",
  "08-policies": "Verifiable on-chain policies",
  "09-agent": "The autonomous agent, with spending limits",
  "10-factory": "Anyone can add cover",
  "11-proof": "Don't trust the page — reproduce it",
};

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "buffer" });

function duration(file) {
  return Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
}

const shell = (css) => `<!doctype html><meta charset="utf-8"><style>${css}</style>`;

function lowerThird(n, total, title) {
  return shell(`
    * { margin:0; box-sizing:border-box; }
    html,body { width:${W}px; height:${H}px; background:transparent; }
    .bar { position:absolute; left:0; right:0; bottom:0; height:118px;
      background:linear-gradient(180deg, rgba(16,37,29,0) 0%, rgba(16,37,29,.86) 42%, rgba(16,37,29,.94) 100%);
      display:flex; align-items:flex-end; padding:0 64px 30px 64px; gap:20px;
      font-family: ui-sans-serif, system-ui, "DejaVu Sans", sans-serif; }
    .mark { position:absolute; left:0; bottom:0; width:6px; height:118px; background:${T.accent}; }
    .rule { position:absolute; left:64px; right:64px; bottom:118px; height:1px; background:rgba(238,243,239,.16); }
    .k { font-family:"DejaVu Sans Mono", monospace; font-size:15px; letter-spacing:.22em;
      text-transform:uppercase; color:${T.gold}; margin-bottom:6px; }
    .t { font-family:"DejaVu Serif", Georgia, serif; font-size:34px; color:${T.onField}; line-height:1.1; }
    .brand { position:absolute; right:64px; bottom:34px; font-family:"DejaVu Sans Mono", monospace;
      font-size:14px; letter-spacing:.16em; color:${T.onField2}; text-transform:uppercase; }
    .col { display:flex; flex-direction:column; }
  `) + `<div class="rule"></div><div class="mark"></div><div class="bar">
      <div class="col"><div class="k">Overcover · ${String(n).padStart(2, "0")} / ${String(total).padStart(2, "0")}</div><div class="t">${title}</div></div>
      <div class="brand">NEAR testnet</div></div>`;
}

function openCard() {
  return shell(`
    * { margin:0; box-sizing:border-box; }
    html,body { width:${W}px; height:${H}px; background:${T.field}; color:${T.onField};
      font-family:"DejaVu Sans", system-ui, sans-serif; }
    .wrap { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; padding:0 110px; }
    .kick { font-family:"DejaVu Sans Mono", monospace; font-size:16px; letter-spacing:.34em;
      text-transform:uppercase; color:${T.gold}; margin-bottom:26px; }
    h1 { font-family:"DejaVu Serif", Georgia, serif; font-weight:700; font-size:112px; letter-spacing:-.02em; line-height:1; }
    .sub { margin-top:26px; font-size:26px; color:${T.onField2}; max-width:24ch; line-height:1.4; }
    .accent { position:absolute; left:110px; top:calc(50% + 168px); width:96px; height:5px; background:${T.accent}; }
  `) + `<div class="wrap"><div class="kick">A parametric risk mutual on NEAR</div><h1>OVERCOVER</h1>
      <div class="sub">Insurance an autonomous agent can buy — without unlimited spending authority.</div></div><div class="accent"></div>`;
}

function closeCard() {
  return shell(`
    * { margin:0; box-sizing:border-box; }
    html,body { width:${W}px; height:${H}px; background:${T.field}; color:${T.onField};
      font-family:"DejaVu Sans", system-ui, sans-serif; }
    .wrap { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center; padding:0 110px; }
    h2 { font-family:"DejaVu Serif", Georgia, serif; font-size:56px; line-height:1.16; max-width:20ch; }
    .mono { margin-top:34px; font-family:"DejaVu Sans Mono", monospace; font-size:19px; color:${T.onField2}; line-height:1.9; }
    .mono b { color:${T.onField}; font-weight:400; }
    .accent { position:absolute; left:110px; top:calc(50% + 176px); width:96px; height:5px; background:${T.accent}; }
    .badge { position:absolute; right:110px; top:96px; font-family:"DejaVu Sans Mono", monospace;
      font-size:14px; letter-spacing:.2em; text-transform:uppercase; color:${T.gold}; }
  `) + `<div class="badge">Overcover</div><div class="wrap">
      <h2>A person and an agent buy the same cover — and both end in a verifiable on-chain policy.</h2>
      <div class="mono"><b>Console</b>  overcover.vercel.app<br><b>Contract</b>  contract.ovc-v3-ctl-2f6c4c.testnet<br><b>Human policy</b>  #${EVIDENCE.policy.id} on ${EVIDENCE.contract} · tx ${EVIDENCE.tx.hash.slice(0, 18)}…<br><b>Proof</b>  npm run verify:proof</div>
      </div><div class="accent"></div>`;
}

async function renderOverlays(browser) {
  fs.rmSync(OVER, { recursive: true, force: true });
  fs.mkdirSync(OVER, { recursive: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const shoot = async (html, file, omitBackground) => {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: file, omitBackground: !!omitBackground });
  };
  await shoot(openCard(), path.join(OVER, "open.png"));
  await shoot(closeCard(), path.join(OVER, "close.png"));
  const ids = Object.keys(TITLES);
  for (let i = 0; i < ids.length; i++) {
    await shoot(lowerThird(i + 1, ids.length, TITLES[ids[i]]), path.join(OVER, `lt-${ids[i]}.png`), true);
  }
  await page.close();
}

/** Composite one scene to `hold` seconds with its lower-third (+ open/close
 *  cards folded into the first and last scenes). */
function compositeScene(scene, manifest, idx, total) {
  const clip = path.join(RAW, scene.file.replace(/^raw\//, ""));
  const lt = path.join(OVER, `lt-${scene.id}.png`);
  const seg = path.join(OUT, `seg-${scene.id}.mp4`);
  const hold = scene.hold;
  const inputs = ["-i", clip, "-loop", "1", "-i", lt];
  const hasLt = fs.existsSync(lt);
  // Normalise the clip, then overlay the lower-third for all but the opening beat.
  let fc = `[0:v]scale=${W}:${H},fps=${FPS},tpad=stop_mode=clone:stop_duration=2,trim=0:${hold.toFixed(3)},setpts=PTS-STARTPTS[base];`;
  if (hasLt) {
    fc += `[1:v]format=rgba,fade=in:st=1.0:d=0.6:alpha=1[lt];[base][lt]overlay=0:0:enable='gte(t,1.0)'[v]`;
  } else {
    fc += `[base]null[v]`;
  }
  const args = ["-y", ...inputs, "-filter_complex", fc, "-map", "[v]",
    "-t", hold.toFixed(3), "-r", String(FPS),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20", seg];
  run(FFMPEG, args);

  // Fold the title/close cards over the first / last scene.
  if (scene.id === "01-open") return overlayCard(seg, path.join(OVER, "open.png"), 0, 4.0, "in", hold);
  if (scene.id === "11-proof") return overlayCard(seg, path.join(OVER, "close.png"), hold - 4.5, 4.5, "out", hold);
  return seg;
}

function overlayCard(seg, card, start, dur, dir, hold) {
  const out = seg.replace(/\.mp4$/, "-card.mp4");
  const fade = dir === "in"
    ? `fade=in:st=0:d=0.4:alpha=1,fade=out:st=${(dur - 0.6).toFixed(2)}:d=0.6:alpha=1`
    : `fade=in:st=0:d=0.6:alpha=1`;
  const enable = dir === "in" ? `lte(t,${dur.toFixed(2)})` : `gte(t,${start.toFixed(2)})`;
  const fc = `[0:v]setpts=PTS-STARTPTS[base];[1:v]format=rgba,${fade}[card];[base][card]overlay=0:0:enable='${enable}'[v]`;
  run(FFMPEG, ["-y", "-i", seg, "-loop", "1", "-i", card, "-filter_complex", fc,
    "-map", "[v]", "-t", hold.toFixed(3), "-r", String(FPS),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20", out]);
  fs.rmSync(seg, { force: true });
  return out;
}

function concatSegments(segs) {
  const listFile = path.join(OUT, "concat.txt");
  fs.writeFileSync(listFile, segs.map((s) => `file '${path.basename(s)}'`).join("\n"));
  const silent = path.join(OUT, "silent.mp4");
  run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent]);
  return silent;
}

function buildAudio(manifest) {
  // One narration track: each line, padded to its scene's hold, concatenated.
  const inputs = [];
  const filters = [];
  manifest.forEach((s, i) => {
    const wav = path.join(AUDIO, `${s.id}.wav`);
    inputs.push("-i", wav);
    const d = duration(wav);
    const pad = Math.max(0, s.hold - d);
    filters.push(`[${i}:a]apad=pad_dur=${pad.toFixed(3)},atrim=0:${s.hold.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const concatIn = manifest.map((_, i) => `[a${i}]`).join("");
  filters.push(`${concatIn}concat=n=${manifest.length}:v=0:a=1,alimiter=limit=0.85,volume=-3dB[aout]`);
  const out = path.join(OUT, "narration.m4a");
  run(FFMPEG, ["-y", ...inputs, "-filter_complex", filters.join(";"), "-map", "[aout]",
    "-c:a", "aac", "-b:a", "160k", out]);
  return out;
}

async function main() {
  if (!fs.existsSync(path.join(RAW, "manifest.json"))) {
    console.error("run `node video/capture.mjs` first");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(RAW, "manifest.json"), "utf8")).scenes;

  const browser = await chromium.launch({ executablePath: EXEC });
  await renderOverlays(browser);
  await browser.close();
  console.log("overlays rendered");

  const segs = manifest.map((s, i) => compositeScene(s, manifest, i, manifest.length));
  console.log(`composited ${segs.length} scenes`);

  const silent = concatSegments(segs);
  const audio = buildAudio(manifest);

  const mp4 = path.join(OUT, "overcover-demo.mp4");
  run(FFMPEG, ["-y", "-i", silent, "-i", audio, "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest",
    "-movflags", "+faststart", mp4]);
  const webm = path.join(OUT, "overcover-demo.webm");
  run(FFMPEG, ["-y", "-i", silent, "-i", audio, "-map", "0:v", "-map", "1:a",
    "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k", "-shortest", webm]);
  run(FFMPEG, ["-y", "-i", mp4, "-ss", "0.6", "-frames:v", "1", path.join(OUT, "poster.png")]);

  for (const f of [mp4, webm]) {
    console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB  ${duration(f).toFixed(1)}s`);
  }
  // Keep the working tree clean: drop intermediates.
  fs.rmSync(silent, { force: true });
  fs.rmSync(audio, { force: true });
  fs.rmSync(path.join(OUT, "concat.txt"), { force: true });
  segs.forEach((s) => fs.rmSync(s, { force: true }));
  console.log(`\nwrote ${mp4}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
