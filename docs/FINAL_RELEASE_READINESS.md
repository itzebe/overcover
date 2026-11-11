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
| Product discovery | FIXED AND VERIFIED | `list_products` view; console groups canonical vs demo products. | Live `list_products` returns 22 products (2 canonical: `rain-lagos`, `rain-bergen-dry`; 20 demo-generated). Console renders 2 coverage cards (`tests/console.test.js`; live probe). |
| Premium calculation | FIXED AND VERIFIED | `quote(product_id, payout) = ceil(payout × premium_bp / 10_000)`, computed in the contract. | `quote` read live (`0.0500 NEAR` for 1 NEAR at 500 bp); console re-reads the contract's quote before buying (`tests/console.test.js`). |
| Payout calculation | FIXED AND VERIFIED | Payout is the amount reserved at purchase; `resolve` pays iff `value_tenths ≥ threshold_tenths`. | Policy 3 settled `settled_paid` (1 NEAR paid); policy 4 `settled_no_pay` (0). `verify:proof` asserts both. |
| Policy creation | FIXED AND VERIFIED | `buy_cover` charges the product premium, reserves the payout, returns the policy id. | Policies 1–15 on-chain; agent buys → policies 11, 12; `verify:proof` ties each agent tx to its policy. |
| Policy retrieval | FIXED AND VERIFIED | `get_policy(id)`, `list_policies()`. | Read live; console "Policies written" reads them; `verify:proof` re-reads them. |
| Policy status | FIXED AND VERIFIED | `status` ∈ `active`/`settled_paid`/`settled_no_pay`; `paid_amount`, `settled_at`. | `verify:proof`: settled_paid paid > 0, settled_no_pay paid 0. |
| Insurance terms and conditions | FIXED AND VERIFIED | Product fields (threshold, premium, bounds, lead, capacity) are immutable; console states the parametric limitation on every card. | `e1_threshold_is_owned_by_the_product` (Rust); console asserts the limitation text is shown. |

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
| Failure and rejection handling | FIXED AND VERIFIED | Rejection → "Purchase not completed", nothing charged; no silent success. | `tests/console.test.js` (the fake-success guard). |
| Policy ownership verification | FIXED AND VERIFIED | Policy `buyer` is the signer; read back from the contract. | Policy 15 `buyer = human-demo-…`; policies 11,12 `buyer = oc-agent-…`. |

**Human purchase (end to end).** The `buy_cover` **shape the console builds** is proven on-chain:
tx `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i` → policy 15 (`rain-lagos`, 1 NEAR payout,
0.05 NEAR premium, `active`). That transaction was signed **programmatically** with the page's exact
arguments — it is **not** a recording of a live extension approval. Status of the live-extension
step: **BLOCKED BY HUMAN ACTION**.

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
| Vercel deployment | FIXED AND VERIFIED | Project `overcover`; production alias `overcover.vercel.app`. | `GET /v6/deployments` shows a READY production deployment for `ee1c46d`. |
| Correct deployed commit | FIXED AND VERIFIED | The production deployment's `meta.githubCommitSha` = `ee1c46d92a51`. | The served `index.html` sha256 equals the working-tree file exactly. |
| API availability | NOT APPLICABLE | The console is a static page reading public NEAR RPC; there is no product API. | — |
| Browser functionality | FIXED AND VERIFIED | Page loads and renders live contract state. | `verify:live` (5 widths, 0 console errors); browser probe: 0 console errors. |
| Wallet compatibility | FIXED AND VERIFIED (integration) | HERE + Meteor; honest availability. | `verify:connectivity`; `ui:qa`. Live extension approval BLOCKED BY HUMAN ACTION. |
| Mobile responsiveness | FIXED AND VERIFIED | Reflows to 320 px, no horizontal overflow. | `verify:live` and `ui:qa` at 320–1440 px. |
| Console errors | FIXED AND VERIFIED | Zero across widths. | `verify:live`, `ui:qa`. |
| Production configuration | FIXED AND VERIFIED | `vercel.json`, root-dir output `ui`, no build step; `ui/vendor/*` bundles are tracked. | Deployed HTML hash == local; a clean clone runs with no build step. |

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

1. **`npm run verify:proof` and `npm run verify:agent` crashed on a clean clone.** Both read
   `agent/audit.log.jsonl`, which is gitignored, so the two headline "independent proof" commands —
   the ones a judge runs first — died with `ENOENT` on any fresh checkout. Root cause: evidence for
   the agent's purchases lived only in the operator's local, untracked audit log. Fix: added a
   committed evidence file `proof/agent-purchases.json` (hashes, policy ids, products, amounts) and
   made `verify:proof` **re-derive every claim in it from the chain** — the tx signer must be the
   agent, the call must be `buy_cover` for the stated deposit, and the policy's buyer/product/payout/
   premium must match. Regression: run `npm run verify:proof` on a clean clone (verified in
   `/tmp/clean`).
2. **`verify:proof` used `JSON.parse` for contract views**, rounding u128 money fields above 2^53 and
   making the new payout/premium equality checks fail spuriously (the recurring precision trap). Fix:
   it now uses the shipped `parseBigIntJson`. `verify:proof` went from 11/12 to 12/12.
3. **No idempotency regression test.** Idempotency was implemented and claimed but unproven. Fix:
   added two tests to `tests/agent-api.test.mjs` proving a replayed key returns the original result
   and does not re-execute (audit-log-based), and that distinct keys are fresh evaluations.
4. **`docs/SECURITY.md` under-reported the console test count** (66 vs the actual 71). Fixed.
5. **`SUBMISSION.md` human-path section could be read as a live wallet approval.** Rewrote it to state
   plainly that the on-chain transaction was signed programmatically with the page's exact arguments,
   that a live extension approval is not captured, and how a judge completes it.
6. **CI did not run the independent proof.** Added `verify:proof` and `verify:agent` to
   `.github/workflows/ci.yml`, so the "deployed bytecode == this source" claim is checked on every push.

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
- **No professional audit; testnet only.** Not for real funds.
- **Agent rate limits are per-process**, not a global distributed limit.
- **Single attestor**; disputes are resolved by the owner (centralisation point, documented).
