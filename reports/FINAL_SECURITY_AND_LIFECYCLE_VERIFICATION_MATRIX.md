# Final security and lifecycle verification matrix

**As of:** 2026-11-14 · **Branch:** `feat/owner-authority-reconciliation-testnet` · **HEAD:** `c8a32f5d`
**Contracts:** v3 `contract.ovc-v3-ctl-2f6c4c.testnet` (default) · legacy v1 `contract.attestor-overcover.testnet`

Every result below was produced by a command that is in the repository and can be re-run. No result
is asserted from memory. Where a check needs a key this environment does not hold, it is marked
**BLOCKED** and the reason is named — not reported as a pass.

Legend: ✅ pass · ⚠️ pass with a named limitation · ⛔ blocked (external authority) · — not run here.

---

## 1. Smart-contract security (Rust, unit + invariant + fuzz)

| Check | Command | Result |
| --- | --- | --- |
| Full contract unit suite (incl. SEC-1/6/7/9, rotation, invariant) | `npm run test:contract` | ✅ **97 passed / 0 failed** |
| Operator key rotation is owner-only, preserves state, rejects bad keys | `contract/src/tests.rs` `rot1..rot5` | ✅ included in the 97 |
| `reserved ≤ capital` re-checked on every mutation | `check_invariant_or_panic` (`lib.rs:2078`) | ✅ enforced on-chain; asserted by `assert_pool_sound` in tests |
| `reconcile()` identity holds across a sequence | `invariant_and_reconciliation_hold_across_a_sequence` | ✅ |
| Stateful fuzz (random op sequences) keeps the pool sound | `stateful_fuzz_seed_*` | ✅ |
| SEC-1: v1 `migrate()` unauthenticated; v2 guard refuses | `npm run verify:migration` | ✅ **6/6** |
| SEC-1: end-to-end takeover reproduced on real v1 bytecode, refused by v2 | `npm run verify:sec1-takeover` | ✅ **17/17** |
| Upgrade guard: third-party `migrate()` refused, self-call fails closed | `npm run verify:upgrade` | ✅ **8/8** |
| Upgrade preserves state (address, pool, products, policies) | `npm run verify:upgrade-preservation` | ✅ **state PRESERVED**, migrated policy settled |
| Reference attack model | `npm run test:model` | ✅ **74/74 defended, 0 exploitable** |
| Full-lifecycle simulation | `npm run test:sim` | ✅ **79/79** |

**Invariant status: `reserved ≤ capital` holds on both live contracts** (`check_invariant()` and
`reconcile()` both `true`; `proof/legacy-reconciliation.json`).

## 2. Factory and oracle (permissionless paths)

| Check | Command | Result |
| --- | --- | --- |
| Permissionless factory: non-owner propose → activate → buy | `npm run verify:factory` | ✅ **22/22** (sandbox) |
| Factory discovery rules (unknown metric/city refused, live forecast) | `npm run test:factory` | ✅ **11/11** |
| Factory deploy harness | `npm run test:deploy` | ✅ **21/21** |
| Controlled v3 on a real `neard` (deploy, quorums, factory, SEC-1 closure) | `npm run verify:controlled-v3:sandbox` | ✅ **39/39** |
| Controlled v3 on NEAR testnet (funded root) | `npm run verify:controlled-v3` | ✅ **40/40** (recorded run 3, `2f6c4c`) / **40/40** (run 4, hardened ref) |

## 3. Wallet and transaction boundary

| Check | Command | Result |
| --- | --- | --- |
| Console page regressions + live RPC read | `npm run test:console` | ✅ **132/132** |
| Real inline script vs mock wallet: exactly one `buy_cover`, no owner-only call, wrong-network refusal, duplicate/timeout/rejection/late-answer handling | `tests/wallet-journey.test.mjs` | ✅ **31/31** |
| Real page + real bundle loaded in a browser; no localhost default; no key shipped; no public path to an owner-only method | `npm run verify:connectivity` | ✅ **13/13** |
| Live production page reads the contract and shows capital | `npm run verify:live` | ✅ reads live state |
| Challenge-window disclosure is set from the **live** config (new) | `tests/console.test.js` (assertion added) | ✅ |

**Fail-closed behaviour verified:** a failed read renders as stale/"no data", never live; success
requires a real transaction hash and a non-`Failure` status; a wallet on the wrong network cannot
buy. A **live human extension approval on v3** remains outstanding (see §7, item B).

## 4. Agent service boundary

| Check | Command | Result |
| --- | --- | --- |
| Limits engine, API auth, funds guard, OpenAPI, big-int | `npm run test:agent` | ✅ **54/54** |
| Product feed + agent eval + integration | `npm run test:agent-eval` | ✅ **33/33** |
| Live agent policy decision (denied purchases never reach signing) | `npm run verify:agent` | ✅ (writes evidence JSON) |
| Defaults are dry-run and localhost-bound | `agent/README.md`, `agent/server.mjs` | ✅ verified by `verify:connectivity` |

