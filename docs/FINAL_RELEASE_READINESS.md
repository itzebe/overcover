# Final release readiness register

**As of:** 2026-11-11 · **Repository:** https://github.com/itzebe/overcover · **Branch:** `main`
**Contract:** `contract.attestor-overcover.testnet` (NEAR testnet) · **Production:** https://overcover.vercel.app/

This register states, for every requirement, exactly what exists, what was tested, the evidence, and
whether it needs fixing. A status is only **FIXED AND VERIFIED** when there is a reproducible command
or an on-chain artefact behind it. Where something is not verified, it says so.

Statuses: `FIXED AND VERIFIED` · `IMPLEMENTED BUT NOT VERIFIED` · `PARTIALLY WORKING` · `BROKEN` ·
`NOT IMPLEMENTED` · `BLOCKED BY HUMAN ACTION` · `BLOCKED BY EXTERNAL SERVICE` · `NOT APPLICABLE`.

Reproduce the whole thing:

```bash
npm ci --ignore-scripts
npm run test:model && npm run test:contract && npm run test:console && npm run test:agent
npm run verify:proof        # 12/12 — needs cargo build for the bytecode check
npm run verify:agent        # limits engine vs the live product
npm run verify:connectivity # 12/12 — public console needs no local agent
npm run verify:live         # production URL at 5 widths
npm run axe                 # 0 violations, page + dialog
npm run ui:qa               # 7 viewports, real agent round-trip
```

---

## 1. Product

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Core insurance functionality | FIXED AND VERIFIED | `contract/src/lib.rs`: products, policies, pool, reservations, signed oracle, bonded disputes, deterministic settlement. | 21 Rust unit tests pass; 31-attack reference model `31 defended, 0 exploitable`; the live demo ran the full cycle (18 txs, `demo-log.json`). |
| Product discovery | FIXED AND VERIFIED | `list_products` view; console offers only *sellable* products (named, payable, active) and groups everything else as clearly-labelled fixtures. | Live `list_products` returns 22 products (2 named: `rain-lagos`, `rain-bergen-dry`; 20 demo-generated). `rain-bergen-dry` pins its trigger at the contract's plausible ceiling (500.0 mm), so it can only pay on that single reading — a broken definition shown as a fixture, not offered as cover; `rain-lagos` renders as a coverage card. `tests/console.test.js`; live probe. |
| Premium calculation | FIXED AND VERIFIED | `quote(product_id, payout) = ceil(payout × premium_bp / 10_000)`, computed in the contract. | `quote` read live (`0.0500 NEAR` for 1 NEAR at 500 bp); console re-reads the contract's quote before buying (`tests/console.test.js`). |
| Payout calculation | FIXED AND VERIFIED | Payout is the amount reserved at purchase; `resolve` pays iff `value_tenths ≥ threshold_tenths`. | Policy 3 settled `settled_paid` (1 NEAR paid); policy 4 `settled_no_pay` (0). `verify:proof` asserts both. The console's hero and cards state the **≥** direction, derived from `threshold_tenths`. |
| Policy creation | FIXED AND VERIFIED | `buy_cover` charges the product premium, reserves the payout, returns the policy id. | Policies 1–15 on-chain; agent buys → policies 11, 12; `verify:proof` ties each agent tx to its policy. |
| Policy retrieval | FIXED AND VERIFIED | `get_policy(id)`, `list_policies()`. | Read live; console "Policies written" reads them; `verify:proof` re-reads them. |
| Policy status | FIXED AND VERIFIED | Contract stores `status` ∈ `active`/`settled_paid`/`settled_no_pay`; `paid_amount`, `settled_at`. The console shows the stored status verbatim and derives "settlement due — awaiting resolve()" for a past-due active policy (never a fabricated settlement). | `verify:proof`: settled_paid paid > 0, settled_no_pay paid 0. Derivation covered by `tests/console.test.js`. |
| Insurance terms and conditions | FIXED AND VERIFIED | Product fields (threshold, premium, bounds, lead, capacity) are immutable; console states the parametric limitation on every card and the observation-date rule derived from the product's own lead. | `e1_threshold_is_owned_by_the_product` (Rust); console asserts the limitation text is shown. |

