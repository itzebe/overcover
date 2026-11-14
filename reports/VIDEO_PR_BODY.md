# PR body — feat/overcover-company-film → main

Copy the block below into the pull request. Base: `main`. Head: `feat/overcover-company-film`
(`10b4b57ee26373edfa1c5f6d24d693f0f7a73060`).

---

## What this adds

A **~2 min 33 s, 1920×1080, 30 fps, stereo** narrated company film for institutional and technical
audiences — built entirely from the **live production console** and HTML-rendered cards, with every
on-screen and narrated claim mapped to evidence.

This is a **new, focused PR** (a single commit on `main`). It contains no product-code changes.

## Deliverables

| Path | What it is |
| --- | --- |
| `video/company/out/overcover-company-film-web.mp4` | The film, web-optimised (1920×1080, stereo AAC) |
| `video/company/out/poster.png` | 1920×1080 poster frame |
| `video/company/scenes.mjs` | Single source of truth: narration + shot list |
| `video/company/{capture-frames,cards,build,remux,qa}.mjs` | Reproducible pipeline |
| `video/company/out/qa.json` | Machine-readable QA (hashes, codecs, loudness) |
| `reports/VIDEO_STORYBOARD.md` | Creative direction + shot-by-shot script |
| `reports/VIDEO_CLAIM_VERIFICATION.md` | Every claim → its evidence, + an explicit "not claimed" table |
| `reports/VIDEO_QA_REPORT.md` | Independent QA of the shipped file |
| `reports/VIDEO_HUMAN_ACTIONS_REQUIRED.md` | The two human/external items outstanding |

The **51 MB master** (`overcover-company-film.mp4`) is git-ignored (regenerable); its path and
SHA-256 are recorded in `reports/VIDEO_QA_REPORT.md`.

## How the film is made

```mermaid
flowchart LR
  A[Live console<br/>overcover.vercel.app] -->|capture-frames.mjs| F[frames/]
  H[HTML cards<br/>console palette] -->|cards.mjs| C[cards/]
  S[scenes.mjs<br/>narration + shots] --> B[build.mjs]
  F --> B
  C --> B
  B -->|Piper TTS + ffmpeg| O[out/*.mp4]
  O --> Q[qa.mjs]
```

Narration length drives picture length: each scene is synthesised first, then its shots are rendered
with a slow Ken-Burns move and crossfaded. Change the film by editing `scenes.mjs` and re-running the
pipeline.

## Verification (independently measured from the shipped file)

| Check | Result |
| --- | --- |
| Full decode | clean, exit 0, no error output |
| Black frames | **0** |
| Loudness (EBU R128) | **−15.6 LUFS**, True Peak −1.0 dBTP |
| Audio | **stereo**, 48 kHz, present in all 7 scenes |
| Scene order | matches the storyboard (perceptual-hash timeline) |
| Card scenes | aHash distance 0–8/256 to the intended card |

- **Master** `b5009b5b…f28000` · **Web** `8d391207…e03284` · **Poster** `87ef3b55…2f21b0`
- Reproduce: `cd video/company && node capture-frames.mjs && node cards.mjs && node build.mjs && node qa.mjs`

## Honesty

- Product footage is the **live console**; figures are read from `contract.ovc-v3-ctl-2f6c4c.testnet`.
- The film states the deployment is **NEAR testnet** and **unaudited**.
- The attestation/TEE layer is described as a **prototype**, and the film states that execution
  integrity is not proof that an observation is true.
- **No** endorsement, funding, partnership, user count, revenue or capital-under-management is claimed.
- `reports/VIDEO_CLAIM_VERIFICATION.md` lists the claims deliberately **not** made, and why.

## Limitations (honest)

- The QA is **programmatic**; a human should still watch the master end-to-end before release.
- Authored for a 16:9 screen. On a 390 px phone the smallest card labels scale to ≈4 px and are not
  readable — a deliberate composition trade-off.
- Narration is synthesised (Piper `en_US-lessac-medium`), not a human voice actor.

## Not touched

- No change to `contract/`, `driver/`, `ui/`, `agent/`, tests, or deployment config.
- PR #39 and PR #51 are left as-is.

---

_This PR was created by an AI agent (OpenHands) on behalf of the repository owner._
