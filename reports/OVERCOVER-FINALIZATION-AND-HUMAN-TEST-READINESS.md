# Overcover — finalization and human-test readiness

**As of:** 2026-11-14 · **Branch:** `feat/owner-authority-reconciliation-testnet` · **HEAD:** `c8a32f5d`
**Purpose:** close the authority-loss incident, resolve the legacy exposure honestly, deliver a
controlled human-testing release, and record the evidence. This is the umbrella report; the
supporting evidence is in the sibling reports and in `proof/*.json`.

**Nothing in this mission changed on-chain state, used production funds, or touched PR #39.**

---

## 1. What this mission did

1. **Closed the authority-loss incident.** The original signing authority for the live v3 and legacy
   v1 contracts is **not recoverable** (fully evidenced in `reports/WALLET-SIGNING-AUTHORITY-RECOVERY.md`
   and PR #51). This mission confirms that finding, records the exact live state, and states the
   consequence plainly rather than implying a fix that cannot exist.
2. **Reconciled legacy exposure** read-only: 15 legacy v1 policies and 3 v3 policies, with capital and
   reservations, and the SEC-1 takeover reproduced against the real bytecode
   (`reports/LEGACY_POLICYHOLDER_RECONCILIATION.md`).
3. **Assessed the successor architecture** and proved it is ready except for durable key custody
   (`reports/SUCCESSOR_DEPLOYMENT_READINESS.md`).
4. **Verified the full lifecycle and every suite**, building an evidence matrix
   (`reports/FINAL_SECURITY_AND_LIFECYCLE_VERIFICATION_MATRIX.md`).
5. **Corrected honesty defects** in the product's public claims (below).
6. **Hardened the console** so a claim the contract does not support cannot be shown (below).

## 2. Security fixes implemented in this mission

| # | Fix | Root cause | Regression defence |
| --- | --- | --- | --- |
| 1 | The console's **challenge-window disclosure is now read from the live contract config**, not hard-coded as "60-second". | The static text stated a 60 s window while the live v3 config is 3600 s — the page contradicted its own facts panel. | New assertion in `tests/console.test.js` (`Challenge window: ` set from `cfg.challenge_window_sec`); browser-verified: renders "1-hour (3600 seconds)". |
| 2 | **CSP hash** updated to the current inline script. | Editing the inline script invalidates the pinned `sha256`, which would silently break the page under CSP. | `tests/console.test.js` "the CSP pins the shipped inline script by its exact sha256". |
| 3 | Corrected the claim that the `elliptic` advisory is **dev-only**. | It **is** present in the shipped `ui/vendor/wallet-bundle.js`; the docs said it was not shipped. | `docs/SECURITY_PRE_AUDIT.md`, `docs/FINAL_RELEASE_READINESS.md` now state the truth; `verify:release-ops` scans the tree. |
| 4 | Corrected the stale oracle/window claims in **machine-readable and human docs** so they describe the v3 default (quorum oracle + resolvers, 3600 s window) and keep the legacy description clearly labelled legacy. | The v3 default had shipped while the docs still described the legacy single-attestor model as current. | `ui/llms.txt`, `ui/llms-full.txt`, `README.md`, `docs/SECURITY.md`, `docs/BUSINESS.md`, `docs/JUDGE_DEMO.md` corrected. |
| 5 | Corrected the **"deployed bytes are byte-identical to this source"** claim in the judge demo. | The source is now ahead of the deployed module (SEC-6/7/9), so the claim was false. | `docs/JUDGE_DEMO.md` now states `SOURCE AHEAD OF DEPLOYMENT`; `verify:proof` reports it. |

These are **honesty and correctness fixes**: each removes a statement the deployed contract or the
shipped artifact does not support. None weakens a control; none fabricates a result.

## 3. What was verified (commands and results)

Full detail and the blocked-item list: `reports/FINAL_SECURITY_AND_LIFECYCLE_VERIFICATION_MATRIX.md`.
Headline results, all re-run this session:

- `npm run test:contract` — **97/97** (incl. `rot1..rot5` rotation/recovery tests).
- `npm run test:model` — **74/74 defended, 0 exploitable**; `test:sim` **79/79**.
- `npm run test:console` — **132/132**; `tests/wallet-journey.test.mjs` **31/31**.
- `npm run test:agent` **54/54**; `test:agent-eval` **33/33**; `test:factory` **11/11**; `test:deploy` **21/21**.
- `npm run verify:proof` **13/13**; `verify:connectivity` **13/13**; `verify:sec1-takeover` **17/17**;
  `verify:migration` **6/6**; `verify:upgrade` **8/8**; `verify:upgrade-preservation` **state PRESERVED**;
  `verify:factory` **22/22**; `verify:preservation` **PASS**; `verify:release-ops` **PASS**.
- `npm run verify:sandbox` **28/28**; `verify:controlled-v3:sandbox` **39/39**.
- `npm run axe` — **0 violations** at 7 viewports (page and wallet dialog); `npm run ui:qa` pass.
- `npm audit` — **0 high / 0 moderate / 0 critical; 19 low** (one root: `elliptic`; no non-breaking fix).

**Invariant:** `reserved ≤ capital` is enforced on-chain (`lib.rs:2078`) and holds on both live
contracts (`reconcile()` and `check_invariant()` both true).

## 4. What is blocked (external authority — not worked around)

| Item | Blocker |
| --- | --- |
| Redeploy SEC-6/7/9 to the live v3 default | v3 operator key not held |
| Close SEC-1 on legacy v1 | legacy account/owner key not recoverable |
| **Live human wallet purchase on v3** | needs a person + funded testnet wallet (the outstanding acceptance test) |
| Funded-root controlled-v3 re-run | no funded root in this environment (fails closed) |
| Confirm search-engine *indexing* | no Search Console / Webmaster account (crawler *access* is verified) |

The register is `docs/HUMAN_ACTIONS_REQUIRED.md`.

## 5. Controlled human-testing release

The product is ready for a human to exercise the real path:

- **Console:** https://overcover.vercel.app/ (served `ui/index.html` is byte-identical to this branch).
- **Procedure:** `docs/HUMAN_ACCEPTANCE_TEST.md` — open, connect a testnet wallet, buy `heat-lagos`
  (expected premium 0.005 NEAR), confirm the extension shows exactly one `buy_cover` to
  `contract.ovc-v3-ctl-2f6c4c.testnet`, then verify the policy and the transaction on-chain.
- **What it proves:** a human, with their own wallet, can buy cover on the hardened v3 default, and
  the console signs exactly one `buy_cover`.
- **What it does not prove:** nothing about the legacy v1 address. The recorded human purchase in
  project history was on **v1** and must never be read as a v3 human purchase.
- **Safety:** the console holds no key; a failed read is shown as stale/"no data", never live; the
  wallet's key is scoped to `buy_cover` alone.

## 6. Deployment and repository state (accurate as of this HEAD)

| Item | Value |
| --- | --- |
| Production URL | https://overcover.vercel.app/ — `/` byte-identical to `ui/index.html` on this branch |
| Default contract | `contract.ovc-v3-ctl-2f6c4c.testnet` (code hash `CQR8x1kW…`, wasm `a97034e6…`) |
| Legacy contract | `contract.attestor-overcover.testnet` (code hash `36koHoSd…`, v1; readable, buying refused) |
| Source vs deploy | source builds to `811e0427…`; the live default predates it (SEC-6/7/9 not deployed) |
| Hardened reference (authority held) | `contract.ovc-v3-ctl-mwgci3u8.testnet` (`811e0427…`, 40/40, owner key held) |
| This branch | `feat/owner-authority-reconciliation-testnet` @ `c8a32f5d` (+ this mission's commit) |

## 7. Remaining risks (honest list)

1. **SEC-1 on legacy v1 is live and uncontained at the contract level.** Permissionless takeover;
   would strand 18.55 NEAR and 10.50 NEAR of live obligations. Contained in the console, disclosed,
   **not repaired** — needs the legacy key.
2. **SEC-6/7/9 not deployed on the default v3.** A reservation on a reading that is never reported can
   stay reserved until the challenge path resolves it. A liveness/termination gap, not a theft path.
3. **No professional audit.** The adversarial suites are the project's own.
4. **`elliptic` low advisory** in the shipped bundle; no non-breaking fix.
5. **Human v3 purchase outstanding.** Every automated path is proven; the live extension approval is not.
6. **Indexing not confirmed** (access is confirmed; indexing needs an external account).

## 8. Recommendation

**Ready for controlled human testing on testnet, with the risks above stated to any participant.**
Not ready for real funds (testnet, unaudited, SEC-6/7/9 undeployed). The path to a durable successor
is defined in `reports/SUCCESSOR_DEPLOYMENT_READINESS.md` and needs one owner action — durable key
custody — and no new engineering.
