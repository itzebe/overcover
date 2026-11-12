# Judge-demo video

A 2–3 minute, narrated walkthrough of the shipped product. Every frame is the **live production
console** driven in a real Chromium; every number on screen is read from the contract by the page
itself. Nothing is staged, and no transaction is faked — the wallet scene shows the real approval
surface, and the on-chain evidence the narration cites is the same evidence `docs/JUDGE_DEMO.md`
lists.

## The deliverable

- `out/overcover-demo.mp4` — H.264/AAC, 1600×900, ~2:57, with narration. **This is the file to submit.**
- `out/overcover-demo.webm` — VP9/Opus, same cut (regenerated locally; not committed).
- `out/poster.png` — opening-frame still.

## How it is made

Two scripts, both in this directory. They need Chromium, `ffmpeg`, `ffprobe` and `espeak-ng`.

```bash
node video/capture.mjs                  # record one clip per scene from production
node video/capture.mjs <url> <ids>      # record a subset, e.g. "04-quote" (url may be a local file)
node video/build.mjs                    # render overlays, composite, narrate, mux → out/
```

`capture.mjs` holds the narration for each scene as plain text. It synthesises that line to speech,
measures it, and holds the recorded clip for exactly that length plus a short pad — so the picture
and the voice cannot drift apart. `build.mjs` renders the on-brand title cards and lower-thirds with
Chromium (crisp type, the console's own palette), composites them over the clips, concatenates the
scenes, lays the narration underneath, and muxes the result. Both scripts are deterministic: the
same source produces the same cut.

The scene list, titles and narration are the single source of truth in `capture.mjs`. To change the
video, edit that file and re-run both scripts.

## Honesty rules for this video

- The console footage is real and live. If a scene depends on something a headless browser cannot
  do — an extension-based wallet approval — the narration says so and the wallet step is shown as
  the approval **surface**, not as a completed signature. The human purchase that was actually
  signed is the one recorded in `docs/JUDGE_DEMO.md` (hash
  `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`).
- No transaction is simulated, no balance is invented, no policy is fabricated. Every policy shown
  is read from `contract.ovc-v3-ctl-2f6c4c.testnet`.

## Regenerating

The committed deliverable is the `out/overcover-demo.mp4` above. Raw captures and intermediates
(`raw/`, `audio/`, `overlays/`) are git-ignored — they are large and fully regenerable from the two
scripts.
