# Human / external-authority actions required

Two items need a human or an external authority. Everything else in this delivery is complete and
verifiable without them.

## 1. Refresh the GitHub API token — PR could not be opened automatically

**Status:** the branch is pushed; the pull request could not be opened by the agent.

**What works**
- SSH push works via the deploy key bound to `itzebe/overcover`
  (`git@github.com:itzebe/overcover.git`, key at `/workspace/credentials/overcover/overcover_deploy`).
- The branch is on the remote:
  `feat/overcover-company-film` = `10b4b57ee26373edfa1c5f6d24d693f0f7a73060` (single commit on `main`).

**What is blocked**
- The GitHub REST/GraphQL API rejects the configured credentials:
  - `GITHUB_TOKEN` → HTTP 401 `Bad credentials` (prefix `ghu_`, length 40).
  - `OH_GIT_CREDENTIAL_ACCESS_TOKEN_GITHUB` → HTTP 401.
  - The `git-credential-helper` returns the same rejected token.
  - `gh api user` / `gh pr create` → HTTP 401.
- With a dead API token, no tool can create the PR; the authenticated web UI is also unavailable.

**Action (choose one)**
1. Refresh `GITHUB_TOKEN` (needs `repo` scope) and re-run the PR step; or
2. Open the PR manually:
   <https://github.com/itzebe/overcover/pull/new/feat/overcover-company-film>

   Use base `main`, head `feat/overcover-company-film`. The PR body is provided verbatim in
   `reports/VIDEO_PR_BODY.md` in this branch.

## 2. Watch the master film end-to-end

The QA in `reports/VIDEO_QA_REPORT.md` is **programmatic** (decode integrity, black-frame detection,
perceptual-hash scene matching, EBU R128 loudness, font-size scaling). The reviewer environment used
to build the film cannot display images to the reviewer, so **no human has watched the film frame by
frame**. Before publishing the film externally, a person should watch the master
(`video/company/out/overcover-company-film.mp4`, SHA-256 `b5009b5b…f28000`) end-to-end and confirm
pacing and tone.

## Not required, but noted

- **Voice.** Narration is synthesised (Piper `en_US-lessac-medium`). A human voiceover can be
  substituted in `remux.mjs` without re-rendering the picture.
- **Mobile.** The film is composed for 16:9; small card labels are not readable at 390 px width.
  This is a deliberate trade-off, not a defect.

## Explicitly NOT done (by design — no authority, or would be dishonest)

- No change to the production contract, no deploy, no merge.
- PR #39 and PR #51 were not modified, merged, or closed.
- No mainnet contract deployed; no production funds used.
- No claim of a professional audit, endorsement, funding, or partnership.
