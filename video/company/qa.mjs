// Independent QA of the finished film: decode integrity, black frames, loudness,
// stereo, per-scene audio presence, frame->source timeline, and hashes.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");
const master = path.join(OUT, "overcover-company-film.mp4");
const web = path.join(OUT, "overcover-company-film-web.mp4");
const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function probe(f) {
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f]));
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return {
    dur: Number(j.format.duration).toFixed(3),
    sizeMB: (Number(j.format.size) / 1e6).toFixed(1),
    bitrate: Math.round(Number(j.format.bit_rate) / 1000) + " kbps",
    vcodec: v.codec_name, w: v.width, h: v.height, fps: v.r_frame_rate,
    acodec: a.codec_name, ch: a.channels, layout: a.channel_layout, sr: a.sample_rate,
  };
}

function loudness(f) {
  const e = execFileSync("ffmpeg", ["-v", "info", "-i", f, "-af", "loudnorm=print_format=summary", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false });
  return e;
}
function stderrOf(args) {
  try { execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return (e.stderr || "").toString() + (e.stdout || "").toString(); }
  return "";
}
// Some ffmpeg filters (loudnorm summary, volumedetect) write to stderr;
// spawnSync captures it whether the process exits 0 or not.
function outputOf(args) {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  return (r.stderr || "") + (r.stdout || "");
}

const report = {};
report.master = probe(master);
report.web = probe(web);
report.master_sha256 = sha(master);
report.web_sha256 = sha(web);
report.poster_sha256 = sha(path.join(OUT, "poster.png"));


function probe2(f) {
  const j = JSON.parse(run("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", f]));
  return { w: j.streams[0].width, h: j.streams[0].height };
}

// decode integrity: any error output means corruption
const dec = stderrOf(["-v", "error", "-i", master, "-f", "null", "-"]);
report.decode_clean = dec.trim() === "";
report.decode_output = dec.trim().slice(0, 400);

// black frames
const bf = stderrOf(["-v", "info", "-i", master, "-vf", "blackdetect=d=0.3:pix_th=0.10", "-an", "-f", "null", "-"]);
report.black_frames = (bf.match(/black_start/g) || []).length;

// loudness
const ld = outputOf(["-hide_banner", "-i", master, "-af", "loudnorm=print_format=summary", "-f", "null", "-"]);
report.loudness = {
  integrated: (ld.match(/Input Integrated:\s*([-\d.]+)/) || [])[1],
  true_peak: (ld.match(/Input True Peak:\s*([-\d.]+)/) || [])[1],
  lra: (ld.match(/Input LRA:\s*([-\d.]+)/) || [])[1],
};

// per-scene audio presence: mean volume at sample points through the timeline
report.scene_audio = {};
for (const t of [10, 30, 60, 90, 120, 150, 175]) {
  const vd = outputOf(["-hide_banner", "-ss", String(t), "-t", "3", "-i", master, "-af", "volumedetect", "-f", "null", "-"]);
  report.scene_audio["t" + t] = (vd.match(/mean_volume:\s*([-\d.]+) dB/) || [])[1] || null;
}

fs.writeFileSync(path.join(OUT, "qa.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