## 2. Human wallet

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| HERE Wallet | FIXED AND VERIFIED (integration) | `@near-wallet-selector/here-wallet`; app/web flow, no extension needed. | Present in the shipped bundle and picker; `verify:connectivity` loads the real page + bundle. Live extension sign-in **BLOCKED BY HUMAN ACTION** (see §9). |
| Meteor Wallet | FIXED AND VERIFIED (integration) | `@near-wallet-selector/meteor-wallet`; injected-only, honestly probed. | Picker disables Meteor when no injected provider; `tests/console.test.js` asserts the disabled state + install link. Live extension sign-in **BLOCKED BY HUMAN ACTION**. |
| MyNearWallet | NOT APPLICABLE | Retired from the picker, bundle and dependency tree — it no longer accepts new application connections. | `tests/console.test.js` asserts no MyNearWallet reference ships. |
| Wallet connection | FIXED AND VERIFIED | `<dialog>` picker; 90 s connect timeout; honest availability probe. | `ui:qa` opens the picker in-viewport; `verify:connectivity`; `tests/console.test.js`. |
| Account identification | FIXED AND VERIFIED | `selector.store.observable` keeps the account id in sync; returned on connect. | `tests/console.test.js`; `wallet.js` status snapshot. |
| Testnet verification | FIXED AND VERIFIED | Network fixed to `testnet`; a mainnet wallet is a reported mismatch. | `wallet.js` `NETWORK_ID`; `tests/console.test.js`. |
| Quote retrieval | FIXED AND VERIFIED | `doBuy` re-reads `quote` from the contract before signing. | `tests/console.test.js`; live quote shown. |
| Transaction construction | FIXED AND VERIFIED | `buildBuyArgs` → `{product_id, payout, obs_date, beneficiary}`; deposit = contract premium; payout stays an exact u128 string. | `tests/console.test.js`: ABI match, empty beneficiary → null, payout not rounded. |
| Wallet signing | IMPLEMENTED BUT NOT VERIFIED (live) | `signAndSend` passes exactly the caller's action; the wallet signs. | Unit-tested shapes; `verify:connectivity` loads the bundle. A live HERE/Meteor extension approval is **BLOCKED BY HUMAN ACTION**. |
| Transaction confirmation | FIXED AND VERIFIED | `evaluateWalletOutcome` claims success only from the wallet's own confirmed hash. | `tests/console.test.js`: rejected/failed/hashless results are never success. |
| Failure and rejection handling | FIXED AND VERIFIED | Rejection → "Purchase not completed", nothing charged; no silent success. Connect errors are mapped to actionable sentences (cancelled / pop-up blocked / wrong network / unreachable / no account). | `tests/console.test.js` (the fake-success guard; the wallet-error mapping). |
| Policy ownership verification | FIXED AND VERIFIED | Policy `buyer` is the signer; read back from the contract. | Policy 15 `buyer = human-demo-…`; policies 11,12 `buyer = oc-agent-…`. |

**Human purchase (end to end).** The `buy_cover` **shape the console builds** is proven on-chain:
tx `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i` → policy 15 (`rain-lagos`, 1 NEAR payout,
0.05 NEAR premium, `active`). That transaction was signed **programmatically** with the page's exact
arguments — it is **not** a recording of a live extension approval. Status of the live-extension
step: **BLOCKED BY HUMAN ACTION**.

**Observation-date guard (new this mission).** The page will not ask the wallet to sign a
`buy_cover` whose `obs_date` the contract would refuse. `min_lead_sec` is 0 for every published
product, so the old check (`obs_date >= now + min_lead_sec`) allowed a date a second away. The page
now requires a date at least 120 s ahead (`obsDateFloorSec`), tested in `tests/console.test.js`.