## 5. Application and infrastructure

| Check | Command | Result |
| --- | --- | --- |
| Dependency audit (all) | `npm audit` | ⚠️ **0 high / 0 moderate / 0 critical; 19 low** (one root: `elliptic` GHSA-848j-6mx2-7j84; no non-breaking fix) |
| Dependency audit (production) | `npm audit --omit=dev` | ⚠️ **0 high / 0 moderate / 0 critical; 16 low** (same root) |
| Secret scan / committed-key check | `npm run verify:release-ops` | ✅ no operator secret committed or world-readable; canonical wasm matches `811e0427…` |
| Content-Security-Policy pins the inline script by hash | `tests/console.test.js` | ✅ hash updated to the current script; script-src/object-src/base-uri/frame-ancestors/form-action/connect-src all locked down |
| Accessibility (WCAG 2.2 AA), page + wallet dialog | `npm run axe` | ✅ **0 violations** at 320/360/390/768/1024/1280/1440 px |
| UI QA (viewports + agent round-trip) | `npm run ui:qa` | ✅ pass |

The `elliptic` finding is documented as a **low-severity, no-fix CWE-1240** item and is present in the
shipped wallet bundle — it is **not** described as dev-only (that claim was corrected in
`docs/SECURITY_PRE_AUDIT.md` and `docs/FINAL_RELEASE_READINESS.md`). It is not suppressed.

## 6. Lifecycle and deployment state

| Check | Command | Result |
| --- | --- | --- |
| Full lifecycle on a real `neard` | `npm run verify:sandbox` | ✅ **28/28** |
| Every demo-log transaction resolves on-chain; agent buys re-derived | `npm run verify:proof` | ✅ **13/13** |
| Preservation snapshot | `npm run verify:preservation` | ✅ PASS |
| Deployed-vs-source parity | `npm run verify:proof` | ✅ recognised build; **`SOURCE AHEAD OF DEPLOYMENT`** reported honestly (SEC-6/7/9 not on the live default) |
| Deployed bytes re-read from RPC (4 runs) | `npm run verify:controlled-v3:evidence` | ✅ writes `proof/controlled-v3-onchain-evidence.json` |
| Legacy state reconciliation (read-only) | `node scripts/legacy-reconciliation.mjs` | ✅ `proof/legacy-reconciliation.json` |

## 7. Blocked items (external authority — not worked around)

| # | Item | Blocker | Evidence |
| --- | --- | --- | --- |
| A | Redeploy hardened module to the live v3 default (SEC-6/7/9) | v3 operator key not held | `docs/HUMAN_ACTIONS_REQUIRED.md` §A; `verify:proof` prints SOURCE AHEAD |
| B | Live **human** wallet approval on v3 | needs a person + funded testnet wallet | `docs/HUMAN_ACCEPTANCE_TEST.md` |
| C | Close SEC-1 on legacy v1 (`set_paused`) | legacy owner/account key not recoverable | `reports/LEGACY_CONTAINMENT_AND_MIGRATION_PLAN.md`; `verify:sec1-takeover` |
| D | Funded-root controlled-v3 re-run | no funded root here (fails closed with a SKIP) | `verify:controlled-v3:plan` |
| E | Confirm search-engine **indexing** | no Search Console / Webmaster account | crawler **access** is verified over HTTP (§8) |

## 8. Discoverability (production HTTP, verified)

| Endpoint | Status | Note |
| --- | --- | --- |
| `/` | 200 | byte-identical to the repo's `ui/index.html` |
| `/robots.txt` | 200 | allows GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, PerplexityBot, Googlebot, Bingbot, Google-Extended, Applebot-Extended; points to the sitemap |
| `/sitemap.xml` | 200 | valid; canonical URL |
| `/llms.txt`, `/llms-full.txt` | 200 | corrected to describe the v3 default (quorum oracle, resolvers, 3600 s window) |
| `/products.json`, `/products.schema.json` | 200 | generated from live contract state |
| JSON-LD | present | Organization, SoftwareApplication, WebSite, WebPage, Offer, FAQPage (+8 Q/A) — no fabricated ratings/reviews/users |

---

## 9. Honest summary

- **Contract invariants hold** on both live contracts, and the primary invariant
  (`reserved ≤ capital`) is enforced on-chain and covered by unit, invariant and fuzz tests.
- **The one critical, live, reproducible issue** is the legacy v1 SEC-1 takeover — reproduced 17/17
  against the real bytecode and **blocked from a fix only by a key that no longer exists**. It is
  contained in the console and disclosed, but **not repaired**.
- **No critical or high finding is open on the hardened v3 default.** Its open item is a
  liveness/termination gap (SEC-6/7/9 not yet deployed), gated on the v3 operator key.
- **The evidence is reproducible**: every ✅ above is a committed command with committed evidence
  (`proof/*.json`). The four ⛔ items are named, not hidden.
