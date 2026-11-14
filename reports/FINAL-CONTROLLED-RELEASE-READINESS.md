# Final controlled release readiness — owner-led human testing

**Mission:** bring Overcover to controlled **testnet** production readiness for owner-led human
testing. **Date:** 2026-11-14. **Branch:** `feat/owner-authority-reconciliation-testnet`
(commit `e5db12a`, plus this session's commits). **Production:** https://overcover.vercel.app/.
**Network:** NEAR testnet only. No mainnet transaction, no paid service, no new deployment was made.

## Verdict

> **CONDITIONAL GO for owner-led human testing on the live v3 contract
> `contract.ovc-v3-ctl-2f6c4c.testnet` (the console default) — the human acceptance test can be run
> now.** A normal purchase and its accounting do not depend on the missing SEC-7/SEC-9 fixes, which
> affect only terminal capital release.
>
> **NO-GO for declaring the *hardened* implementation deployed.** The live v3 account still runs the
> pre-fix module (no SEC-7/SEC-9); the code-only redeploy and the legacy v1 containment are **blocked
> at a signing-authority boundary** that this environment does not hold. Those two are exact owner
> actions below, not agent-completable work.
>
> No unresolved **critical** blocker remains. The two blockers are (a) an owner-held NEAR signing key
> and (b) a human pressing Approve in a wallet extension. Neither is a code defect.

## Contract identities and deployed hashes (independently read this session)

Read over public RPC (`https://test.rpc.fastnear.com`, `view_code`), sha256 computed from the returned
`code_base64` bytes — not from any documentation.

| Deployment | Account | code_hash (RPC) | wasm sha256 | bytes | Hardened artifact? |
| --- | --- | --- | --- | --- | --- |
| **Production v3 (console default)** | `contract.ovc-v3-ctl-2f6c4c.testnet` | `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL` | `a97034e6…` | 500023 | **No** — lacks SEC-7/SEC-9 |
| Hardened reference (verified) | `contract.ovc-v3-ctl-mwgci3u8.testnet` | `9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C` | `811e0427…` | 500342 | **Yes** (== target) |
| Legacy v1 (readable, not a purchase destination) | `contract.attestor-overcover.testnet` | `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` | `1f30ccf1…` | 344857 | No — lacks SEC-1 |

The target artifact is **sha256 `811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f`**,
500,342 bytes; it is present in the tree at
`contract/target/wasm32-unknown-unknown/release/overcover.wasm` and its hash matches exactly.

Guard-string presence (searched the deployed bytes for each SEC marker):

| Guard | Production v3 | Hardened | Legacy v1 |
| --- | --- | --- | --- |
| SEC-1 `migrate()` self-call guard | YES | YES | **no** |
| SEC-6 terminal no-pay release | YES | YES | YES |
| SEC-7 never-reported release | **no** | YES | no |
| SEC-9 bounded observation lead | **no** | YES | no |
| INVARIANT reserved ≤ capital | YES | YES | YES |

This is the console's own "SOURCE AHEAD OF DEPLOYMENT" state, re-confirmed from the deployed bytes.

## What was executed this session (evidence, not audit prose)

### Test suite (run locally on this exact tree)

| Suite | Result |
| --- | --- |
| `test:model` (adversarial reference model) | **74/74 defended, 0 exploitable** |
| `test:sim` (full-lifecycle simulation) | **79/79 pass** |
| `test:console` (page regressions + live RPC read) | **132/132 pass** |
| `test:agent` (limits, API, u128 precision) | **54/54 pass** |
| `test:agent-eval` (feed schema + agent boundary) | **33/33 pass** |
| `test:factory` (discovery agent) | **11/11 pass** |
| `test:deploy` (fail-closed on stale wasm) | **21/21 pass** |
| `poc:outlayer:test` | **34/34 pass** |

### Verification scripts (run locally, keyless, against real RPC / a real browser)

| Command | Result |
| --- | --- |
| `verify:proof` | **13/13** — 18/18 demo txs resolve, agent purchases real, pool solvent, `reserved ≤ capital` |
| `verify:connectivity` | **13/13** — real Chromium; no private key shipped; only `buy_cover` is signable; hardened allowlist enforced |
| `verify:factory` | **22/22** (sandbox) — permissionless product creation + owner path |
| `verify:upgrade` | **8/8** — third-party `migrate()` fails closed on the compiled wasm |
| `verify:upgrade-preservation` | **PRESERVED** — in-place upgrade keeps capital, reserved, products, policies |
| `verify:sec1-takeover` | **17/17** (sandbox) — v1 takeover reproduced; v2 guard refuses |
| `verify:migration` | **6/6** |
| `verify:release-ops` | **4 ok / 5 blocked / 0 inconsistent** (blocked = missing owner key, by design) |
| `verify:controlled-v3:evidence` | 4 live testnet contracts re-derived from chain |
| `verify:preservation` (new) | **PRESERVATION PASS** — see below |
| `axe` | **0 violations** at 320/360/390/768/1024/1280/1440 px (page + wallet dialog) |
| `ui:qa` | **PASS** — 7 viewports, agent round-trip dry run |

### Independent lifecycle evidence (chain, not mocks)

- The controlled-v3 deploy proof (`proof/controlled-v3-deploy.json`) records **26 transactions**
  (account creation ×14, deploy, `new`, quorum/window setters, deposit, challenge, resolver vote,
  resolve, factory proposal, product activation). Each was **independently re-fetched from RPC this
  session: 26/26 SUCCESS, 0 failures**.
- The hardened v3 contract `contract.ovc-v3-ctl-mwgci3u8.testnet` was re-read live: 5 operators,
  5 resolvers, 2 policies, 1 observation, `check_invariant` true, `reconcile` true, `solvent` true,
  `reserved (100000000000000000000000) ≤ capital (1420000000000000000000000)`.
- Production v3 `contract.ovc-v3-ctl-2f6c4c.testnet`: 3 policies, 5 operators, 5 resolvers, solvent,
  invariant holds.

### State-preservation verifier (new — closes a verification gap)

A code-only `DeployContract` replaces an account's code and leaves its state untouched. To make that
checkable rather than asserted, this session added **`scripts/verify-preservation.mjs`**
(`npm run verify:preservation` / `:snapshot`). It reads every state view (`get_config`, `get_pool`,
operators, resolvers, metrics, products, every policy, `active_operator_count`, `check_invariant`,
`reconcile`) plus the module code hash, stores a baseline in `proof/preservation-snapshot.json`, and
after the owner action re-reads and diffs it. Only the code hash may change; for the legacy account,
`paused` may flip false→true. Everything else must be byte-identical. It also re-asserts the
`reserved ≤ capital` invariant and exits non-zero on any drift.

Run today (no change yet): **PRESERVATION PASS** for both accounts. The owner runs it again
immediately after the redeploy with `--expect-sha256 811e0427…` to prove the upgrade preserved state.

### Agent boundary (adversarial, live service)

The agent service was started live (loopback, bearer token, dry-run) and attacked over HTTP:

- health without a token → **401**; wrong token → **401**; correct token → **200**;
- a purchase above the policy ceiling → **403 `denied`** with reasons;
- a malicious product id (`../../etc/passwd`) → **403 `denied`** (`no such product`);
- the audit log contained only `denied` / `dry_run` entries — **0 sign/broadcast entries**, i.e. denied
  transactions never reached the signing or broadcasting stage;
- a repeated idempotency key returned `idempotentReplay: true` with no second execution.

## Defects found and fixed this session

1. **CI secret-scan would have failed the push (fixed).** `reports/OWNER-AUTHORITY-RECONCILIATION-AND-TESTNET-COMPLETION.md`
   contained full NEAR **public** keys as `ed25519:<44 chars>`. These are **public** (secret keys are 88
   chars; each string equals the account's on-chain `view_access_key_list` entry — verified), so no
   secret was ever exposed. But the CI guard `git grep -nIE 'ed25519:[0-9A-Za-z]{40,}'` matches them and
   would have failed the `verify` job. The keys were **truncated to `ed25519:XXXXXXXX…`** (still unique,
   still re-derivable on-chain) so the guard passes without weakening it. Verified: the exact CI scan
   now reports "no private key committed".

No other defect was found. The production console, its disclosures, and the release register were
re-checked and are accurate.

## AI / search discoverability (verified over HTTP against production)

| Endpoint | HTTP | Byte-identical to repo `ui/` |
| --- | --- | --- |
| `/robots.txt` | 200 | yes (allow-list for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot, Googlebot, Bingbot, Google-Extended, Applebot-Extended; `Sitemap:` line) |
| `/sitemap.xml` | 200 | yes |
| `/llms.txt` | 200 | yes |
| `/llms-full.txt` | 200 | yes |
| `/products.json` | 200 | yes |
| `/products.schema.json` | 200 | yes |

- `index.html` served by production is **byte-identical** to the repo's `ui/index.html`.
- The served HTML carries valid JSON-LD (`@graph`: Organization, WebSite, SoftwareApplication, WebPage,
  FAQPage), a canonical link, `description`, and Open Graph metadata — **no** `aggregateRating`,
  `review`, or fabricated adoption figures. The only `Offer` is `price "0"` ("free on testnet"), which
  is accurate.
- Limitation (unchanged): crawler **access** is verified; actual **indexing** cannot be verified here
  because there is no Search Console / Webmaster Tools access. No indexing is claimed.

## Security posture

- **Dependency audit:** `npm audit` → **19 low, 0 moderate, 0 high, 0 critical** (16 low in the
  production graph). All are the same transitive advisory family rooted in `elliptic`
  (`@near-js/crypto` → `secp256k1`/`elliptic`, `crypto-browserify`), pulled by `near-api-js` and the
  wallet-selector packages. The advisory concerns the ECDSA `secp256k1` path, which the browser console
  does not use (NEAR keys here are `ed25519`). No non-breaking fix exists; `npm audit fix --force`
  would introduce breaking major bumps and was **not** applied. Assessed: accepted residual, low.
- **Secret scan:** no key material tracked; no `ed25519:<secret>` or `PRIVATE KEY` in tracked files
  (the CI scan, reproduced locally, passes).
- **Production HTTP headers (live):** `content-security-policy` (no `unsafe-eval`; `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`), `strict-transport-security`,
  `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy`, `permissions-policy`.
- The console holds no key, signs exactly one `buy_cover`, refuses to sign unless the read contract is
  a verified hardened module, and renders a failed read as stale/"no data" (never as live).

## Owner actions (the exact boundary — do these with your own key; never paste a key into chat)

The environment holds **no** NEAR signing key for either live account (`OVC_V3_SECRET_KEY` unset,
`keys/` absent, no `ed25519:` secret in any file). It cannot sign for either contract and must not
impersonate the owner.

### A. Redeploy the hardened v3 module (code-only, state-preserving, reversible)

```bash
node driver/redeploy-v3.mjs --plan          # prints the operation; sends nothing (run first)
npm run verify:preservation:snapshot        # re-record the baseline just before the change
OVC_V3_SECRET_KEY=<full-access key of contract.ovc-v3-ctl-2f6c4c.testnet> \
  node driver/redeploy-v3.mjs               # a single DeployContract — no new(), no migrate()
npm run verify:preservation -- --expect-sha256 811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f
```

Expected: `get_code` reports code_hash `9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C`, sha256
`811e0427…`; `verify:preservation` prints **PRESERVATION PASS** (owner, products, all 3 policies,
pool accounting, invariant unchanged). Rollback = redeploy the previous module `a97034e6…` (also
code-only). The console already trusts both hashes, so buying is not interrupted.

### B. Contain legacy v1 (smallest safe action — one call)

```bash
near call contract.attestor-overcover.testnet set_paused '{"paused": true}' \
  --accountId owner.attestor-overcover.testnet
```

Expected: `get_pool().paused == true`; capital, reserved and all 15 policies unchanged (the console
reads this and refuses purchases). This is **containment**, not a repair: a determined attacker can
still call the unguarded `migrate()` until the module is replaced. Do not delete policies or drain
capital.

### C. Human wallet purchase on the live v3 contract — the outstanding acceptance test

Follow `docs/HUMAN_ACCEPTANCE_TEST.md` exactly (≈3 minutes). Open https://overcover.vercel.app/,
connect a funded **testnet** wallet (HERE or Meteor), buy `heat-lagos` at 0.1 NEAR (premium 0.005
NEAR), approve the single `buy_cover`, and verify the policy and reserved capital on-chain with the
commands in §4 of that document. **This is the one activity that cannot be produced by an agent** — a
real extension approval needs a human.

## Human acceptance procedure (summary)

Full procedure: `docs/HUMAN_ACCEPTANCE_TEST.md`.

1. **Wallet/network:** funded NEAR **testnet** account + browser extension (HERE or Meteor) set to
   testnet. No key or seed phrase is entered anywhere.
2. **Entry point:** https://overcover.vercel.app/ (default contract
   `contract.ovc-v3-ctl-2f6c4c.testnet`).
3. **Test product / conditions:** `heat-lagos`, payout 0.1 NEAR, premium 0.005 NEAR (5 % `premium_bp`).
4. **Expected transitions:** one extension approval → "Transaction confirmed" with a real hash → a new
   `active` policy row for your account; `get_pool().reserved` rises by 0.1 NEAR; `solvent` stays true.
5. **Independent verification:** the four read-only `curl` checks in the doc (tx Final+success;
   `list_policies` shows your buyer; `get_pool` reserved up, solvent true).
6. **Observation/quorum/dispute/settlement:** exercised end-to-end by the sandbox suites
   (`verify:sandbox`, `verify:factory`) and the 26-txn testnet proof; not part of the wallet step.
7. **Capital reservation/release:** confirm `reserved ≤ capital` before and after via `get_pool`.
8. **Cleanup/recovery:** a rejected or timed-out approval charges nothing and is rendered as "No cover
   was bought"; no cleanup is required.

## Known limitations (honest list)

- The **hardened** implementation is built, hash-verified and testnet-proven (40/40) but **not deployed
  to the production v3 address** — blocked on the owner key (action A).
- **Legacy v1 SEC-1** is disclosed, labelled, and non-purchasable in the console, but **not repaired**
  and not paused at the contract level — blocked on the legacy owner key (action B).
- The **human v3 purchase** has not occurred; the recorded human purchase is on legacy v1 (PR #39) and
  must not be read as a v3 purchase (action C).
- `verify:sandbox`, `verify:controlled-v3:sandbox`, `test:contract`, `test:onchain` were **not run in
  this sandbox** — no Rust toolchain and no `neard` here. They run in **CI** (`.github/workflows/ci.yml`
  installs Rust 1.99.1 + wasm target and runs them with `REQUIRE_SANDBOX=1`), which executes on the PR.
  `test:onchain` additionally needs funded `keys/identities.json` (absent).
- 19 low-severity transitive npm advisories (`elliptic`) — assessed, accepted, no non-breaking fix.
- Crawler **access** is verified; **indexing** is not (no Search Console access).

## Independent reproduction

```bash
git clone https://github.com/itzebe/overcover && cd overcover
git checkout feat/owner-authority-reconciliation-testnet
npm ci --ignore-scripts
npm run test:model && npm run test:sim && npm run test:console && npm run test:agent
npm run test:agent-eval && npm run test:factory && npm run test:deploy
npm run verify:proof && npm run verify:migration && npm run verify:sec1-takeover
npm run verify:release-ops && npm run verify:upgrade && npm run verify:upgrade-preservation
npm run verify:preservation        # state-preservation baseline vs live
npm run verify:connectivity        # needs CHROME_PATH
npm run axe && npm run ui:qa
```

## What is NOT claimed

No independent third-party audit has occurred. No mainnet deployment exists. No insurance coverage,
partnership, rating, user count or adoption figure is asserted. The v1 human purchase is historical
and legacy. The hardened module is not yet live on the production address. Testnet only.
