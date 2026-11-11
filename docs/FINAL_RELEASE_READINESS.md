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
npm run test:agent-eval     # 32 — product-feed schema/premium + agent boundary (offline) + independent-client integration
npm run test:deploy         # 3 — the deploy/upgrade paths refuse a stale (guard-less) wasm
npm run verify:proof        # 12/12 — needs cargo build for the bytecode check
npm run verify:agent        # limits engine vs the live product
npm run verify:upgrade      # 8/8 — the SEC-1 guard on the compiled wasm (real neard node)
npm run verify:upgrade-preservation  # state PRESERVED + the migrated policy still settles (real v1 bytecode)
npm run verify:connectivity # 12/12 — public console needs no local agent
npm run verify:live         # production URL at 5 widths
npm run axe                 # 0 violations, page + dialog
npm run ui:qa               # 7 viewports, real agent round-trip
npm run fixture:capture     # refresh tests/fixtures/contract-snapshot.json from the live contract
```

**End-to-end wallet journey (no broadcast).** `tests/wallet-journey.test.mjs` (run by `test:console`)
executes the **real** inline `<script>` of `ui/index.html` in a `node:vm` with a DOM shim and a mock
wallet, against the frozen snapshot. It is the strongest available proof of the human purchase path
short of a real extension approval: the page builds exactly one `buy_cover`, the deposit equals the
contract's own `quote` (not a client recompute), a valid beneficiary passes through, an invalid one is
refused before signing, the observation date is clamped to the future, and success / no-hash /
contract-failure / wallet-rejection are each classified honestly.

**Funds preflight.** A live agent buy now checks its own balance for the premium **plus a gas buffer**
before it signs (`fundsShortfall` in `agent/limits.mjs`; `tests/agent-funds.test.mjs` drives the real
agent against live RPC with an unfunded account and asserts a `denied` refusal, not a chain error).

**Agent API contract.** `agent/openapi.json` documents the service; `tests/agent-openapi.test.mjs`
fails the build if the spec and the running routes ever disagree.

**Machine-readable catalogue.** `npm run products:feed` regenerates `ui/products.json` from the live
contract (`scripts/products-feed.mjs`); `ui/products.schema.json` is its JSON Schema and
`tests/products-feed.test.mjs` validates the shipped artifact offline. All money fields are exact
decimal yoctoNEAR strings (never floats — a `JSON.parse` rounds values above 2^53). The page links
both files from its verification section, and `tests/console.test.js` asserts the link, the underline
rule (WCAG 1.4.1) and the shipped artifacts.

---

## 1. Product

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Core insurance functionality | FIXED AND VERIFIED | `contract/src/lib.rs`: products, policies, pool, reservations, signed oracle, bonded disputes, deterministic settlement. | 62 Rust unit tests pass; 66-attack reference model `66 defended, 0 exploitable`; the live demo ran the full cycle (18 txs, `demo-log.json`). |
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
| Idempotency | FIXED AND VERIFIED | Same `Idempotency-Key` returns the original result; the buy is not re-executed, **including when two identical-key requests arrive concurrently**. | `tests/agent-api.test.mjs`: a replayed key appends no second audit entry; the concurrent test proves exactly one execution. |
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
| API authentication | FIXED AND VERIFIED | The service binds loopback by default; binding a non-loopback host **requires** `OVERCOVER_AGENT_TOKEN` and refuses to start without it; a configured token is enforced on every route (constant-time). | `tests/agent-api.test.mjs`: no token → 401, wrong token → 401, correct token → 200. `tests/agent-openapi.test.mjs` checks the spec declares `bearerAuth` and the 401. |
| Rate limits | PARTIALLY WORKING | Cooldown + rolling budgets are per-process, not a distributed limit; the agent serializes concurrent buys so limits cannot be bypassed by overlap. | Documented in `agent/README.md` "What is *not* claimed"; `tests/agent-limits.test.mjs` serializer + race tests. |
| Denial-of-service exposure | FIXED AND VERIFIED | Body cap with a drain (the socket is not destroyed, so the client still gets a 413). | `tests/agent-api.test.mjs` oversized-body test. |
| Error handling | FIXED AND VERIFIED | Contract refusals carry a human-readable `panic_utf8` reason; the agent surfaces it. | Rust tests; adversarial tests assert the expected reason; `failureMessage`. |
| Logging and audit integrity | FIXED AND VERIFIED | Audit log holds no key material; a write failure is surfaced on stderr, never silently dropped. | `agent.mjs` `appendAudit`; `tests/agent-api.test.mjs`. |

## 5. Production

| Requirement | Status | What exists | How tested / evidence |
| --- | --- | --- | --- |
| Vercel deployment | FIXED AND VERIFIED | Project `overcover`; production alias `overcover.vercel.app`. | `GET /v6/deployments?…&target=production` shows a READY production deployment. |
| Correct deployed commit | FIXED AND VERIFIED | The production deployment's `meta.githubCommitSha` matches `main` (`cadcb0a`, PR #20, at the time of writing). | `GET /v6/deployments`; the served `index.html` sha256 equals the working-tree file. |
| API availability | NOT APPLICABLE | The console is a static page reading public NEAR RPC; there is no product API. | — |
| Browser functionality | FIXED AND VERIFIED | Page loads and renders live contract state. | `verify:live` (5 widths, 0 console errors); browser probe: 0 console errors. |
| Wallet compatibility | FIXED AND VERIFIED (integration) | HERE + Meteor; honest availability. | `verify:connectivity`; `ui:qa`. Live extension approval BLOCKED BY HUMAN ACTION. |
| Mobile responsiveness | FIXED AND VERIFIED | Reflows to 320 px, no horizontal overflow. | `verify:live` and `ui:qa` at 320–1440 px. |
| Console errors | FIXED AND VERIFIED | Zero across widths. | `verify:live`, `ui:qa`. |
| Production configuration | FIXED AND VERIFIED | `vercel.json`, root-dir output `ui`, no build step; `ui/vendor/*` bundles are tracked. | Deployed HTML hash == local; a clean clone runs with no build step. |

**Contract version.** The deployed contract is **v1** (`contract.attestor-overcover.testnet`, code hash
`36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R`, wasm sha256 `1f30ccf1…`, 344857 bytes). The console
reads v1 and renders v1 semantics; it is also compatible with the **v2/v3** contract via a version
gate (`CONTRACT_V2`, keyed on `list_metrics` + `config.resolver_quorum`). The repository source is now
**contract v3** (`contract/VERSION` = 3), which the state-preserving `migrate` upgrades v1 to in place.
**v3 is implemented and proven in a local sandbox and against the exact live v1 bytecode but not
deployed to the live address** (see the honest list below).

What v3 adds over the deployed v1 (all in `contract/src/lib.rs`):
- a **domain-separated, length-prefixed observation message** (`overcover:v3:observation|…`, binds the
  contract id, expiry and an evidence reference) so a signature cannot be replayed as a different
  reading, for a different contract, or after expiry;
- a **multi-operator oracle quorum** with per-operator keys and monotonic nonces;
- a **per-policy challenge window** and a **per-dispute frozen resolver threshold**, so an owner can
  never shorten a challenge or move the decision bar mid-flight;
- **owner-excluded resolvers** (the owner may not be a resolver nor vote on a dispute);
- a **capped reading validity** (≤ 7 days) and an evidence-size cap.

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

**Follow-on mission (2026-11-11, branch `feat/protocol-upgrade-judge-investor-agent`).** Product
upgrade for judge, investor and agent readiness:

13. **No machine-readable catalogue for agents.** Nothing let software discover the cover without
    scraping the page. Fix: `scripts/products-feed.mjs` derives `ui/products.json` **only** from live
    contract state (`get_pool`, `list_products`), classifies each product as a real offering or a
    demo fixture, emits the exact `buy_cover` call shape, and writes money as exact yoctoNEAR
    **strings**. `ui/products.schema.json` (draft 2020-12) describes it. Regression:
    `tests/products-feed.test.mjs` (10 tests) validates the shipped artifact offline. The page and
    `ui/llms.txt` now link the feed.
14. **u128 money fields were emitted as JS numbers and rounded.** `reserved: 0` and large payouts
    exceeded 2^53 when serialised as numbers, silently corrupting the feed. Fix: every money field is
    a forced decimal string; the feed generator and the live chain read use `parseBigIntJson`. This is
    the same precision trap recorded for the proof scripts — now closed in the feed too.
15. **A link inside a sentence was colour-only.** Adding the feed link exposed an axe
    `link-in-text-block` violation (WCAG 1.4.1) — serious — at all seven widths, page and dialog. Fix:
    `.proof .val a { text-decoration: underline }`. `npm run axe` returned to 0 violations.
    Regression: `tests/console.test.js` asserts the underline rule, the feed link, and that the
    shipped artifacts exist and validate.
16. **Agent readiness was undocumented.** Fix: `docs/AGENT_INTEGRATION.md` documents the feed, the
    spending-policy engine, the HTTP API and the SDK, accurate to the code. `tests/agent-eval.test.mjs`
    (12 tests) proves the boundary cases and re-reads the live product. CI now runs `test:agent-eval`.

Console tests went 77 → 78.

## Defects fixed in this mission (2026-11-11, v2 integration + SEC-1 closure)

21. **SEC-1 (CRITICAL) — the deployed v1 `migrate()` could be called by anyone.** Root cause: v1
    declares `#[init(ignore_state)]`, which runs *before* any state is read, so it cannot consult the
    stored owner; any account could call `migrate(new_owner, …)`, overwrite owner + attestor, then
    forge an observation and drain the pool. Fix: v2 restricts `migrate` to a **self-call**
    (`predecessor == current_account_id`) and refuses any other caller. Evidence: the deployed module
    is byte-identical to the v1 source (sha256 `1f30ccf1…`, rebuilt from `18ec7f08`), so the live
    contract *is* the vulnerable build; `npm run verify:migration` proves the vulnerable shape of
    v1's `migrate()` and the guard in v2's; `contract/src/tests.rs` adds 4 behavioural regressions
    (`sec1_*`: third party refused, state untouched, repeated refused, self-call allowed). Status:
    **FIXED IN SOURCE, NOT YET DEPLOYED** — the fix ships with the v2 deploy (needs the funded
    operator key).
22. **The v2 branch and `main` had diverged into an unresolvable conflict.** Root cause: the branch
    was authored before PRs #11–#15 landed on `main`; a naive merge against the *stale remote branch
    ref* silently dropped the SEC-1 guard. Fix: merged the **PR head** (`0176877a`, the only ref with
    the guard), re-resolved the six conflicts, and pushed the merge back to the PR branch. Evidence:
    `contract/src/lib.rs` now carries the guard; CI green on `9c4182d5`; PR #9 `MERGEABLE`.
23. **The v2 console broke every human-purchase regression test.** Root cause: the v2 page sets
    `data-contract` on `document.documentElement`, which the test DOM shim did not provide, so the
    whole read failed and the catalogue never rendered. Fix: the shim gains `documentElement`.
    Regression: `npm run test:console` restored to **90/90**.
24. **Documentation referenced modules the v2 branch removed/renamed** (`driver/oracle.js`,
    `research/model/mutual.mjs`) and carried stale counts (21 Rust tests, 31 attacks, 87 console).
    Fix: updated `README.md`, `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md`, `docs/SECURITY.md`,
    `docs/SECURITY_PRE_AUDIT.md`, `SUBMISSION.md`, `AGENTS.md` to the shipped modules and the real
    counts (contract 40, model 60, console 90, agent 51, agent-eval 32, sim 61).


## Defects fixed in this mission (2026-11-11, branch `mission/complete-before-acceptance`)

17. **The agent's live buy path never checked the balance before signing.** Root cause: `agent.buy`
    evaluated the spending policy and then built and sent the transaction unconditionally; an
    unfunded account would spend a nonce on a transaction the network rejects for insufficient
    balance. Fix: a pure `fundsShortfall(balance, premium, buffer)` in `agent/limits.mjs` and a
    preflight in `agent.mjs` that refuses (403 `denied`, audited) when the balance cannot cover the
    premium **plus a 0.05 NEAR gas buffer**. Regression: `tests/agent-limits.test.mjs` (4 pure cases)
    and `tests/agent-funds.test.mjs` (the real agent against live RPC with an unfunded account → a
    `denied` refusal, never a chain error; no funds move).
18. **The human purchase path had no end-to-end test.** Root cause: page logic was only unit-tested in
    pieces. Fix: `tests/wallet-journey.test.mjs` runs the shipped inline script in a `vm` with a DOM
    shim and a mock wallet against a frozen contract snapshot (`tests/fixtures/contract-snapshot.json`,
    captured by `scripts/capture-fixture.mjs`), proving the whole journey's shapes and honest states.
19. **The agent's HTTP API was undocumented as a contract.** Fix: `agent/openapi.json` (OpenAPI 3.1)
    plus `tests/agent-openapi.test.mjs`, which fails if the spec and the running routes disagree.
20. **The agent integration was only asserted, not demonstrated for an outside consumer.** Fix:
    `tests/agent-integration.test.mjs` drives a client that knows only the published catalogue, the
    published schema and the documented API through discover → quote → decide → buy (dry run) →
    over-limit refusal → allow-list refusal → replay → malformed → kill switch.

Console tests went 78 → 87; agent tests 36 → 45; agent-eval 22 → 32.


## Defects fixed in this mission (2026-11-11, branch `fix/agent-concurrency-limits`, PR #14)

21. **CRITICAL — the deployed contract's `migrate()` is unauthenticated (pre-audit SEC-1).** `migrate`
    is `#[init(ignore_state)]`, which runs before state is read, so it could not check the stored
    owner: **any** account could call it and overwrite all state (become owner, install its own
    attestor, forge an observation, drain the pool). Reproduced on a local `neard` sandbox against
    the exact deployed bytecode (`attacker became owner via migrate()`); fixed in the v2 source with
    `ensure!(predecessor == current_account_id)` and verified by the attack being refused
    (`cargo test` → 36 passed; sandbox → SAFE). The fix is on PR #9's branch because it belongs with
    the contract. **The live v1 contract remains vulnerable until redeployed** (blocked on the
    operator key). Full detail: `docs/SECURITY_PRE_AUDIT.md`.
22. **HIGH — agent idempotency was not safe under concurrency (SEC-2).** The buy route checked the
    key, awaited the buy, then stored the result; two identical-key requests arriving together both
    executed. Fixed by reserving the key (a promise) before the first `await`. Regression:
    `tests/agent-api.test.mjs` "concurrent buys … execute exactly once" (fails on the old code).
23. **HIGH — agent spending limits could be bypassed by overlapping buys (SEC-3).** The limits read
    `history`, decide, then record; two overlapping buys with different keys both passed the same
    check. Fixed with a `createSerializer()` that runs buys one at a time. Regressions:
    `tests/agent-limits.test.mjs` (serializer order + the race it closes).
24. **MEDIUM — the agent service had no authentication (SEC-4).** An exposed service could be spent
    by any caller. Fixed: a non-loopback bind now requires `OVERCOVER_AGENT_TOKEN` and refuses to
    start without it; the token is enforced on every route. Regressions: `tests/agent-api.test.mjs`
    (401/401/200) and `tests/agent-openapi.test.mjs` (spec documents `bearerAuth` + 401).

Agent tests 49 → 51; the OpenAPI spec test 4 → 5. Full pre-audit: **`docs/SECURITY_PRE_AUDIT.md`**.

## Defects fixed in this mission (2026-11-11, v2 testnet deploy — `fix/v2-deploy-tooling`)

25. **CRITICAL — a stale `overcover.wasm` would deploy the SEC-1 vulnerability.** Root cause: the
    `contract/target/.../overcover.wasm` committed to the working tree (built before the SEC-1 fix)
    carries the v2 exports but **no** migrate guard. `npm run deploy` would have deployed it and left
    the takeover open, while every test still passed (the tests exercise the source, not the artifact).
    Found by running the new `proof/upgrade-guard.mjs` against the prebuilt artifact: a third-party
    `migrate()` was *accepted* (owner became the attacker). Fix: both `driver/deploy.js` and the new
    `driver/upgrade.js` now refuse to run unless the wasm contains the guard string
    (`migrate may only be called by the contract account itself`), before any destructive step.
    Regressions: `tests/upgrade-guard-refusal.test.mjs` (3) + `proof/upgrade-guard.mjs` (8/8).
26. **The deploy runbook described an in-place upgrade that had no implementation.** Root cause:
    `driver/deploy.js` only does the destructive delete-and-recreate path; the runbook's "in-place
    upgrade note" was prose with no script, so the only shipped path wiped the pool and policies.
    Fix: `driver/upgrade.js` (DeployContract + self-call `migrate` + reconfigure) with a `--plan`
    mode that prints the exact operations and costs and sends nothing, plus shared `configureContract`
    extracted from `deploy.js`. Proven on the compiled wasm by `proof/upgrade-guard.mjs`.
27. **The SEC-1 guard was proven in Rust unit tests but never on the compiled wasm.** Root cause: the
    sandbox lifecycle exercised the happy path and the paused-refusal, not the migrate guard. Fix:
    `proof/upgrade-guard.mjs` (8/8) runs the built wasm on a real `neard` node and asserts the
    third-party refusal, the unchanged state, the repeated refusal and the fail-closed self-call. Added
    to CI (`npm run verify:upgrade`, `REQUIRE_SANDBOX=1`).
28. **CRITICAL — the documented in-place upgrade DESTROYED the live state.** Root cause: v2's
    `migrate` was `#[init(ignore_state)]` and called `Self::new_state(...)`, which rebuilt empty state
    — `capital`, `reserved` and `next_policy_id` were zeroed, and the v1 `Product`/`Policy`/
    `Observation` Borsh layouts no longer matched v2, so the collection entries became undecodable
    (`WasmTrap(Unreachable)` on the first read). The runbook claimed the upgrade "keeps the pool
    capital and the policies"; it did not. Reproduced against the **exact live v1 bytecode**
    (`1f30ccf1…`) on a real `neard` sandbox: capital 5.03→0, reserved 0.3→0, policies 1→0. Fix:
    `migrate` now reads the raw v1 blob and re-encodes it in the v2 shape via `import_legacy`
    (raw `insert_raw`/`remove_raw`, because `LookupMap::insert` decodes the value it evicts as the
    *new* type and would trap on v1 bytes). Pool accounting, `next_policy_id`, owner/config, products,
    policies, providers and observations all survive; legacy records take `metric_id=""` /
    `direction="Above"` and observations are re-keyed `city|date` → `metric|city|date`. A non-v1 state
    fails closed with a readable reason. Regressions: `proof/upgrade-state-preservation.mjs`
    (state preserved **and** the migrated policy still settles) + Rust
    `tests::migrate_preserves_legacy_state`. Files: `contract/src/lib.rs`, `contract/src/tests.rs`.

## Defects fixed in this mission (2026-11-11, v3 — decentralise the trust boundary)

29. **CRITICAL — the off-chain observation message omitted the `city` field, so no operator reading
    could ever verify on-chain.** The v3 contract signs
    `overcover:v3:observation|<contract_id>|<operator>|<metric>|<city>|<date>|<value>|<reported_at>|<expiry>|<nonce>|<u32be len><evidence>`,
    but both off-chain builders — `driver/attestor.js` `readingMessageV3` and the reference model
    `sim/engine.mjs` `readingMessage` — left `city` out of the head. Every `submit_reading` therefore
    failed with `invalid operator signature`. Root cause: the field list was transcribed by hand and
    `city` was dropped; the reference model could not catch it because it signed **and verified with
    its own copy** of the message, so its tests stayed green. Found by driving the compiled wasm on a
    real `neard` node (`npm run verify:sandbox`), which surfaced the signature failure the unit tests
    could not. Fix: both builders now emit the contract's exact byte layout. Regressions: two
    byte-exact layout pins, one per end — `tests/v3-message.test.mjs` (JS driver **and** sim builder vs
    a frozen hex literal, plus a "every signed field changes the bytes" guard and an evidence-length
    ambiguity guard) and `contract/src/tests.rs::reading_message_matches_the_pinned_v3_layout` (the
    Rust contract vs the same hex). Both were verified to fail on the pre-fix code and pass after.
    Files: `driver/attestor.js`, `sim/engine.mjs`, `driver/actions.js`, `driver/operator.js`,
    `driver/adapters.js`, `tests/sandbox-lifecycle.mjs`, `tests/v3-message.test.mjs`,
    `contract/src/tests.rs`, `package.json` (`test:sim` now runs the new test).
30. **The state-preservation proof did not know about the new `Policy.challenge_window_sec` field.**
    `proof/upgrade-state-preservation.mjs` compared the migrated policy against the legacy one and
    flagged the *intended* new field as a difference, reporting "state NOT preserved". Root cause: the
    proof's `stripV2` only knew the v2 fields. Fix: `stripNew` now also ignores `challenge_window_sec`
    and asserts it takes the contract-wide value that was live at migration time. `npm run
    verify:upgrade-preservation` returns **state PRESERVED, migrated policy settled** again.
31. **Docs carried the previous generation's counts and version.** `README.md`, `SUBMISSION.md`,
    `docs/VERIFICATION.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/SECURITY_PRE_AUDIT.md`
    and `AGENTS.md` still said "60 attacks / 41 Rust / 21 Rust / 31 attacks" and described the source
    as v2. Corrected to the measured values (model 66, contract 62) and `contract/VERSION` = 3.

## Blockchain evidence (real testnet)

**Isolated v2 deployment — `npm run verify:testnet-deploy` (9/9), 2026-11-11.** A throwaway
faucet-funded identity graph deployed the compiled v2 wasm to real NEAR testnet and exercised it:

- Contract: `contract.ovc-v2-deploy-mwccnjmr.testnet` (isolated; the shared live contract is
  untouched — see below).
- Deployed module sha256 `78ddebb145f88c963ad1c33e22f5a798b0e1777454d9e6edee1cad53532f6471`
  (462,785 bytes) — independently re-read from the chain and byte-identical to the local build.
  `code_hash` `98pC7CzB4tjtNjBpcQNbQRF1PY6q7q1zpxS7LQ5GTND6`.
  (This deployment predates the state-preserving `migrate` fix — item 28 — so the *current* v2 source
  builds to sha256 `eb2070d73aebcc53…` / 482,034 bytes. `npm run verify:testnet-deploy` performs a
  fresh isolated deployment with whatever the local build is.)
- A real `buy_cover` created policy 1: tx
  `682okkqHhQ6XieGa5MHrAwcRyxhUXn9EsLXRKq8rDHsb` (signer `buyer.ovc-v2-deploy-mwccnjmr.testnet`,
  `SuccessValue`), policy `{"id":1,"buyer":"buyer.ovc-v2-deploy-mwccnjmr.testnet","product_id":"heat-lagos","payout":"300000000000000000000000","premium":"15000000000000000000000","status":"active"}`
  read back over raw RPC.
- SEC-1 on the live chain: a third-party `migrate()` from `attacker.…` panicked with
  `migrate may only be called by the contract account itself`; the owner was unchanged afterwards.
- Configured state read back: 3 operators (quorum 2), 3 resolvers, 1 metric product.
- Evidence file: `proof/testnet-v2-deploy.json`.

**The shared live contract is unchanged by this mission.** `contract.attestor-overcover.testnet`
still serves v1: `code_hash` `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R`, module sha256
`1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e`. Closing SEC-1 there needs the
operator key (see below).

**Live-contract evidence (unchanged, re-verified).** `npm run verify:proof` → 12/12: the deployed v1
module is byte-identical to the v1 source (`18ec7f08`); the pool is solvent (capital 14.05 / reserved
10.50 NEAR) and reconciles; all 18 `demo-log.json` transactions resolve on-chain; the two autonomous
agent purchases are real `buy_cover` calls each tied to its policy; the settled policies paid as
shown. `npm run verify:agent` confirms the spend engine against the live product definition.

## Not fixed / not verified (honest list)

- **A live HERE/Meteor extension approval is not captured** — it needs an interactive browser with the
  extension and a funded account. Status: BLOCKED BY HUMAN ACTION. `docs/JUDGE_DEMO.md` §3 gives the
  exact steps.
- **`npm run test:onchain` cannot run here** — the 17 live adversarial tests need `keys/identities.json`
  and `keys/state.json` (gitignored operator files) and a fresh deploy. The suite exists and fails
  cleanly with an actionable message; it is not part of `npm test`. Status: BLOCKED BY HUMAN ACTION
  (funded operator account).
- **A fresh isolated contract deploy is not possible here** — it needs ~3.5–3.7 NEAR and the testnet
  faucet was rate-limited in the earlier environment. The proof rests on the already-deployed
  contract, tied to source by the wasm sha256 (`1f30ccf1…`, rebuilt locally and matched). In a
  container where the faucet is available, `proof/testnet-v2-deploy.mjs` performs a real, isolated v2
  deployment (see §"Blockchain evidence").
- **The v3 contract (with the SEC-1 fix) is merged but not deployed to the live address.** The v3 build
  (domain-separated length-prefixed observation message, multi-operator oracle quorum, per-policy
  challenge window, frozen per-dispute resolver threshold, owner-excluded resolvers, generic metric
  model, hardened `migrate`) is implemented and proven end-to-end in a **local sandbox**
  (`npm run verify:sandbox` = 21/21), and the in-place `migrate` is proven **state-preserving** against
  the exact live v1 bytecode (`npm run verify:upgrade-preservation`). It is **not** on the live address
  `contract.attestor-overcover.testnet`, because closing SEC-1 there needs the contract's full-access
  key, which this environment does not hold. The public console therefore reads the live **v1**
  contract; its v2 rendering path is present but gated (`CONTRACT_V2`). The **SEC-1 vulnerability
  remains live** until the operator runs `node driver/upgrade.js` (non-destructive, ~4.63 NEAR
  refundable stake). Status: IMPLEMENTED, VERIFIED IN SANDBOX AND ON AN ISOLATED TESTNET
  DEPLOY, MIGRATION PROVEN STATE-PRESERVING, MERGED — the single remaining BLOCKED BY HUMAN ACTION item.
- **No professional audit; testnet only.** Not for real funds. An internal pre-audit
  (`docs/SECURITY_PRE_AUDIT.md`) found and fixed a critical contract issue and two agent races; it is
  not a substitute for a third-party audit.
- **Wallet-stack dependency advisories remain (pre-audit SEC-5).** `npm audit --omit=dev` reports
  9 high / 2 moderate / 13 low, all transitive through the wallet libraries (`@here-wallet/core`,
  `@meteorwallet/sdk`, `bs58`/`base-x`, `nanoid`, `query-string`). The fixes need a breaking wallet
  downgrade; no exploit path was found in the shipped static page, so they are accepted and tracked.
- **Agent rate limits and idempotency are per-process**, not a global distributed limit. Buys are
  serialized within one process, so a single service instance cannot be raced; a multi-instance
  deployment must centralise spend state.
- **Single attestor** on the deployed v1 contract; disputes are resolved by the owner (centralisation
  point, documented). v2 replaces this with an operator quorum + resolver, but is not deployed.
