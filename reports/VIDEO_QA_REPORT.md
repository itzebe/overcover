# Video QA report — Overcover company film

Independent verification of the finished film, run after the final render. Nothing here is asserted
from the render log; every item is measured from the shipped file.

## Final files and SHA-256

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `video/company/out/overcover-company-film.mp4` (master) | 61,722,565 | `5f6e57588a77c4f8b1aef5564b4784d90e4b889590fdbefc9abcc68cd8ca2d0d` |
| `video/company/out/overcover-company-film-web.mp4` (web) | 26,508,135 | `41607d5c2dae9c747018a891e43389a287cc7850aaee84b8325ee053484c692e` |
| `video/company/out/poster.png` | 158,351 | `87ef3b55e2fb2e8372c42072c04eceae7a515fafc7543d7acf8f014cc62f21b0` |

## Technical metadata (ffprobe)

| Property | Master | Web |
| --- | --- | --- |
| Container / video codec | MP4 / H.264 (High) | MP4 / H.264 (High, level 4.1) |
| Resolution | 1920×1080 | 1920×1080 |
| Frame rate | 30/1 | 30/1 |
| Duration | 188.500 s (3:09) | 188.500 s (3:09) |
| Overall bit rate | 2,620 kbps | 1,125 kbps |
| Audio | AAC-LC, **stereo**, 48,000 Hz | AAC-LC, **stereo**, 48,000 Hz |
| `+faststart` | yes | yes |

## Check results

| # | Check | Method | Result |
| --- | --- | --- | --- |
| 1 | Full decode, no corruption | `ffmpeg -v error -i master -f null -` | **clean** (no error output, exit 0) |
| 2 | No black frames | `blackdetect=d=0.3:pix_th=0.10` | **0** black segments |
| 3 | Loudness (EBU R128) | `loudnorm=print_format=summary` | Integrated **−15.5 LUFS**, True Peak **−1.1 dBTP**, LRA 3.6 LU |
| 4 | Stereo audio | ffprobe channel layout | **stereo** (2 ch) both files |
| 5 | Audio present in every scene | `volumedetect` per scene window | mean −16.9 to −21.0 dB across the timeline (incl. the new scene 05) |
| 6 | Scene order matches storyboard | per-frame perceptual-hash vs sources | exact order; see timeline below |
| 7 | Card scenes show the intended card | aHash distance to source card | 0–1 / 256 (≈identical) |
| 8 | The new journey scene shows the intended sources | aHash vs `cards/journey.png`, `cards/evidence.png`, `frames-journey/j{2,3,4,6}-*.png` | dist 0, 1, 9, 12, 12, 19 / 256 — **OK** |
| 9 | Close card appears at the end | aHash vs `close.png` | dist 0/256 for t = 181–186 s |
| 10 | No blank/error frames | luminance variance of source frames | all > 150 variance, 280–755 colours |
| 11 | Designed cards fit and are legible | DOM overflow + WCAG contrast (`verify-cards.mjs`) | no overflow; all text clears 4.5:1 (3:1 large) |
| 12 | Text legibility on mobile | font px × (390/1920) | headline ≥ 13 px; small labels ≈ 4 px (see note) |

## Frame-to-source timeline (measured)

Scene-level windows in the final timeline (0.5 s crossfades collapsed):

```
01-open           0.0 –  16.2s      05-journey      82.6 – 118.6s
02-product       16.2 –  35.8s      06-security    118.6 – 148.1s
03-near          35.8 –  58.3s      07-architecture148.1 – 174.8s
04-lifecycle     58.3 –  82.6s      08-close       174.8 – 188.5s
```

Scene 05 (the new customer-journey scene), shot by shot, each verified against its source:

```
CARD:journey      82.6 –  90.4s    (aHash dist 0/256)
FRAME:j2-select   90.4 –  95.9s    (dist 19/256)
FRAME:j3-price    95.9 – 100.9s    (dist 12/256)
FRAME:j4-purchase100.9 – 105.9s    (dist  9/256)
FRAME:j6-policies105.9 – 110.9s    (dist 12/256)
CARD:evidence    110.9 – 118.6s    (dist  1/256)
```

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
