# Issues requiring human or external authority

**As of:** 2026-11-14 · **Branch:** `main` (`f0e0b07…`, the deployed build; PRs #45/#47/#48 merged) · **Contract:** `contract.ovc-v3-ctl-2f6c4c.testnet` (testnet)

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
wallet, choose a product, buy cover, and confirm the transaction in the extension. **The complete,
copy-pasteable procedure — with the exact product, the expected premium, the success/rejection/timeout
outcomes and the four read-only RPC checks — is `docs/HUMAN_ACCEPTANCE_TEST.md`.** `docs/JUDGE_DEMO.md`
§3 is the shorter demo-script version. The wallet signs exactly one `buy_cover`; the console holds no
key.

**Read-only verification:** the policy appears under "Policies written" and its buyer is the wallet's
account; the transaction resolves on https://testnet.nearblocks.io.

## C. Close SEC-1 on the legacy v1 address

**Why.** `contract.attestor-overcover.testnet` still runs the original v1 module, whose
`#[init(ignore_state)]` `migrate()` lets any account overwrite owner and attestor. It is **reproduced**
against the exact deployed bytecode (`npm run verify:sec1-takeover`, 17/17) and **contained** in the
console (labelled *Legacy build*, buying disabled), but the contract-level fix needs an in-place
upgrade.

**Current live state (read over public RPC, 2026-11-13).** The legacy module exports an owner-only
`set_paused`, but there is no `get_paused`; the flag is read via `get_pool`, which returns
**`paused: false`** (solvent `true`). The owner is `owner.attestor-overcover.testnet` — a different
account from the contract account, and neither key is available here. So the contract is **not**
paused and **not** repaired; nothing here signed anything for the legacy account.

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

## F. Publish the work (GitHub write credential) — PARTIALLY DONE, currently blocked

**History (2026-11-13, worked).** Earlier in the release-closure session a GitHub token with
`contents:write` + `pull_requests:write` for `itzebe/overcover` was valid: the branch
`feat/security-closure-wallet-timeout-and-status` was pushed, its PR #45 passed CI, and it was
**squash-merged to `main`** as `c209cbf49f24217e122a0dbcdc2c326debc015a6`. Vercel auto-deployed that
exact commit to production (`dpl_3JRkaP6iBiSbm5mkTqQJYiXa7rrV`, READY).

**Current state (2026-11-14, resolved).** The token works again: `GET /user` returns `itzebe` with
`admin`/`push` on `itzebe/overcover`. This session pushed and squash-merged **PR #47** (legacy
`code_hash` correction), **PR #44** (SEC-1 remediation tests + operator runbook), **PR #46**
(release-truth closeout, rebased onto the current `main`) and **PR #41** (OutLayer attestation POC,
rebased; `package.json` conflict resolved). A closeout PR **#49** records the reconciliation. No
credential is required from a human to publish documentation-only work.

**What remains human-only.** The operations that need a NEAR signing key this environment does not
hold (v3 redeploy, legacy v1 pause, the live v3 purchase) — see sections A–E. Publishing code and
docs no longer needs a human.

**Historical note (2026-11-13).** Earlier in the release-closure session the stored token briefly
returned HTTP 401 on writes; that is no longer the case.
