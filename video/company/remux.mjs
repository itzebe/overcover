// Rebuild ONLY the audio (stereo) and re-mux, reusing the rendered silent video
// and the already-synthesised narration WAVs. Avoids a full re-render.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "./scenes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO = path.join(__dirname, "audio");
const OUT = path.join(__dirname, "out");
const FADE = 0.5, LEAD = 0.7, TAIL = 1.0, FPS = 30;
const ff = (a) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...a], { stdio: ["ignore", "inherit", "inherit"] });
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());

const scenes = SCENES.map((s) => {
  const nd = dur(path.join(AUDIO, `${s.id}.wav`));
  return { id: s.id, nd, d: LEAD + nd + TAIL };
});
const N = scenes.length;
const silent = path.join(OUT, "video-silent.mp4");
const total = dur(silent);

const music = path.join(AUDIO, "music.wav");
const aInputs = [...scenes.map((s) => path.join(AUDIO, `${s.id}.wav`)), music];
const aArgs = aInputs.flatMap((f) => ["-i", f]);
let delay = 0, afc = "";
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
ff([...aArgs, "-filter_complex", afc, "-map", "[aout]", "-c:a", "aac", "-b:a", "224k", "-ar", "48000", "-ac", "2", mix]);
console.log("audio mix (stereo):", dur(mix).toFixed(2), "s");

const master = path.join(OUT, "overcover-company-film.mp4");
ff(["-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "224k", "-movflags", "+faststart", "-shortest", master]);
const web = path.join(OUT, "overcover-company-film-web.mp4");
ff(["-i", silent, "-i", mix, "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.1", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart", "-shortest", web]);
ff(["-i", master, "-ss", "3.0", "-frames:v", "1", path.join(OUT, "poster.png")]);
for (const f of [master, web]) console.log(`${path.basename(f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB  ${dur(f).toFixed(1)}s`);
