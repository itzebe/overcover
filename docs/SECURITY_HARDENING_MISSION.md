# Security-hardening & discoverability mission — report

**Branch:** `feat/overcover-security-hardening-discoverability`
**Baseline (merge-base):** `ec772475748a4159aa3945c40dcc1bd19c930c1e` (squash of PR #42; parent `ad1d59e`)
**Report head:** `4495da6449a8374ba4b0182850250219a5529667`
**Production:** https://overcover.vercel.app/ · **Default contract (hardened v3):** `contract.ovc-v3-ctl-2f6c4c.testnet`
**Legacy address (v1, readable, not a purchase destination):** `contract.attestor-overcover.testnet`

This is an execution report. Every claim below is backed by a command that was run or an on-chain
artefact that can be re-read. Where something is blocked, it says so plainly. Where a check was
skipped, it says so. Nothing here is asserted because "the suite is green".

---

## 1. What was actually done

| Workstream | Outcome |
| --- | --- |
| **A. PR #42 (CSP + buying-lock)** | Reviewed, independently reproduced the mutation test, full gate green, **merged** to `main` (`ec77247`). |
| **B. Legacy v1 SEC-1 takeover** | Built a **positive, reproducible** attack (`proof/sec1-takeover.mjs`): the exact live v1 bytecode is taken over by an unprivileged account, and the hardened module refuses the same call. 17/17. Wired into CI. |
| **C. v3 SEC-6/7/9 deploy** | Canonical build reproduced (`811e0427…`); `driver/redeploy-v3.mjs --plan` verified against the live account. The deploy itself needs the operator key, which is **not present** → blocked by human authority. |
| **D. OutLayer** | Independently verified the POC's real Intel TDX quote (`UpToDate`) **and** ran a **fresh live** OutLayer execution whose attestation verifies offline. POC lives on PR #41 (separate). |
| **E. Human v3 acceptance** | Prepared; requires a human-held testnet wallet. **Blocked by human action** (unchanged). |
| **F. Institutional website / discoverability** | Added a genuine FAQ + `FAQPage` structured data (no fabricated content). Verified the deployed crawler config and machine-readable docs over HTTP. |
| **G. Release gate** | Full suite re-run on the branch head; results in §6. |

---

## 2. Vulnerability descriptions, root causes, and fixes

### SEC-1 — CRITICAL — the v1 `migrate()` is unauthenticated (legacy address)

**Where:** `contract/src/lib.rs`, `pub fn migrate`, in the **deployed v1** module.
**Root cause.** `migrate` is declared `#[init(ignore_state)]`. A NEAR `init` method runs before any
state is read, so it cannot consult the stored `owner`; as written it accepts `owner`, `attestor`,
`challenge_bond`, `settle_delay_sec` and `challenge_window_sec` from the caller and writes a brand
new `Self`, with no caller check.
**Fix (v2/v3, already merged via PR #9).** A self-call guard:

```rust
ensure!(
    env::predecessor_account_id() == env::current_account_id(),
    "migrate may only be called by the contract account itself"
);
```

**What this mission added.** The existing SEC-1 tests only asserted the **v2 guard** — they pass on the
fixed code and would also pass on a fixed-but-unrelated module; they never demonstrated the attack.
`proof/sec1-takeover.mjs` closes that gap: it reads the **live** v1 module from RPC, checks its sha256
equals the pinned deployed build (`1f30ccf1…`), deploys it to a local neard node, builds real value at
risk, and performs the takeover.

**Exploit reproduction (positive), `npm run verify:sec1-takeover` → 17/17:**

```
PASS  the v1 module under test is the live deployed build  — 1f30ccf1d4c735ad…
PASS  a provider deposited real capital into the pool  — capital=20000000000000000000000000
PASS  control: the provider can withdraw their own capital before the attack  — withdraw ok
PASS  SEC-1 VULN: an unprivileged third party's migrate() SUCCEEDS on v1  — migrate accepted
PASS  SEC-1 VULN: the owner is replaced by the attacker  — owner=attacker.test.near
PASS  SEC-1 VULN: the attacker's key becomes the attestor
PASS  SEC-1 VULN: the pool accounting is reset (capital 0, reserved 0)
PASS  SEC-1 VULN: the provider can no longer withdraw (capital stranded)
PASS  SEC-1 VULN: the attacker can call the owner-only add_product()  — accepted
PASS  SEC-1 VULN: the attacker can forge a signed observation with their own key  — accepted
PASS  FIX: the same third-party migrate() is REFUSED by the hardened v2 module
PASS  FIX: the attacker does NOT become the owner after the refused migrate()
PASS  FIX: the attacker does NOT become the attestor after the refused migrate()
PASS  FIX: the contract account's own migrate() (the real v1->v2 upgrade path) is allowed
PASS  FIX: after the self-call the migrated account reports the intended owner
PASS  the hardened v2 module has a different on-chain code hash from v1
```

**Bounded impact (honest scope).** The takeover replaces authority and destroys the accounting. The
attacker cannot sweep the contract's NEAR *account balance* directly: `withdraw` requires being a
provider and is capped at what that provider deposited, and payouts are capped by the internal
`capital` counter, which only grows with real deposits. The realistic loss is the pool's stranded
capital and the authority to redirect a payout to an attacker-chosen beneficiary.

**Live state (2026-11-12, read over public RPC).** The legacy contract is **not paused**:
`get_pool()` returns `paused: false`. Buying is blocked on the legacy address **only in the frontend**
(the console's buy gate refuses any non-hardened code hash). The contract-level control the operator
should apply is `set_paused(true)` on the legacy address — an owner-only call requiring the legacy
owner key, which this environment does not hold. See §7.

**Regression tests:** `npm run verify:sec1-takeover` (17/17); the Rust guard tests
(`migrate_by_a_third_party_is_refused`, `sec1_a_third_party_cannot_migrate`, …); `npm run verify:upgrade`
(8/8) and `npm run verify:upgrade-preservation` (state preserved) on the compiled wasm.

### SEC-6 / SEC-7 / SEC-9 — HIGH — reservation not released on terminal settlement; unbounded lead

**Status.** Fixed in source; **not yet deployed** to `contract.ovc-v3-ctl-2f6c4c.testnet`. The live
module is `a97034e6…` (500023 bytes); the fixed source builds to `811e0427…` (500342 bytes). This is a
**deployment** gap, not a code gap.

**Root cause.** A settled policy left its reservation counted against available capital (SEC-6), so the
pool under-reported free capital and a provider's `withdraw` could be blocked by a reservation that was
already spent. SEC-9 allowed an observation date too far in the future.

**Fix (in source).** Release the reservation on terminal settlement; bound the observation lead.

**Evidence.** `npm run verify:sandbox` → **28/28**, including
`SEC-6 the pool still reconciles and is solvent` and
`SEC-6 a locked reservation would have blocked withdraw (now it does not)`. `npm run verify:proof` prints
`SOURCE AHEAD OF DEPLOYMENT` for the live module. The deploy is prepared and verified by plan (§3).

---

## 3. Deployment state and the operator action (blocked by human authority)

**Canonical build (must match to reproduce the hash):**

```bash
CARGO_HOME=/home/openhands/.cargo cargo build --manifest-path contract/Cargo.toml \
  --target wasm32-unknown-unknown --release      # NOTE: no `+stable`
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm   # expect 811e0427…
```

The `+stable` flag resolves to a different toolchain and produces a different (larger, 501621-byte)
module — a reproducibility trap worth recording.

**Plan verified (sends nothing):**

```
$ OVC_EXPECTED_SHA=811e0427… node driver/redeploy-v3.mjs --plan
target account : contract.ovc-v3-ctl-2f6c4c.testnet (testnet)
current code   : code_hash CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL
                 sha256    a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1
new code       : sha256    811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f  (500342 bytes)
operation      : DeployContract(contract.ovc-v3-ctl-2f6c4c.testnet, <wasm>) — code only, no new()/migrate()
rollback       : re-run with the previous module (sha256 a97034e6…); also code-only.
```

**Blocker.** The actual deploy requires the contract account's operator key
(`OVC_V3_SECRET_KEY`, or a gitignored `keys/v3-operator.json`). Neither is present in this
environment, and the mission forbids altering the production contract without authorization. The
deploy is a code-only `DeployContract` to the same account (state preserved), and it is fully scripted
and verified by plan; it needs the operator's single signature.

---

## 4. OutLayer (attested external observations) — independent verification

The OutLayer integration is a **POC on PR #41** (`feat/outlayer-attested-observation-poc`), kept as a
separate concern. This mission independently verified it rather than trusting its report:

- **Recorded execution:** `node bin/verify-attestation.mjs fixtures/outlayer-real/{attestation,quote}.bin`
  → `task_hash_matches: true`, `intel: { ok: true, status: "UpToDate" }` — the Intel TDX signature and
  TCB verify, and the quote's `report_data[0..32]` binds the execution.
- **Fresh live execution:** registered a new anonymous testnet wallet, ran a real OutLayer-hosted
  execution (`connector-probe`), fetched its attestation, and verified it offline:
  `task_hash_matches: true`, `intel: { ok: true, status: "UpToDate" }`, `measurements_approved: true`.
- **POC suites:** `test/outlayer-real.test.mjs` **17/17**, `test/adversarial.test.mjs` **17/17**.

**Honest scope.** The *Overcover adapter* was not run on OutLayer (that needs the project deployed on
chain via `outlayer deploy`, which needs a NEAR FullAccess signature the operator has not authorised).
The recorded and fresh executions use the platform's `connector-probe`. The attestation *mechanism* —
the part that was previously simulated — is proven against real Intel TDX quotes. The remaining gap is
a deployment action, not an unverified mechanism.

---

## 5. AI / search-engine discoverability — HTTP-verified on production

Every endpoint was fetched from `https://overcover.vercel.app` and checked for status and content.

| Endpoint | Status | Note |
| --- | --- | --- |
| `/` | 200 | initial HTML carries `<title>`, description, canonical, Open Graph, Twitter, and JSON-LD |
| `/robots.txt` | 200 | allows `*`, `GPTBot`, `OAI-SearchBot`, `ChatGPT-User`, `ClaudeBot`, `Claude-Web`, `PerplexityBot`, `Googlebot`, `Bingbot`, `Google-Extended`, `Applebot-Extended`; points at the sitemap |
| `/sitemap.xml` | 200 | valid XML; one `<loc>` (`https://overcover.vercel.app/`) |
| `/llms.txt` | 200 | accurate product/contract summary |
| `/llms-full.txt` | 200 | full machine-readable technical overview |
| `/products.json` | 200 | regenerated from the live v3 contract (`products:feed`); 2 products, solvent |
| `/products.schema.json` | 200 | JSON Schema for the catalogue |

**Structured data.** The served HTML contains one `application/ld+json` `@graph` with
`Organization`, `WebSite`, `SoftwareApplication`, `WebPage` and (new) `FAQPage` (8 questions). It
parses as valid JSON. No ratings, reviews, customers, partnerships or adoption figures are fabricated.

**Semantic content.** The page states what Overcover is, the problem, who uses it, how parametric
insurance works, how agents buy, how capital is reserved, how the oracle and disputes work, how
settlement is verified, which contract is current and which is legacy, and what is testnet/unaudited.

**Honest limitation.** Crawler *access* is allowed and verified; **indexing** has not been observed.
No access to Google Search Console or Bing Webmaster Tools is available here, so no indexing claim is
made.

**New in this mission:** `docs/SECURITY_HARDENING_MISSION.md` (this file) plus the FAQ section and
`FAQPage` JSON-LD in `ui/index.html`.

---

## 6. Release gate — results on the branch head

All commands were run on this branch. Counts are the real output.

| Check | Command | Result |
| --- | --- | --- |
| Reference adversarial model | `npm run test:model` | 74/74 defended, 0 exploitable |
| Contract unit tests | `npm run test:contract` | 88 passed |
| Console + wallet journey | `npm run test:console` | 116 passed |
| Agent limits / API / OpenAPI | `npm run test:agent` | 53 passed |
| Product feed + agent eval | `npm run test:agent-eval` | 33 passed |
| Deploy fail-closed regression | `npm run test:deploy` | 21 passed |
| Independent proof | `npm run verify:proof` | 13/13 |
| SEC-1 takeover (positive) | `npm run verify:sec1-takeover` | 17/17 |
| SEC-1 guard on compiled wasm | `npm run verify:upgrade` | 8/8 |
| In-place upgrade preserves state | `npm run verify:upgrade-preservation` | state preserved, migrated policy settled |
| v3 lifecycle (local sandbox) | `npm run verify:sandbox` | 28/28 |
| Controlled v3 deploy (sandbox) | `npm run verify:controlled-v3:sandbox` | 39/39 |
| Permissionless factory | `npm run verify:factory` | 22/22 |
| Connectivity | `npm run verify:connectivity` | 13/13 |
| Live production URL | `npm run verify:live` | pass (5 widths) |
| Agent spend-authorization | `npm run verify:agent` | pass |
| Accessibility | `npm run axe` | 0 violations at 320–1440 px (page + wallet dialog) |
| UI QA | `npm run ui:qa` | 7 viewports + agent dry-run OK |
| Dependency audit | `npm audit` | 0 high, 0 critical, 0 moderate; 19 low (transitive, see §7) |
| Live adversarial (needs keys) | `npm run test:onchain` | **skipped/fail-closed** — needs `keys/identities.json` |

**`test:onchain` is not a pass.** It fails closed with
`missing /workspace/project/overcover/keys/identities.json; run: node driver/keys.js`. It is
environment-gated and needs a funded testnet root; it is reported as skipped, not green.

---

## 7. Remaining risks and items requiring human or external authority

1. **Legacy v1 is not paused on-chain (SEC-1).** Containment is the console buy gate; the contract
   method is still callable. **Action:** the legacy owner should call `set_paused(true)` (owner-only).
   This needs the legacy owner key, which is not held here.
2. **v3 SEC-6/7/9 not yet deployed.** The live module is `a97034e6…`; the fix is `811e0427…`. The
   deploy is scripted and verified by plan; **action:** the operator runs
   `OVC_EXPECTED_SHA=811e0427… node driver/redeploy-v3.mjs` (code-only, same account, reversible).
3. **Human wallet purchase on v3 is not yet done.** PR #39's recorded human purchase was on the
   **legacy v1** contract and is labelled as such; a genuine human approval on the hardened v3 default
   is the outstanding acceptance test. **Action:** a human with a testnet wallet completes one
   `buy_cover` on `contract.ovc-v3-ctl-2f6c4c.testnet`.
4. **`npm audit` low findings (19).** All low, all transitive through the wallet-selector tree; no high
   or critical. Assessed as acceptable for a testnet prototype; no advisory was suppressed.
5. **OutLayer adapter not deployed.** The attestation mechanism is verified against real TDX quotes;
   running the *Overcover adapter* needs `outlayer deploy` (operator FullAccess signature).
6. **Indexing not observed.** Crawler access is verified; Search Console / Bing Webmaster access is not
   available, so indexing is not claimed.
7. **PR #39 not merged.** It is independently reviewed here: its recorded human purchase is on legacy
   v1 and is correctly labelled; merging is left to the maintainer.

---

## 8. Non-negotiable rules honoured

- Executed, not merely audited. Product vision preserved; no new product, no business-model change.
- No invented findings, no fabricated transactions, no production funds, no credentials exposed, no
  paid services, no mainnet deploys, no unauthorised production change.
- PR #39 was not closed or merged. No independent audit is claimed — this is a self-run campaign.

---

## 9. How to reproduce

```bash
npm ci --ignore-scripts
CARGO_HOME=/home/openhands/.cargo cargo build --manifest-path contract/Cargo.toml \
  --target wasm32-unknown-unknown --release         # canonical wasm 811e0427…
npm run verify:sec1-takeover                        # 17/17 — the v1 takeover, on the real bytecode
npm run verify:sandbox && npm run verify:upgrade-preservation
npm run test:console && npm run axe && npm run ui:qa
node driver/redeploy-v3.mjs --plan                  # prints the pending v3 deploy; sends nothing
```

The SEC-1 harness needs a local `neard` sandbox; set `REQUIRE_SANDBOX=1` to make a missing node a
failure rather than a silent skip (CI does this).