## 3. Autonomous AI agent

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Independent NEAR account | FIXED AND VERIFIED | `oc-agent-mwb87z4k.testnet`, its own ed25519 key. | On-chain: signer of txs `7iG4WWy1…` and `26UvFN3A…`; holds 0.844 NEAR. |
| Secure signing | FIXED AND VERIFIED | Key read from `OVERCOVER_AGENT_SECRET_KEY` at start-up; never written, logged or returned. | `verify:connectivity` check 7 (no key in shipped assets/tracked files); `tests/agent-api.test.mjs` (health carries no key). |
| Product discovery | FIXED AND VERIFIED | `agent.decide` reads `get_product` from the contract. | `verify:agent` runs the shipped `createAgent/decide` path against the live product. |
| Quote evaluation | FIXED AND VERIFIED | `agent.quote` reads the contract `quote`. | `verify:agent`; `tests/agent-limits.test.mjs`. |
| Autonomous purchase | FIXED AND VERIFIED | `agent.buy` signs exactly one `buy_cover`, deposit = the contract quote. | On-chain: policies 11 (rain-lagos, 1 NEAR) and 12 (rain-bergen-dry, 0.5 NEAR). |
| Authorization | FIXED AND VERIFIED | `limits.mjs` `evaluate` is the single allow/deny point; a denial returns before any RPC. | `verify:agent`: over-limit refused, in-limit permitted, the shipped path agrees. |
| Spending limits | FIXED AND VERIFIED | Per-policy premium/payout caps, rolling 24 h premium budget and policy count, cooldown, allow-lists. | `tests/agent-limits.test.mjs`; `verify:connectivity` check 9 (403 with reasons). |
| Balance checks | FIXED AND VERIFIED | `balanceYocto()`; an unfunded account reads as "no balance", not an error. | `GET /api/v1/agent` returns `balanceYocto`; the agent account reads 0.844 NEAR. |
| Idempotency | FIXED AND VERIFIED | Same `Idempotency-Key` returns the original result; the buy is not re-executed. | **New regression test** `tests/agent-api.test.mjs`: a replayed key appends no second audit entry and returns the original premium. |
| Transaction verification | FIXED AND VERIFIED | `buy` inspects the outcome status; a `Failure` throws `AgentError("chain")`. | `agent.mjs` `failureMessage`; agent txs resolve with `SuccessValue`. |
| Policy retrieval | FIXED AND VERIFIED | Policy ids 11, 12 read back with the agent as buyer. | `verify:proof` ties each agent tx to its policy. |
| Audit records | FIXED AND VERIFIED | Every decision/refusal/dry-run/buy appended to a JSONL audit log (no key material). | `tests/agent-api.test.mjs` idempotency tests read the audit log. |
| Emergency kill switch | FIXED AND VERIFIED | `POST /api/v1/agent/control {"enabled":false}` stops all buying; persisted to the audit log. | `tests/agent-api.test.mjs`: a disabled agent refuses with 403 before the network; re-enabling restores it. |

## 4. Security

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Secret exposure | FIXED AND VERIFIED | No key in source, bundle, page or tracked files. | CI step "Fail if a secret is tracked"; `verify:connectivity` check 7; a repo-wide search found no key material. |
| Private-key protection | FIXED AND VERIFIED | Browser holds no key; the agent key is environment-only. | `docs/SECURITY.md`; `wallet.js` design rules; `verify:connectivity` check 7. |
| Arbitrary contract calls | FIXED AND VERIFIED | The wallet key is scoped to `buy_cover`; the agent calls only `buy_cover`. | `verify:connectivity` checks 8 and 10; `tests/console.test.js`. |
| Unauthorized spending | FIXED AND VERIFIED | `limits.mjs` denies before any RPC; the contract is the final authority. | `verify:agent`; `tests/agent-limits.test.mjs`; `verify:connectivity` check 9. |
| Request validation | FIXED AND VERIFIED | 8 KB body cap, JSON-only, known-fields-only, integer-string money. | `tests/agent-api.test.mjs`: 413 / 400 / unknown-field / non-integer. |
| Replay protection | FIXED AND VERIFIED | Oracle signatures bind city, date, value, `reported_at`, a single-use nonce, **and the contract id**; idempotency keys for buys. | Rust `b6`/`b7`; adversarial "replayed nonce" and "cross-contract" cases; the new idempotency tests. |
| API authentication | NOT APPLICABLE (by design) | The agent service binds to `127.0.0.1` by default and is dry-run by default; a public endpoint that signs with a funded key would let any visitor spend it. | `agent/server.mjs`; `agent/README.md` states the honest configuration. |
| Rate limits | PARTIALLY WORKING | Cooldown + rolling budgets are per-process, not a distributed limit. | Documented in `agent/README.md` "What is *not* claimed". |
| Denial-of-service exposure | FIXED AND VERIFIED | Body cap with a drain (the socket is not destroyed, so the client still gets a 413). | `tests/agent-api.test.mjs` oversized-body test. |
| Error handling | FIXED AND VERIFIED | Contract refusals carry a human-readable `panic_utf8` reason; the agent surfaces it. | Rust tests; adversarial tests assert the expected reason; `failureMessage`. |
| Logging and audit integrity | FIXED AND VERIFIED | Audit log holds no key material; a write failure is surfaced on stderr, never silently dropped. | `agent.mjs` `appendAudit`; `tests/agent-api.test.mjs`. |

