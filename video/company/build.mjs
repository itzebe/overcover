// Build the Overcover company film.
//
//   1. Synthesise each scene's narration (Piper neural TTS) and measure it.
//   2. Render every shot (designed card or live console frame) to a 1920x1080
//      30fps segment with a slow Ken-Burns move.
//   3. Concatenate shots per scene, crossfade the scenes, lay the narration and
//      a generated ambient bed underneath, and mux to master + web MP4.
//
//   node build-video.mjs
//
// Requires: ffmpeg, ffprobe, python3 -m piper, Chromium (playwright-core).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "./scenes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30;
const FADE = 0.5;          // crossfade between scenes (s)
const LEAD = 0.7;          // narration starts this far into its scene
const TAIL = 1.0;          // held silence after narration ends
const VOICE = path.join(__dirname, "voices/en_US-lessac-medium.onnx");
const AUDIO = path.join(__dirname, "audio");
const SEG = path.join(__dirname, "seg");
const OUT = path.join(__dirname, "out");
const SRC = __dirname;
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(SEG, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const ff = (args, opts = {}) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"], ...opts });
const dur = (f) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());

// ---- 1. narration -----------------------------------------------------------
function synthNarration(scene) {
  const wav = path.join(AUDIO, `${scene.id}.wav`);
  execFileSync("python3", ["-m", "piper", "-m", VOICE, "-f", wav], { input: scene.narrate + "\n" });
  return dur(wav);
}

// ---- 2. Ken-Burns segment ---------------------------------------------------
function renderShot(scene, shot, i, sec) {
  const frames = Math.max(1, Math.round(sec * FPS));
  const out = path.join(SEG, `${scene.id}-${i}.mp4`);
  let src, isCard;
  if (shot.card) { src = path.join(__dirname, "cards", `${shot.card}.png`); isCard = true; }
  else { src = path.join(SRC, shot.img); isCard = false; }
  if (!fs.existsSync(src)) throw new Error("missing source " + src);

  // Ken-Burns: zoom/pan expressed as fractions of the (over-)scaled frame.
  const kb = shot.kb || { z: [1.0, 1.0], x: [0.5, 0.5], y: [0.5, 0.5] };
  const [z0, z1] = kb.z, [x0, x1] = kb.x, [y0, y1] = kb.y;
  // Pre-scale to 3x so sub-pixel motion is smooth; zoompan works in that space.
  const SCALE_W = W * 3, SCALE_H = H * 3;
  // For cards we keep them perfectly steady (no motion) to preserve type crispness.
  const zExpr = isCard ? "1.0" : `${z0}+(${z1}-${z0})*on/${frames}`;
  const xExpr = isCard ? "(iw-iw/zoom)/2" : `(${x0}+(${x1}-${x0})*on/${frames})*(iw-iw/zoom)`;
  const yExpr = isCard ? "(ih-ih/zoom)/2" : `(${y0}+(${y1}-${y0})*on/${frames})*(ih-ih/zoom)`;
  const vf =
    `scale=${SCALE_W}:${SCALE_H}:force_original_aspect_ratio=increase,` +
    `crop=${SCALE_W}:${SCALE_H},` +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${W}x${H}:fps=${FPS},` +
    `setsar=1,format=yuv420p`;

  ff(["-loop", "1", "-i", src, "-t", sec.toFixed(3), "-vf", vf,
      "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-pix_fmt", "yuv420p", "-t", sec.toFixed(3), out]);
  return out;
}

function concatShots(segFiles, out) {
  const list = path.join(SEG, "list-" + path.basename(out) + ".txt");
  fs.writeFileSync(list, segFiles.map((s) => `file '${s}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
  fs.rmSync(list, { force: true });
  return out;
}

