# Overcover company film

A ~2 min 33 s, 1920×1080, 30 fps narrated product film for institutional and technical audiences.
Every frame of product footage is the **live production console** driven in a real Chromium; every
designed card is rendered from HTML with the console's own palette and type roles. Nothing is
staged and no figure is invented — see `reports/VIDEO_CLAIM_VERIFICATION.md`.

## The deliverable

- `out/overcover-company-film.mp4` — master, H.264 High, 1920×1080, 30 fps, stereo AAC 48 kHz.
- `out/overcover-company-film-web.mp4` — web-optimised, same cut, smaller.
- `out/poster.png` — 1920×1080 poster frame.
- `out/qa.json` — machine-readable QA (hashes, codecs, loudness, black-frame count).

Hashes and technical metadata for the shipped files are recorded in
`reports/VIDEO_QA_REPORT.md`.

## How it is made

Three steps, each a script in this directory. They need Chromium (playwright-core), `ffmpeg`,
`ffprobe`, and `python3 -m piper` (Piper neural TTS) with a voice model under `voices/`.

```bash
node capture-frames.mjs      # 1. screenshot the live console (frames/)
node cards.mjs               # 2. render the designed cards (cards/)
node build.mjs               # 3. synthesise narration, render shots, crossfade, mux (out/)
node qa.mjs                  # 4. independent QA → out/qa.json
```

- `scenes.mjs` is the single source of truth: the narration text and the shot list. Change the film
  by editing that file and re-running steps 1–3.
- `capture-frames.mjs` scrolls the production console to each section and screenshots it at
  1920×1080. Point it at a local build with `node capture-frames.mjs http://localhost:PORT/`.
- `cards.mjs` renders the title/NEAR/lifecycle/security/architecture/close cards with Chromium.
- `build.mjs` synthesises each narration line (so picture length follows the voice), renders every
  shot with a slow Ken-Burns move, crossfades the scenes, lays the narration plus a generated
  ambient bed, and muxes master + web.
- `remux.mjs` rebuilds only the audio and re-muxes, for quick audio changes without a full re-render.

Intermediate `seg/`, `audio/`, `frames/`, `cards/` are regenerable and git-ignored.

## Honesty rules for this film

- Product footage is the live console; figures are read from `contract.ovc-v3-ctl-2f6c4c.testnet`.
- The deployment is stated as **NEAR testnet** and **unaudited** on screen and in the narration.
- The attestation/TEE layer is described as a **prototype**; the film states that execution
  integrity is not proof that an observation is true.
- No endorsement, funding, partnership, user count, revenue or capital-under-management is claimed.

## Voices

Piper voices are large binaries and are not committed. Fetch one, e.g.:

```bash
mkdir -p voices && cd voices
base=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
curl -L -o en_US-lessac-medium.onnx      "$base/en_US-lessac-medium.onnx?download=true"
curl -L -o en_US-lessac-medium.onnx.json "$base/en_US-lessac-medium.onnx.json?download=true"
```