## 5. Production

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Vercel deployment | FIXED AND VERIFIED | Project `overcover`; production alias `overcover.vercel.app`. | `GET /v6/deployments?…&target=production` shows a READY production deployment. |
| Correct deployed commit | FIXED AND VERIFIED | The production deployment's `meta.githubCommitSha` matches `main` (`18ec7f0` at the time of writing). | `GET /v6/deployments`; the served `index.html` sha256 equals the working-tree file. |
| API availability | NOT APPLICABLE | The console is a static page reading public NEAR RPC; there is no product API. | — |
| Browser functionality | FIXED AND VERIFIED | Page loads and renders live contract state. | `verify:live` (5 widths, 0 console errors); browser probe: 0 console errors. |
| Wallet compatibility | FIXED AND VERIFIED (integration) | HERE + Meteor; honest availability. | `verify:connectivity`; `ui:qa`. Live extension approval BLOCKED BY HUMAN ACTION. |
| Mobile responsiveness | FIXED AND VERIFIED | Reflows to 320 px, no horizontal overflow. | `verify:live` and `ui:qa` at 320–1440 px. |
| Console errors | FIXED AND VERIFIED | Zero across widths. | `verify:live`, `ui:qa`. |
| Production configuration | FIXED AND VERIFIED | `vercel.json`, root-dir output `ui`, no build step; `ui/vendor/*` bundles are tracked. | Deployed HTML hash == local; a clean clone runs with no build step. |

**Contract version.** The deployed contract is **v1** (`contract.attestor-overcover.testnet`, code hash
`36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2rK`, wasm sha256 `1f30ccf1…`). The console reads v1 and
renders v1 semantics; it is also compatible with the v2 contract in PR #9 via a version gate
(`CONTRACT_V2`). **v2 is implemented and proven in a local sandbox but not deployed** (see the honest
list below).

## 6. Hackathon readiness

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Product explanation | FIXED AND VERIFIED | `README.md`, `SUBMISSION.md`, console hero and sections. | Reviewed; claims traced to contract state. |
| Problem and solution clarity | FIXED AND VERIFIED | Problem → solution → tracks → why NEAR, in `SUBMISSION.md` §1–4. | Reviewed. |
| Technical differentiation | FIXED AND VERIFIED | Immutable products, reserved capital, challengeable oracle, on-chain reasons. | `SUBMISSION.md` §8; Rust + model tests. |
| Real working demonstration | FIXED AND VERIFIED | Live console + `demo-log.json` (18 real txs) + agent purchases. | `verify:proof` 12/12. |
| Demo reliability | FIXED AND VERIFIED | The console reads live and degrades to stale/"no data"; a backup procedure is in `docs/JUDGE_DEMO.md`. | Honest read states tested (`tests/console.test.js`). |
| Documentation | FIXED AND VERIFIED | `README`, `SUBMISSION`, `docs/*`, `proof/README`, `agent/README`. | Counts corrected to the real values. |
| Submission accuracy | FIXED AND VERIFIED | The human-path section now states the programmatic-vs-extension distinction plainly. | This register; `SUBMISSION.md` §6. |
| Judge-facing evidence | FIXED AND VERIFIED | `docs/JUDGE_DEMO.md` (script, checklist, backup) + `proof/` + explorer links. | This mission. |

