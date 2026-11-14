# Video QA report — Overcover company film

Independent verification of the finished film, run after the final render. Nothing here is asserted
from the render log; every item is measured from the shipped file.

## Final files and SHA-256

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `video/company/out/overcover-company-film.mp4` (master) | 51,792,307 | `b5009b5b3c318a743784e27893cfb6dd586625c70bbd63a09ddd6bc854f28000` |
| `video/company/out/overcover-company-film-web.mp4` (web) | 22,095,322 | `8d391207cfd59213312ecb9d55880ea4f376f167bffc30e707969f50f1e03284` |
| `video/company/out/poster.png` | 158,351 | `87ef3b55e2fb2e8372c42072c04eceae7a515fafc7543d7acf8f014cc62f21b0` |

## Technical metadata (ffprobe)

| Property | Master | Web |
| --- | --- | --- |
| Container / video codec | MP4 / H.264 (High) | MP4 / H.264 (High, level 4.1) |
| Resolution | 1920×1080 | 1920×1080 |
| Frame rate | 30/1 | 30/1 |
| Duration | 153.100 s (2:33) | 153.100 s (2:33) |
| Overall bit rate | 2,706 kbps | 1,155 kbps |
| Audio | AAC-LC, **stereo**, 48,000 Hz | AAC-LC, **stereo**, 48,000 Hz |
| `+faststart` | yes | yes |

## Check results

| # | Check | Method | Result |
| --- | --- | --- | --- |
| 1 | Full decode, no corruption | `ffmpeg -v error -i master -f null -` | **clean** (no error output, exit 0) |
| 2 | No black frames | `blackdetect=d=0.3:pix_th=0.10` | **0** black segments |
| 3 | Loudness (EBU R128) | `loudnorm=print_format=summary` | Integrated **−15.6 LUFS**, True Peak **−1.0 dBTP**, LRA 3.2 LU |
| 4 | Stereo audio | ffprobe channel layout | **stereo** (2 ch) both files |
| 5 | Audio present in every scene | `volumedetect` per scene window | mean −17.9 to −19.4 dB in all 7 scenes |
| 6 | No unintended silence | `silencedetect=n=-45dB:d=1.2` | only 2 gaps (1.33 s, 1.35 s) — both at scene crossfades |
| 7 | Scene order matches storyboard | per-frame perceptual-hash vs sources | exact order; see timeline below |
| 8 | Card scenes show the intended card | aHash distance to source card | 0–8 / 256 (≈identical) |
| 9 | Close card appears at the end | aHash vs `close.png` | dist 1/256 for t = 146–152 s |
| 10 | No blank/error frames | luminance variance of 14 source frames | all > 150 variance, 280–755 colours |
| 11 | Text legibility on mobile | font px × (390/1920) | headline ≥ 13 px; small labels ≈ 4 px (see note) |

## Frame-to-source timeline (measured, collapsed)

```
CARD:open          1.5– 7.5s     CARD:security     84.0– 93.0s
FRAME:01-hero      9.0–16.5s     FRAME:08-obs      94.5– 99.0s
FRAME:02-cover    18.0–22.5s     FRAME:13-status  100.5–106.5s
FRAME:03-products 24.0–28.5s     FRAME:11-figs    108.0–112.5s
FRAME:04-how      30.0–36.0s     CARD:architecture114.0–124.5s
CARD:near         37.5–43.5s     FRAME:09-factory 126.0–132.0s
FRAME:12-proof    45.0–51.0s     FRAME:10-agent   133.5–135.0s
FRAME:11-figs     52.5–58.5s     FRAME:01-hero    139.5–144.0s
CARD:lifecycle    60.0–66.0s     CARD:close       145.5–151.5s
FRAME:04-how      67.5–72.0s
FRAME:07-policies 73.5–76.5s
FRAME:08-obs      78.0–82.5s
```
(The 136.5 s sample is the 0.5 s crossfade between scenes 06 and 07; it matches no single source.)

## Narrated claims vs the running product

Each scene was reviewed against the actual implementation. The narration and on-screen text were
cross-checked against `reports/VIDEO_CLAIM_VERIFICATION.md`. No claim is made that is not backed by
the live chain, the committed source, or the reproducible `verify:proof` checks. In particular the
film does **not** claim an audit, endorsement, users, revenue, or that the TEE layer is deployed.

## Honest limitations of this QA

- **Not watched by a human eye.** The reviewer environment renders images to an artifact stream but
  does not expose them to the reviewer, so the visual checks here are **programmatic** (decode
  integrity, black-frame detection, perceptual-hash scene matching, luminance/colour variance,
  loudness, and font-size scaling). A human should still watch the master end-to-end before release.
- **Mobile legibility.** At 1920→390 px the largest text stays comfortably legible (≥13 px) but the
  smallest card labels scale to ≈4 px on a phone. The film is authored for a 16:9 screen (investor
  decks, laptops, conference displays); on a phone in portrait the small labels are not readable.
  This is a deliberate composition trade-off, not an oversight.
- **Music.** The bed is generated procedurally (sine partials) rather than a licensed commercial
  track, so there is no licensing risk; it is intentionally minimal.
- **Narration.** Synthesised with Piper (`en_US-lessac-medium`). It is clear and correctly paced but
  is not a human voice actor. A human voiceover can be dropped into `remux.mjs` without a re-render.

## How to reproduce

```bash
cd video/company
node capture-frames.mjs    # live console screenshots
node cards.mjs             # designed cards
node build.mjs             # narration + render + mux
node qa.mjs                # writes out/qa.json
ffprobe -v error -show_format -show_streams out/overcover-company-film.mp4
```
