# Human / external-authority actions required

Three items need a human or an external authority. Everything else in this delivery is complete and
verifiable without them.

## 1. Record a genuine human-wallet purchase on hardened v3 (the outstanding acceptance test)

**Status:** outstanding. **No human-wallet purchase exists on v3 or v1** — every recorded `buy_cover`
signer is a scripted/agent account, and the only purchase ever called "human" (legacy v1
`87n1pdeA…`) was signed programmatically on the legacy contract. Full evidence:
`reports/VIDEO_CUSTOMER_JOURNEY_EVIDENCE.md`.

**What is already verified (no human needed):** the live customer journey is captured read-only, and
the purchase path on hardened v3 is real — `buy_cover` tx `45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn`
produced policy #3 (`active`, reserved capital). That purchase was signed by the project's agent.

**Action (a person, ~10 minutes):** follow `docs/HUMAN_ACCEPTANCE_TEST.md` — open
<https://overcover.vercel.app/>, connect a funded NEAR **testnet** wallet, buy one cover, and record
the resulting transaction hash and policy id. Then update
`reports/VIDEO_CUSTOMER_JOURNEY_EVIDENCE.md` §4 and the film's claim table. **Never paste a private
key or seed phrase into chat or a commit.**

## 2. Refresh the GitHub API token — PR could not be opened automatically

**Status:** the branch is pushed; the pull request could not be opened by the agent.

**What works**
- SSH push works via the deploy key bound to `itzebe/overcover`
  (`git@github.com:itzebe/overcover.git`, key at `/workspace/credentials/overcover/overcover_deploy`).
- The branch is on the remote:
  `feat/overcover-company-film` = `f7a6be8` (3 commits ahead of `main` = `0f79dc6`).
- The API path was retried this session and still fails: `curl https://api.github.com/user` → **HTTP
  401**, and the `create_pr` tool returns **"Invalid github token"**.

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

## 3. Watch the master film end-to-end

The QA in `reports/VIDEO_QA_REPORT.md` is **programmatic** (decode integrity, black-frame detection,
perceptual-hash scene matching, EBU R128 loudness, font-size scaling). The reviewer environment used
to build the film cannot display images to the reviewer, so **no human has watched the film frame by
frame**. Before publishing the film externally, a person should watch the master
(`video/company/out/overcover-company-film.mp4`, SHA-256 `5f6e5758…ca2d0d`) end-to-end and confirm
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