// ---- 3. ambient music bed ---------------------------------------------------
function buildMusic(total, out) {
  // A slow A-minor pad: four sine partials, gentle tremolo, soft echo tail.
  const parts = [110.00, 164.81, 220.00, 261.63, 329.63];
  const inputs = parts.flatMap((f) => ["-f", "lavfi", "-t", total.toFixed(2), "-i", `sine=frequency=${f}:sample_rate=44100`]);
  const labels = parts.map((_, i) => `[${i}:a]`).join("");
  const fc =
    `${labels}amix=inputs=${parts.length}:normalize=1[m0];` +
    `[m0]tremolo=f=0.12:d=0.35,lowpass=f=900,highpass=f=70,` +
    `aecho=0.8:0.9:600|1200:0.25|0.15,` +
    `afade=in:st=0:d=4,afade=out:st=${(total - 5).toFixed(2)}:d=5,` +
    `volume=0.5[aout]`;
  ff([...inputs, "-filter_complex", fc, "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "44100", out]);
  return out;
}

// ---- 4. assemble ------------------------------------------------------------
async function main() {
  // narration + per-scene segment rendering
  const scenes = [];
  for (const s of SCENES) {
    const nd = synthNarration(s);
    const D = LEAD + nd + TAIL;
    const weight = s.shots.reduce((a, sh) => a + sh.sec, 0);
    const shots = [];
    let acc = 0;
    s.shots.forEach((sh, i) => {
      // last shot absorbs rounding so shot durations sum exactly to D
      let sec = (sh.sec / weight) * D;
      if (i === s.shots.length - 1) sec = D - acc;
      else sec = Math.round(sec * 1000) / 1000;
      acc += sec;
      shots.push({ file: renderShot(s, sh, i, sec), sec });
      process.stdout.write(`  ${s.id} shot ${i + 1}/${s.shots.length} ${sec.toFixed(2)}s\r`);
    });
    const seg = concatShots(shots.map((x) => x.file), path.join(SEG, `${s.id}.mp4`));
    const d = dur(seg);
    scenes.push({ ...s, nd, D, seg, d });
    console.log(`${s.id}: narration ${nd.toFixed(2)}s · scene ${d.toFixed(2)}s`);
  }

  // crossfade the scene segments (video)
  const N = scenes.length;
  const inputs = scenes.flatMap((s) => ["-i", s.seg]);
  let fc = "";
  let cur = "[0:v]";
  let cum = scenes[0].d;
  for (let i = 1; i < N; i++) {
    const off = cum - FADE;
    const out = i === N - 1 ? "[vout]" : `[v${i}]`;
    fc += `${cur}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${off.toFixed(3)}${out};`;
    cur = out;
    cum = off + scenes[i].d;
  }
  fc = fc.replace(/;$/, "");
  const silent = path.join(OUT, "video-silent.mp4");
  ff([...inputs, "-filter_complex", fc, "-map", "[vout]",
      "-r", String(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-pix_fmt", "yuv420p", silent]);
  const total = dur(silent);
  console.log(`silent video: ${total.toFixed(2)}s`);

  // narration placed at each scene's start in the final timeline
  const music = buildMusic(total, path.join(AUDIO, "music.wav"));
  const aInputs = [...scenes.map((s) => path.join(AUDIO, `${s.id}.wav`)), music];
  const aArgs = aInputs.flatMap((f) => ["-i", f]);
  let delay = 0;
  let afc = "";
  scenes.forEach((s, i) => {
    const ms = Math.round((delay + LEAD) * 1000);
    afc += `[${i}:a]adelay=${ms}|${ms},volume=1.0[n${i}];`;
    delay += s.d - FADE;
  });
  const narr = scenes.map((_, i) => `[n${i}]`).join("");
  afc += `${narr}amix=inputs=${N}:normalize=0,pan=stereo|c0=c0|c1=c0[narr];`;
  afc += `[${N}:a]volume=0.22,aformat=channel_layouts=stereo,extrastereo=m=1.4[mus];`;
  afc += `[narr][mus]amix=inputs=2:normalize=0[mix];`;
  afc += `[mix]loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.95[aout]`;
  const mix = path.join(OUT, "mix.m4a");
  ff([...aArgs, "-filter_complex", afc, "-map", "[aout]", "-c:a", "aac", "-b:a", "224k", "-ar", "48000", mix]);

  // mux master + web
  const master = path.join(OUT, "overcover-company-film.mp4");
  ff(["-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "224k", "-movflags", "+faststart", "-shortest", master]);
  const web = path.join(OUT, "overcover-company-film-web.mp4");
  ff(["-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p",
      "-profile:v", "high", "-level", "4.1", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", "-shortest", web]);

  ff(["-i", master, "-ss", "3.0", "-frames:v", "1", path.join(OUT, "poster.png")]);
  for (const f of [master, web]) console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB  ${dur(f).toFixed(1)}s`);
  console.log("master:", master);
}
main().catch((e) => { console.error(e); process.exit(1); });