---

## Defects found and fixed in this mission

1. **The hero stated the trigger direction backwards.** The hero read *"rainfall below a set
   level"*, but the contract's `resolve` pays when the reading is **≥** the product threshold
   (Above). A buyer reading the hero would expect the opposite policy. Root cause: hand-written copy
   that had drifted from the contract rule. Fix: the hero and every product card now state the
   trigger as "at or above", derived from `threshold_tenths`. Regression: `tests/console.test.js`
   asserts the corrected hero wording and the derived coverage sentence.
2. **A "future" observation date could be seconds away.** `min_lead_sec` is 0 for every published
   product, and `obs_date` is compared in whole seconds, so a date one second ahead passed the page's
   check and the wallet would sign a `buy_cover` the contract then refuses ("observation date too
   soon"). Root cause: the guard trusted `min_lead_sec` alone. Fix: `obsDateFloorSec` /
   `obsDateError` require a date at least 120 s ahead, enforced **before** the wallet is asked to
   sign. Regression: two new tests (zero-lead floor; product lead precedence).
3. **Policy status could imply a settlement that never happened.** The table rendered the stored
   `status` verbatim, so a past-due policy the contract had not settled still read *"active"* with no
   hint it was awaiting settlement. Fix: `policyDisplayStatus` derives *"settlement due — awaiting
   resolve()"* from the settlement rule (`status==active AND now >= obs_date + settle_delay_sec`);
   terminal statuses are shown verbatim. Regression: three new tests.
4. **A product with a broken definition was offered as live cover.** `rain-bergen-dry` has
   `threshold_tenths = 5000`, exactly the contract's `MAX_RAINFALL_TENTHS` (500.0 mm). Because
   `report_observation` rejects any reading **above** that ceiling and `resolve` pays when
   `value >= threshold`, the product can only ever pay on the single reading 500.0 mm — a definition
   mistake, not a real offering. Root cause: the product was treated as an ordinary offering. Fix:
   `triggerAtCeiling` detects it from contract data and it is grouped with the other non-sellable
   fixtures, labelled, and not offered as cover. Regression: `tests/console.test.js` asserts the
   detection and the disclosure.
5. **Wallet connect errors were raw and unhelpful.** HERE/Meteor errors surfaced as
   `Could not connect: <raw>`. Fix: `connectErrorMessage` maps rejection / pop-up-blocked / wrong
   network / unreachable / no-account to actionable sentences and keeps the raw text for unclassified
   cases; a possible network mismatch is surfaced. Regression: `tests/console.test.js`.
6. **`npm run verify:proof` and `npm run verify:agent` crashed on a clean clone.** Both read
   `agent/audit.log.jsonl`, which is gitignored, so the two headline "independent proof" commands —
   the ones a judge runs first — died with `ENOENT` on any fresh checkout. Root cause: evidence for
   the agent's purchases lived only in the operator's local, untracked audit log. Fix: added a
   committed evidence file `proof/agent-purchases.json` (hashes, policy ids, products, amounts) and
   made `verify:proof` **re-derive every claim in it from the chain** — the tx signer must be the
   agent, the call must be `buy_cover` for the stated deposit, and the policy's buyer/product/payout/
   premium must match. Regression: run `npm run verify:proof` on a clean clone (verified in
   `/tmp/clean`).
7. **`verify:proof` used `JSON.parse` for contract views**, rounding u128 money fields above 2^53 and
   making the new payout/premium equality checks fail spuriously (the recurring precision trap). Fix:
   it now uses the shipped `parseBigIntJson`. `verify:proof` went from 11/12 to 12/12.
8. **No idempotency regression test.** Idempotency was implemented and claimed but unproven. Fix:
   added two tests to `tests/agent-api.test.mjs` proving a replayed key returns the original result
   and does not re-execute (audit-log-based), and that distinct keys are fresh evaluations.
9. **`docs/SECURITY.md` under-reported the console test count.** Fixed.
10. **`SUBMISSION.md` human-path section could be read as a live wallet approval.** Rewrote it to
    state plainly that the on-chain transaction was signed programmatically with the page's exact
    arguments, that a live extension approval is not captured, and how a judge completes it.
11. **CI did not run the independent proof.** Added `verify:proof` and `verify:agent` to
    `.github/workflows/ci.yml`, so the "deployed bytecode == this source" claim is checked on every
    push.
12. **The wasm build was not byte-reproducible across build environments.** Once CI ran
    `verify:proof`, the bytecode check failed (`4172cd8e…` vs the deployed `1f30ccf1…`) even though
    the toolchain was identical (`rustc 1.99.1 (58cf8f9c3)`), the committed `Cargo.lock` resolved the
    same dependency versions, and the target was the same. Root cause, isolated by experiment: the
    wasm embeds the **absolute path of the cargo registry** (17 occurrences, e.g.
    `/home/openhands/.cargo/registry/src/index.crates.io-…/near-sdk-5.30.1/src/promise.rs`), so the
    bytes depend on `CARGO_HOME` at build time. Building the same source with `CARGO_HOME=/tmp/…`
    produced a different hash; building with the canonical path reproduced `1f30ccf1…` exactly. Fix:
    pin the toolchain (`rust-toolchain.toml`, `1.99.1`) and build in CI with the same `CARGO_HOME` the
    deployment used (`/home/openhands/.cargo`). This is a **known limitation of the reproducibility
    claim**, stated plainly in the README: the sha256 match confirms *source ↔ bytecode* under the
    pinned toolchain and registry path; it is not a claim of byte-reproducibility from an arbitrary
    environment.

**This mission (2026-11-11, branch `fix/website-truth-wallet-policy`, PR #10).** Defects 1–5 above
were found and fixed on this branch. The website was reading live v1 contract state but described it
incorrectly in four places and could construct a transaction the contract would refuse; those are the
core of this change. Console tests went 71 → 77.

## Not fixed / not verified (honest list)

- **A live HERE/Meteor extension approval is not captured** — it needs an interactive browser with the
  extension and a funded account. Status: BLOCKED BY HUMAN ACTION. `docs/JUDGE_DEMO.md` §3 gives the
  exact steps.
- **`npm run test:onchain` cannot run here** — the 17 live adversarial tests need `keys/identities.json`
  and `keys/state.json` (gitignored operator files) and a fresh deploy. The suite exists and fails
  cleanly with an actionable message; it is not part of `npm test`. Status: BLOCKED BY HUMAN ACTION
  (funded operator account).
- **A fresh isolated contract deploy is not possible here** — it needs ~3.5–3.7 NEAR and the testnet
  faucet is rate-limited. Status: BLOCKED BY EXTERNAL SERVICE. The proof rests on the already-deployed
  contract, tied to source by the wasm sha256 (`1f30ccf1…`, rebuilt locally and matched).
- **The v2 contract is not deployed.** The v2 build (multi-operator oracle quorum + resolver dispute
  resolution, generic metric model) is implemented and proven end-to-end in a **local sandbox**
  (`npm run verify:sandbox` = 21/21: buy → operator quorum → dispute → resolver quorum → settle, plus
  refusals) on branch `feat/decentralized-insurance-lifecycle` (PR #9, draft). It is **not** on
  testnet, because deploying it needs the funded operator key this environment does not hold. The
  public console therefore reads the live **v1** contract; its v2 rendering path is present but gated
  (`CONTRACT_V2`), and the v1 path is the one exercised. Status: IMPLEMENTED AND VERIFIED IN SANDBOX,
  NOT DEPLOYED.
- **No professional audit; testnet only.** Not for real funds.
- **Agent rate limits are per-process**, not a global distributed limit.
- **Single attestor** on the deployed v1 contract; disputes are resolved by the owner (centralisation
  point, documented). v2 replaces this with an operator quorum + resolver, but is not deployed.
