# Final production closeout — Overcover

**Date:** 2026-11-14 · **Author:** OpenHands agent (execution session)
**Scope:** complete the remaining authorized engineering, verification and production work and leave
exactly one step — the owner's human-controlled v3 purchase — to a human.

Everything below was run in this session unless a row says otherwise. Where a fact could only be
observed over the network, the command is shown so it can be reproduced. Nothing here is a
projection, a mock or a simulation unless it is labelled as one.

---

## 1. Final `main` SHA

| | Value |
| --- | --- |
| `main` | `a05378d90a1c5ac52705daf8c2b680ed051dc58b` (`a05378d`) |
| Top commit | *Security-hardening & discoverability closeout: reconcile the PR queue, verify live reality (#49)* |

## 2. PR #49 — outcome and merge evidence

PR **#49** (`feat/overcover-security-hardening-discoverability-closeout` → `main`) was **merged**
(squash) after the mission's conditions were checked and satisfied:

| Condition | Evidence |
| --- | --- |
| Diff reviewed in full | docs-only: `docs/FINAL_RELEASE_READINESS.md` (+26), `docs/HUMAN_ACTIONS_REQUIRED.md` (+4/−3). No source, UI, CSP, wallet or contract file touched. |
| Claims match deployed reality | each row of the reconciliation table was re-checked this session against the actual merges, RPC reads and production deployment |
| No fabricated hash / no "fix is live" claim | the diff states the SEC-6/7/9 redeploy is still pending; §5 below independently confirms it is **not** live |
| No regression introduced | docs-only; production `ui/index.html` sha256 unchanged (`9d778bc863729d58…`) |
| Evidence files exist | `video/out/overcover-demo.mp4`, `poc/outlayer-attested-observation/*`, `proof/*` all present |
| Required CI passes | `verify` → **SUCCESS** (run `43578310105`); `Vercel` → SUCCESS |
| Required reviews / protections | no branch protection blocks the merge; no review was required and none was fabricated |
| Merge | `gh api -X PUT …/pulls/49/merge-async -f merge_method=squash` → `merged`; merge commit `a05378d…`, `mergedAt` `2026-11-14T09:34:56Z` |

PR **#39** (`video/final-human-purchase`) was **preserved** — still open, still draft. Not merged, not
closed.

## 3. Production deployment — ID, URL, parity

| | Value |
| --- | --- |
| Deployment | `dpl_55Png5TRLiwwSQgb5pTNFd6Jx218` (READY) |
| URL | https://overcover.vercel.app/ |
| `meta.githubCommitSha` | `a05378d90a…` — equals `main` |
| Served `ui/index.html` sha256 | `9d778bc863729d58…` — **byte-identical** to `main`'s `ui/index.html` |
| CSP `script-src` hash | `sha256-zVUGF7AJz3czRkmhdlWGLfdwpj/86a96VfpUytQEgjs=` (matches the inline script) |

## 4. V3 artifact hash and live deployed hash

The hardened artifact was **independently rebuilt in this session** with the pinned toolchain
(`rustup toolchain install 1.99.1 --target wasm32-unknown-unknown`, matching `rust-toolchain.toml`):

```
CARGO_HOME=/home/openhands/.cargo CARGO_TARGET_DIR=/tmp/oc-target \
  cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
→ sha256 811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f  (500342 bytes)
```

This is the intended artifact hash, reproduced from source. **The rebuild equals the approved
artifact.**

| | code_hash | sha256 | bytes |
| --- | --- | --- | --- |
| Live v3 (`contract.ovc-v3-ctl-2f6c4c.testnet`) | `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL` | `a97034e6…` | 500023 |
| Hardened source build | — | `811e0427…` | 500342 |

**The live v3 module is the pre-fix build.** It carries the SEC-1 guard but **not** SEC-6/7/9 —
confirmed at the byte level by reading the deployed WASM over RPC and searching it for each guard's
error string (see §6).

## 5. V3 deployment transaction and state-preservation evidence

**Not performed — blocked, with the exact reason.** The prepared, authorized, state-preserving
code-only redeploy (`driver/redeploy-v3.mjs`) was verified but **not sent**:

- `node driver/redeploy-v3.mjs --plan` → target `contract.ovc-v3-ctl-2f6c4c.testnet`; current
  `CQR8x1kW…`; new `811e0427…` (500342 B); **operation = `DeployContract(…) — code only, no
  new()/migrate()`**; rollback = re-deploy the previous module. Nothing sent.
- **Blocker:** the driver needs a signature from a `FullAccess` key on the v3 account
  (`ed25519:B5iWCqs9…`, read from `view_access_key_list`). Its private half is not in this
  environment (see §12).

The state-preservation property the redeploy relies on is proven on a real `neard` node instead:

- `npm run verify:upgrade-preservation` → **`RESULT: state PRESERVED, migrated policy settled.`**
  (runs the exact deployed v1 bytecode, deploys v2 over it, self-calls `migrate()`, asserts capital,
  reserved, products and policies survive and the migrated policy still settles).
- `npm run verify:upgrade` → **8/8** (third-party `migrate()` refused; state untouched; repeat
  refused; self-call with no legacy state fails closed).

## 6. SEC-1 / SEC-6 / SEC-7 / SEC-9 — live verification

Read the **live WASM bytes** over RPC and searched for each guard's error string:

| Guard | Live v3 | Live legacy v1 |
| --- | --- | --- |
| SEC-1 `migrate()` self-call guard | **HAS** | **lacks** |
| SEC-6 no-reading release | lacks | lacks |
| SEC-7 observation-date bound | lacks | lacks |

So, against the **deployed** code, not the source:

- **SEC-1** is closed on v3 (the guard is present); it is **open on legacy v1** (no guard) — the
  legacy contract is contained in the console and non-purchasable, but the contract-level fix needs
  an in-place upgrade (owner-only key, unavailable here).
- **SEC-6 / SEC-7 / SEC-9** are **implemented in source** (`811e0427…` carries all three guard
  strings) and **verified on the compiled module** by `verify:sandbox` (28/28),
  `verify:controlled-v3:sandbox` (39/39) and the 92 Rust tests, but they are **not deployed** to the
  live v3 address. `verify:proof` prints `SOURCE AHEAD OF DEPLOYMENT` for exactly this reason.

## 7. Legacy v1 containment

- Legacy v1 `contract.attestor-overcover.testnet` still runs the original module (344857 bytes; no
  SEC-1 guard). Read over RPC: `paused=false`, `solvent=true`, pool 14.05 NEAR capital / 10.50
  reserved; **15 policies**; owner `owner.attestor-overcover.testnet`.
- **Containment in place:** the console labels the legacy build and disables buying; the hardened v3
  address is the default purchase destination.
- **Not repaired:** the legacy account's only key is `ed25519:CwZBmKyV…` (FullAccess), whose private
  half was generated locally and never exported (`docs/AUTHORITY_RECOVERY.md` §2–4). No key is in this
  environment; nothing was signed for the legacy account.
- **Former takeover path reproduced** against the exact deployed bytecode: `npm run verify:sec1-takeover`
  → **17/17** (11 confirm the takeover, 6 confirm the fix on the hardened module).
- **Historical purchase evidence preserved and correctly labelled:** PR #39's recorded transaction
  `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i` — independently re-verified via the NearBlocks
  testnet API — signer `human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet`, receiver
  `contract.attestor-overcover.testnet` (legacy v1), outcome **success**. It is labelled "legacy v1
  build" wherever it appears and is **not** evidence of a v3 human purchase.

## 8. OutLayer integration and deployment result

- The **deployed contract does not consume OutLayer attestation** (grep of `contract/src/` finds no
  TEE/OutLayer path; the contract verifies ed25519 operator signatures). This is stated honestly, not
  glossed: the POC adds a hardware-rooted provenance link *upstream* of the existing signature/quorum
  path.
- POC status (unchanged, honest): the real TDX execution and its Intel quote are **VERIFIED**
  (`poc:outlayer:test` → **34/34**); the Overcover **adapter is not deployed on OutLayer**
  (`outlayer deploy` needs a NEAR FullAccess signature + funded wallet that is not available here).
  `poc/outlayer-attested-observation/README.md` §Limitations says so.
- The deployment procedure is documented (`docs/OPERATOR_ACTIONS_REQUIRED.md`, POC README). No credits
  or paid infrastructure were purchased.

## 9. Test matrix (this session, on `main` = `a05378d`)

| Gate | Command | Exit | Result |
| --- | --- | --- | --- |
| Reference model | `npm run test:model` | 0 | 74/74 defended, 0 exploitable |
| Simulation | `npm run test:sim` | 0 | 79/79 |
| Contract unit | `npm run test:contract` | 0 | **92 passed / 0 failed** (Rust 1.99.1, installed this session) |
| Console + wallet | `npm run test:console` | 0 | 132/132 |
| Agent limits/API | `npm run test:agent` | 0 | 54/54 |
| Product feed + eval | `npm run test:agent-eval` | 0 | 33/33 |
| Factory discovery | `npm run test:factory` | 0 | 11/11 |
| Deploy fail-closed | `npm run test:deploy` | 0 | 21/21 |
| Independent proof | `npm run verify:proof` | 0 | 13/13 (`SOURCE AHEAD OF DEPLOYMENT`) |
| Migration auth | `npm run verify:migration` | 0 | 6/6 |
| SEC-1 takeover | `npm run verify:sec1-takeover` | 0 | 17/17 (SANDBOX) |
| Release ops preflight | `npm run verify:release-ops` | 0 | 4 ok, 5 blocked, 0 inconsistent |
| Sandbox lifecycle | `npm run verify:sandbox` | 0 | 28/28 |
| Upgrade guard | `npm run verify:upgrade` | 0 | 8/8 |
| Upgrade preservation | `npm run verify:upgrade-preservation` | 0 | state PRESERVED |
| Controlled v3 (sandbox) | `npm run verify:controlled-v3:sandbox` | 0 | 39/39 |
| Controlled v3 evidence | `npm run verify:controlled-v3:evidence` | 0 | live read; 3 v3 accounts |
| Factory (sandbox) | `npm run verify:factory` | 0 | 22/22 |
| Agent vs live contract | `npm run verify:agent` | 0 | pass |
| Connectivity | `npm run verify:connectivity` | 0 | 13/13 |
| Live check | `npm run verify:live` | 0 | pass |
| Accessibility | `npm run axe` | 0 | 0 violations @ 320–1440 px (page + dialog) |
| UI QA | `npm run ui:qa` | 0 | PASS, 7 viewports |
| Viewport audit | `npm run ui:viewports` | 0 | PASS, no overflow / console errors |
| OutLayer POC | `npm run poc:outlayer:test` | 0 | 34/34 |
| CI on merged main | GitHub Actions | — | `verify` SUCCESS (run `43581236007`) |

**Not run, with reason:**

- `npm run verify:controlled-v3` (real **testnet**, 40/40) — needs a funded testnet root. **Probed
  this session:** the NEAR faucet returns `429 Rate limit exceeded, retry in 6 hours`. Reported as
  **BLOCKED**, not skipped silently. The identical harness runs green on `neard` (39/39).
- `npm run test:onchain` — needs `keys/identities.json` (the operator identity graph), absent here.

## 10. Security and dependency audit

- **Contract:** the invariant **reserved capital ≤ available backing capital** holds on live v3
  (`reserved 0.20 ≤ available 1.225 NEAR`, `solvent=true`) and is asserted by the sandbox lifecycle,
  the reference model and the Rust tests. Authorization boundaries (owner-only methods, operator
  quorum, resolver independence, SEC-1 self-call guard) are each exercised by a passing gate above.
- **Dependencies (`npm audit`, 242 deps):** **0 critical, 0 high, 0 moderate, 19 low.** The 19 low are
  one transitive advisory — `elliptic` *"Uses a Cryptographic Primitive with a Risky
  Implementation"* (`GHSA-848j-6mx2-7j84`) — reached through `@near-js/crypto → secp256k1` and through
  `crypto-browserify` in the wallet bundle. **No non-breaking fix exists** (`fixAvailable` is a
  semver-major downgrade of `crypto-browserify` to 3.5.1, which would be a supply-chain regression).
  The library is used for ECDSA verification and browser polyfills; the console holds no key and
  signing happens in the wallet extension. Documented, not suppressed.
- **Secrets:** no key, seed or credential was printed, copied or committed. `NEAR_INTENTS_AGENT_API_KEY`
  was checked **by format only** (a JWT, not an `ed25519:` signing key); no environment variable holds
  an `ed25519:` value; the repo's own secret-scan step passes in CI.

## 11. Website and wallet verification

- **Production smoke** (Playwright/Chromium against https://overcover.vercel.app/) at **320, 360, 390,
  430, 768, 1024, 1440 px**: page overflow **0** at every width; exactly **one `h1`**; the **hero is
  the first section** (`secBannerAboveHero=false` — the security disclosure was **not** reintroduced
  above the hero); **0 console errors**.
- **Discoverability (HTTP-verified on production):** `/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`,
  `/llms-full.txt`, `/products.json`, `/products.schema.json` all **HTTP 200**; deployed `robots.txt`,
  `llms.txt` and `sitemap.xml` are **byte-identical** to the repo. `robots.txt` explicitly allows
  GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, PerplexityBot, Googlebot, Bingbot,
  Google-Extended and Applebot-Extended, and points to the sitemap.
- **Structured data:** exactly one JSON-LD block in the **initial** HTML, valid, `@graph` =
  Organization, WebSite, SoftwareApplication, WebPage, FAQPage; **no fabricated `aggregateRating` or
  `review`**. Canonical, `og:title`, `og:type`, `og:url` and `meta description` are present in the
  initial HTML.
- **Product catalogue honesty:** `/products.json` is generated from live contract views (`list_products`
  / `get_config` / `get_pool` / `list_observations`) and names the testnet contract; the live contract
  returns the same 2 products (`heat-lagos`, `heat-lagos-factory`).
- **Indexing not claimed:** crawler **access** is verified; actual **indexing** requires Google Search
  Console / Bing Webmaster Tools, to which this environment has no account (see §12).

## 12. Remaining owner-controlled action (the only one)

1. **Human v3 purchase (acceptance).** Open https://overcover.vercel.app/ with a funded NEAR **testnet**
   wallet, connect, choose a product, buy cover, confirm in the extension. Exact procedure:
   `docs/HUMAN_ACCEPTANCE_TEST.md` (product, expected premium, success/rejection/timeout outcomes, four
   read-only RPC checks). The wallet signs exactly one `buy_cover`; the console holds no key. **No seed
   phrase or private key is ever pasted, committed, or shared.**

Also owner-controlled, but **not** prerequisites for the acceptance above:

2. **Deploy the SEC-6/7/9 hardening to live v3** — `node driver/redeploy-v3.mjs` with the v3
   `FullAccess` key. Code-only, state-preserving, rollback documented.
3. **Close SEC-1 on legacy v1** — `node driver/upgrade.js` with the legacy `FullAccess` key
   (`ed25519:CwZBmKyV…`), or the controlled v3 deployment.
4. **OutLayer adapter deploy** — `outlayer deploy` with a NEAR FullAccess signature + funded wallet.
5. **Search indexing** — submit the sitemap in Search Console / Webmaster Tools.

### The operator-authority question, resolved

The mission asked to resolve the discrepancy between "OpenHands has full control of the NEAR testnet
operator key" and the earlier report that no signing key is held. **Investigated directly and safely
this session:**

- No environment variable holds an `ed25519:` signing key (checked by value prefix, names only).
  `NEAR_INTENTS_AGENT_API_KEY` is a JWT (prefix `eyJh…`), not a key.
- No registered secret provides a NEAR signer; `keys/` is absent; `~/.near-credentials/` is absent; no
  file in the filesystem holds an `ed25519:` private key.
- The v3 account has one `FullAccess` key (`ed25519:B5iWCqs9…`); the legacy account has one
  (`ed25519:CwZBmKyV…`). Only the **public** halves are readable from the chain.
- The NEAR faucet (the only route to a **fresh funded** root) returns **429, retry in 6 hours**.

**Conclusion: this execution environment cannot sign for either account, and cannot obtain a fresh
funded account.** The earlier report was correct for this environment. Per the mission's rule, all
unrelated preparation, tests and documentation are complete, and the missing capability is recorded
here exactly — no simulated deployment was substituted.

## 13. Exact evidence paths

| Evidence | Path |
| --- | --- |
| This report | `reports/FINAL-PRODUCTION-CLOSEOUT.md` |
| Release register (statuses) | `docs/FINAL_RELEASE_READINESS.md` |
| Owner/operator actions | `docs/HUMAN_ACTIONS_REQUIRED.md`, `docs/OPERATOR_ACTIONS_REQUIRED.md` |
| Owner acceptance procedure | `docs/HUMAN_ACCEPTANCE_TEST.md` |
| Authority recovery + redeploy runbook | `docs/AUTHORITY_RECOVERY.md`, `docs/DEPLOY_RUNBOOK.md` |
| Proof artifacts | `proof/verification.json`, `proof/migration-auth.json`, `proof/controlled-v3-sandbox.json`, `proof/sec1-takeover*.json` |
| OutLayer POC | `poc/outlayer-attested-observation/` (+ `fixtures/outlayer-real/`) |
| Judge-demo video + tx evidence | `video/out/overcover-demo.mp4`, `video/evidence/human-purchase.json` (PR #39) |
| Discoverability files | `ui/robots.txt`, `ui/sitemap.xml`, `ui/llms.txt`, `ui/llms-full.txt`, `ui/products.json`, `ui/products.schema.json` |

---

*Nothing in this report claims a live deployment, an audit, or an indexing event that did not
actually happen. The hardened v3 redeploy, the legacy v1 containment and the human v3 purchase remain
owner-controlled and are listed as such.*
