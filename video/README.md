# Judge-demo video

A 2–3 minute, narrated walkthrough of the shipped product. Every frame is the **live production
console** driven in a real Chromium; every number on screen is read from the contract by the page
itself. Nothing is staged, and no transaction is faked — the wallet scene shows the real approval
surface, and the on-chain evidence the narration cites is the same evidence `docs/JUDGE_DEMO.md`
lists.

## The deliverable

- `out/overcover-demo.mp4` — H.264/AAC, 1920×1080, ~2:58, with narration. **This is the file to submit.**
- `out/overcover-demo.webm` — VP9/Opus, same cut (regenerated locally; not committed).
- `out/poster.png` — opening-frame still.

## How it is made

Three steps. They need Chromium, `ffmpeg`, `ffprobe` and `espeak-ng`.

```bash
node video/verify-human-purchase.mjs    # re-read the human purchase from RPC → evidence/*.json
node video/render-evidence.mjs          # render the verified panel → evidence/human-panel.html
node video/capture.mjs                  # record one clip per scene from production
node video/capture.mjs <url> <ids>      # record a subset, e.g. "06-human" (url may be a local file)
node video/build.mjs                    # render overlays, composite, narrate, mux → out/
```

`verify-human-purchase.mjs` re-fetches the recorded human purchase and its policy from NEAR testnet
RPC on every run and re-derives six checks (the call succeeded, the buyer is the signer, the deposit
covers the premium, …). `render-evidence.mjs` turns that JSON into the on-screen evidence panel, so
the video can only ever show numbers the chain actually returned — the panel scene is not a
screenshot. `build.mjs` refuses to run if the evidence file is missing.

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
  `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`), and scene `06-human`/`07-human-policy` present it
  as a **verified, recorded** transaction with the contract it was signed against stated plainly.
- No transaction is simulated, no balance is invented, no policy is fabricated. Every policy shown
  is read from `contract.ovc-v3-ctl-2f6c4c.testnet` (or, for the recorded human policy, from
  `contract.attestor-overcover.testnet`, labelled as such).

## Regenerating

The committed deliverable is the `out/overcover-demo.mp4` above. Raw captures and intermediates
(`raw/`, `audio/`, `overlays/`) are git-ignored — they are large and fully regenerable from the two
scripts. `evidence/human-purchase.json` is committed so the panel scene is reproducible offline;
re-run `verify-human-purchase.mjs` to refresh it against the live chain.
