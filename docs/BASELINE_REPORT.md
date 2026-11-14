# Baseline report — where Overcover actually stands

Written 2026-11-11 at the start of the strategic upgrade mission, before any code
change. Every claim here was reproduced against the live system; nothing is
copied from a previous report. Commands and results are in the sections below.

## Repository and git

| Item | Value |
| --- | --- |
| Repository | `github.com/itzebe/overcover` |
| Default branch | `main` @ `6219219c6279581ee32eee973860d3b819ba23b0` |
| Open PRs | **#9** (draft) — `feat/decentralized-insurance-lifecycle` |
| Merged PRs | #1–#8, #10 |
| Working tree at start | clean, on `fix/website-truth-wallet-policy` (already merged as #10) |

`main` is one squash commit (`6219219c`, PR #10) ahead of `18ec7f08` (PR #8).
PR #9's branch is **behind** `main` — it carries `contract/VERSION`, `docs/DEPLOY_RUNBOOK.md`,
`docs/BASELINE_REPORT.md`, `driver/adapters.js` and the v2 contract source, none of
which are on `main` yet.

## Production

| Item | Value |
| --- | --- |
| URL | https://overcover.vercel.app/ (HTTP 200) |
| Mirror | https://itzebe.github.io/overcover/ (HTTP 200, same `index.html` sha256) |
| Deployment | `dpl_6WjfX2de7KwH4SKnxpv5sXmJDjqT`, READY, `meta.githubCommitSha = 6219219c6279` |
| Served vs source | `curl …/ | sha256sum` == `git show origin/main:ui/index.html | sha256sum` (`c47116fe…`) |

## Contract (live, NEAR **testnet**)

| Item | Value |
| --- | --- |
| Account | `contract.attestor-overcover.testnet` |
| Version on chain | **v1** — single trusted attestor; owner resolves disputes |
| code_hash | `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` |
| Deployed wasm sha256 | `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e` |
| Pool | capital 14.05 NEAR, reserved 10.50 NEAR, available 3.55 NEAR, 15 policies |
| Invariants | `reconcile()` = true, `check_invariant()` = true, `solvent` = true |
| Paused | false |
| Challenge window | 60 s (demo setting), bond 0.1 NEAR |
| Catalogue | 22 products, **1 sellable** (`rain-lagos`); 20 are `p-<ts>-<n>` demo fixtures, 1 is a ceiling-trigger broken definition (`rain-bergen-dry`) |

## What genuinely works (verified)

- **Human purchase path** — a real `buy_cover` landed on chain:
  tx `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`, signer
  `human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet`, deposit 0.05 NEAR, Success →
  policy 15. **This was signed programmatically** (the signer is a sub-account
  under the agent), so it proves the contract path, **not** a wallet-extension
  approval.
- **Autonomous agent purchase** — tx `2nfHPM8vZ7eYXk3yYaY6NCUr5qa9yHT57FxycVb3BL8Z`,
  signer `oc-agent-mwb87z4k.testnet` → policy 13. Both policies read back from
  `get_policy` with the expected buyer, product, payout and premium.
- **Spending authorization** — `npm run verify:agent` reports the blocked case
  `allow:false` and the permitted case `allow:true` against the live contract.
- **Independent proof** — `npm run verify:proof`: 12/12 in CI, 11/12 locally (the
  one local failure is the documented `CARGO_HOME` bytecode-reproducibility
  limitation, not a product defect).
- **Connectivity** — `npm run verify:connectivity`: 12/12, locally and against
  production.
- **Console / model / agent tests** — 77 / 31 / 36, all passing.

## What is sandbox-only (not deployed)

- **The v2 lifecycle** (PR #9): multi-operator oracle quorum, per-operator replay
  nonces, independent resolver disputes, metric-agnostic products. Proven on a
  **local `neard` 2.14.0** node — `npm run verify:sandbox` 28/28 — but **not on
  testnet**. The live contract is still v1.

## What is simulated

- The `p-<ts>-<n>` catalogue entries and their observations are the recorded demo
  cycle. They are labelled as fixtures in the console and are excluded from the
  feed's `offerings`.

## What is documented rather than demonstrated

- A **live wallet-extension approval** (HERE / Meteor). The purchase path is
  proven programmatically; the extension popup approval has not been captured.
- `npm run test:onchain` — needs the gitignored operator files and a fresh deploy.

## What is blocked

| Blocker | Why | Smallest unblock |
| --- | --- | --- |
| v2 testnet deploy | No funded operator key in this environment (`keys/` is empty). `attestor-overcover.testnet` holds 13.3 NEAR, which is enough. | Provide `keys/identities.json` (or run `node driver/keys.js` on the funded machine) and run `npm run deploy` from the PR #9 branch. |
| Live extension approval | Needs an interactive browser + funded wallet. | One person connects a wallet on production and buys one policy. |

## Honest summary

The shipped product is **v1**, live and honest: it reads the contract, it never
fabricates state, and a real policy exists on chain. The strongest unshipped work
is the **v2 decentralization** (proven locally, not deployed). The main gaps are
operational (a funded operator key, an interactive wallet), not architectural.
