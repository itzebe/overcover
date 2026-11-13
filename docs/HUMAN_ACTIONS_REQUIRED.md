# Issues requiring human or external authority

**As of:** 2026-11-12 · **Branch:** `feat/institutional-website` · **Contract:** `contract.ovc-v3-ctl-2f6c4c.testnet` (testnet)

This is the separate register of work that **cannot** be completed from an agent environment
because it needs a private key, a human-controlled wallet, or an external service account. Nothing
here was worked around, and no key recovery or unauthorised upgrade was attempted. Each item states
the smallest human action and the exact read-only verification.

The main register, with every requirement and its evidence, is `docs/FINAL_RELEASE_READINESS.md`.

---

## A. Redeploy the hardened v3 module (carries SEC-6 / SEC-7 / SEC-9)

**Why.** The live v3 account runs module sha256 `a97034e65fb0c53f…` (500023 bytes). This branch's
source builds to `811e0427ec467582…` (500342 bytes), which adds the SEC-6 / SEC-7 reservation-release
fix and the SEC-9 unbounded-lead fix. `npm run verify:proof` prints `SOURCE AHEAD OF DEPLOYMENT`.

**What is needed.** The operator key for `contract.ovc-v3-ctl-2f6c4c.testnet` — a `FullAccess` key on
that account. It is not in this environment (`OVC_V3_SECRET_KEY` unset, `keys/` absent).

**Smallest human action** (code-only, no `new()`/`migrate()`, state preserved):

```bash
cd contract && cargo build --release --target wasm32-unknown-unknown && cd ..
OVC_EXPECTED_SHA=811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f \
  npm run redeploy:v3 -- --plan     # prints the operation, sends nothing
OVC_V3_SECRET_KEY=<operator key> \
  OVC_EXPECTED_SHA=811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f \
  npm run redeploy:v3               # DeployContract only — replaces code, keeps state
```

The script **fails closed**: it refuses unless the wasm sha256 equals `OVC_EXPECTED_SHA` and the wasm
contains the SEC-9 guard string, so a stale or foreign artifact cannot be shipped by accident.
Rollback is the same command pointed at the previous module (`a97034e6…`); it is also code-only.

**Read-only verification after the redeploy:**

```bash
npm run verify:proof   # the deployed module must now match 811e0427… and SOURCE AHEAD must be gone
```

## B. Live human wallet approval on v3 (the outstanding acceptance test)

**Why.** Every browser-wallet behaviour is proven by lifting the real inline script and running it
against a mock wallet (`tests/wallet-journey.test.mjs`) and by loading the real page and bundle
(`npm run verify:connectivity`), but no **live extension approval** has been captured. A recorded
human purchase exists only on the **legacy v1** contract (PR #39) and must not be read as a v3 human
purchase.

**What is needed.** A human with a funded NEAR **testnet** wallet (HERE or Meteor) and a browser.

**Smallest human action.** Open https://overcover.vercel.app/ on the hardened build, connect the
wallet, choose a product, buy cover, and confirm the transaction in the extension. `docs/JUDGE_DEMO.md`
§3 gives the exact steps. The wallet signs exactly one `buy_cover`; the console holds no key.

**Read-only verification:** the policy appears under "Policies written" and its buyer is the wallet's
account; the transaction resolves on https://testnet.nearblocks.io.

## C. Close SEC-1 on the legacy v1 address

**Why.** `contract.attestor-overcover.testnet` still runs the original v1 module, whose
`#[init(ignore_state)]` `migrate()` lets any account overwrite owner and attestor. It is **reproduced**
against the exact deployed bytecode (`npm run verify:sec1-takeover`, 17/17) and **contained** in the
console (labelled *Legacy build*, buying disabled), but the contract-level fix needs an in-place
upgrade.

**What is needed.** The `FullAccess` key on `contract.attestor-overcover.testnet`
(`ed25519:CwZBmKyV…`), which is **not recoverable from the chain** and not in this environment — see
`docs/AUTHORITY_RECOVERY.md`.

**Smallest human action:** `node driver/upgrade.js` (non-destructive; ~4.63 NEAR refundable stake), or
run the controlled deployment in `docs/AUTHORITY_RECOVERY.md` §5. Until then the legacy address stays
readable and non-purchasable; the hardened v3 contract remains the default purchase destination.

## D. Funded-root controlled-v3 testnet run (optional re-run)

**Why.** `npm run verify:controlled-v3` (40/40) needs a funded testnet root. This environment has no
funded root, so the gate **fails closed with an actionable SKIP** rather than pretending to pass. The
same proof already runs green on a real `neard` node (`npm run verify:controlled-v3:sandbox`, 39/39).

**Smallest human action:** supply `OVERCOVER_ROOT_ACCOUNT_ID` + `OVERCOVER_ROOT_SECRET_KEY`, or a
gitignored `keys/controlled-v3-root.json` (`{ "accountId", "secretKey" }`, mode 0600), then run
`npm run verify:controlled-v3`.

## E. Search-engine indexing (external service account)

**Why.** Crawler **access** is verified against production over HTTP (all crawlers allowed, sitemap
and metadata present). Whether the pages are actually **indexed** can only be seen in Google Search
Console or Bing Webmaster Tools, to which this environment has no account.

**Smallest human action:** verify indexing in Search Console / Webmaster Tools and submit
`https://overcover.vercel.app/sitemap.xml` if not already known. No indexing claim is made here.

---

## F. Publish this work (GitHub write credential)

**Why.** The branch cannot be pushed and the PR cannot be opened from this environment: the stored
tokens all return **HTTP 401** (`git ls-remote` read-only works anonymously; `POST`/`PUSH` need a
valid token), and no `ssh` client is present.

**What is needed.** A GitHub token with `contents:write` and `pull_requests:write` for
`itzebe/overcover`, or a human to push the local branch.

**Smallest human action:**

```bash
git push -u origin feat/institutional-website
gh pr create --base main --head feat/institutional-website \
  --title "Security closure, website coherence, and a corrected readiness register"
```

The commits are ready on the local branch; nothing else is required.
