# Security pre-audit

**As of:** 2026-11-11 · **Auditor:** OpenHands agent (self-review) · **Scope:** the Overcover
contract, agent service, human wallet path, and production deployment.

This is an **internal pre-audit**, not a third-party audit. It records what was reviewed, what was
found, what was fixed, and what remains open. Every finding below has a reproduction command or an
on-chain/local artefact. Statuses: `FIXED` · `NOT FIXED` · `BLOCKED`.

---

## 1. Method

- Read the full contract (`contract/src/lib.rs`, v1 deployed), the agent (`agent/*.mjs`), the human
  wallet module (`ui/wallet.js` / `ui/index.html`), and the service boundary.
- Reproduce the **exact deployed bytecode** on a local `neard` sandbox (neard 2.14, real JSON-RPC,
  real gas, real signatures) and attack it.
- Run the pure-model adversarial suite (66 attacks) and the Rust unit tests.
- Enumerate the 17 live adversarial tests and state, for each, why it is or is not runnable here.
- Static scans: secret scan over tracked files, dependency audit, "no owner-only method reachable
  from the UI" scan.

The deployed contract was identified by `code_hash 36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R`
and bytecode sha256 `1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e`, pulled fresh
from RPC and re-hashed locally.

---

## 2. Findings

### SEC-1 — CRITICAL — `migrate()` is unauthenticated: any account can overwrite all state

**Where:** `contract/src/lib.rs`, `pub fn migrate` (the deployed **v1** module; fixed in the v2 source on PR #9).

**What.** `migrate` is declared `#[init(ignore_state)]`. A NEAR `init` method runs **before any
state is read**, so it cannot consult the stored `owner`. As written it accepts `owner`, `attestor`,
`challenge_bond`, `settle_delay_sec` and `challenge_window_sec` from the caller and writes a brand
new `Self`. Nothing checks who called it.

**Impact.** Any account can call `migrate(owner = attacker, attestor = <attacker key>, …)` and:
1. become the contract **owner** (then `add_product`, `set_paused`, `set_attestor`,
   `resolve_dispute` are all under attacker control); and
2. install an **attacker-controlled attestor key**, so the attacker can sign arbitrary observations
   and drive `resolve` to pay attacker beneficiaries.

Because `resolve` is the only payout path and the pool holds real (testnet) capital
(`capital 14.05 NEAR` at review time), the chain is: hijack → forge a breaching observation for a
large live policy → `resolve` → drain. The unauthenticated state overwrite also wipes all policies,
products, providers and accounting, so `verify:proof`'s pool check would then read attacker state.

**Reproduction (deployed bytecode, local sandbox, no network, no funds).**

```bash
# fetch the exact deployed module
node -e '
const fs=require("fs");
fetch("https://test.rpc.fastnear.com",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_code",finality:"final",
  account_id:"contract.attestor-overcover.testnet"}})}).then(r=>r.json())
  .then(j=>fs.writeFileSync("/tmp/deployed-v1.wasm",Buffer.from(j.result.code_base64,"base64")));
'
# deploy it on a local sandbox and call migrate() from a third-party account
# (see scripts/ for the sandbox helper; a minimal repro is in this doc's history)
```

Observed on the sandbox:

```
initial owner: owner.test.near | attestor: Afq1eoN3nsGL9NB149yVRZ3CqMujc6GmgcSn2KMwLnKX
PASS  contract initialised with owner
after attacker migrate, owner: attacker.test.near | migrate error: null
VULNERABLE  attacker became owner via migrate()
```

**Fix (v2, PR #9).** Restrict `migrate` to a self-call — the only authority that a
`#[init(ignore_state)]` method can check safely:

```rust
ensure!(
    env::predecessor_account_id() == env::current_account_id(),
    "migrate may only be called by the contract account itself"
);
```

A redeploy performs exactly this self-call (signed by the contract's full-access key). Re-running the
same attack against the fixed wasm:

```
after attacker migrate, owner: owner.test.near | migrate error: Smart contract panicked: migrate may only be called by the contract account itself
SAFE  migrate() was refused or had no effect
```

Rust regression tests: `migrate_by_a_third_party_is_refused`,
`migrate_by_the_contract_itself_is_allowed`, plus the SEC-1 block `sec1_a_third_party_cannot_migrate`,
`sec1_a_refused_migrate_leaves_state_untouched`, `sec1_repeated_third_party_migrate_is_still_refused`,
`sec1_the_contract_account_itself_may_migrate` (`cargo test` → 40 passed).

Independent proof: `npm run verify:migration` (6/6) — the deployed module is byte-identical to the v1
source (`1f30ccf1…`, rebuilt from `18ec7f08`), v1's `migrate()` has the vulnerable shape
(`#[init(ignore_state)]`, no guard), v2's carries the guard, and the guard tests pass.

Live guard proof on the compiled wasm: `npm run verify:upgrade` (8/8) runs the built v2 wasm on a real
local neard node and shows a third-party `migrate()` is refused, the owner and state are untouched, a
repeat is still refused, and the contract's own self-call `migrate()` (the redeploy path) is accepted.

**Deploy fails closed.** Both `driver/deploy.js` and `driver/upgrade.js` refuse to run unless the wasm
contains the guard string, so a stale pre-fix artifact cannot be shipped (`npm run test:deploy`). This
matters: a build of the tree before the fix carries the same v2 exports but no guard — a real
`npm run deploy` would have left SEC-1 open. Always rebuild with the pinned toolchain before deploying.

**Status: FIXED in source (v2/v3); merged into `main` via PR #9; deployed to the controlled testnet
contract `contract.ovc-v3-ctl-2f6c4c.testnet` (proven 40/40 by `npm run verify:controlled-v3`).** The
**legacy live address** `contract.attestor-overcover.testnet` still runs v1 and remains vulnerable
because patching it requires redeploying the wasm, which needs the operator key this environment does
not hold (see §4). This is the single most important reason the operator's in-place upgrade must
happen before the legacy address is presented as hardened.

---

### SEC-2 — HIGH — idempotency was not safe under concurrent requests (agent service)

**Where:** `agent/server.mjs`, `POST /api/v1/agent/buy`.

**What.** The route did *check → `await` buy → store result*. Two requests carrying the **same**
`idempotencyKey` that arrive together both see the key as unknown and both execute the buy — the
exact double-purchase the key exists to prevent.

**Impact.** A retrying client (or an attacker who can reach the service) can cause two purchases from
one logical order, spending the agent's funds twice.

**Reproduction.** `tests/agent-api.test.mjs` → *"concurrent buys with the same idempotency key execute
exactly once"*: fails on the old code (two `dry_run` audit entries), passes after the fix.

**Fix.** Reserve the key **before** the first `await`, storing a promise; a second request awaits the
first's result and is flagged `idempotentReplay`. A failure is not cached, so a genuine retry can
still succeed.

**Status: FIXED** (PR #14).

---

### SEC-3 — HIGH — spending limits could be bypassed by overlapping buys

**Where:** `agent/agent.mjs` + `agent/limits.mjs` (`evaluate` reads `history`, then `buy` records).

**What.** The limits are check-then-act. Two buys with **different** keys that overlapped both read
the same pre-buy `history`, both passed, and only then recorded their spend. Together they could
exceed `dailyPremiumBudget` or `dailyPolicyLimit`.

**Impact.** The agent's headline safety property — "it cannot spend beyond the policy's ceilings" —
was false under concurrency.

**Reproduction.** `tests/agent-limits.test.mjs` → *"without serialization, two overlapping checks both
pass and breach the budget"* documents the race; the serializer tests prove the fix.

**Fix.** A `createSerializer()` primitive runs every buy one at a time, in submission order;
`decide` stays read-only and unserialized.

**Status: FIXED** (PR #14).

---

### SEC-4 — MEDIUM — the agent service had no authentication

**Where:** `agent/server.mjs`.

**What.** The service binds `127.0.0.1` by default and is dry-run by default, but nothing prevented
an operator from binding it to `0.0.0.0` — at which point **any** caller could spend the agent's
funds (subject only to the spending limits).

**Fix.** If `OVERCOVER_AGENT_HOST` is not loopback, the service **requires** `OVERCOVER_AGENT_TOKEN`
and refuses to start without one. A configured token is enforced on every route with a constant-time
comparison; a request without the correct bearer token gets `401` before any work. The OpenAPI spec
now declares `bearerAuth` and the `401`. Loopback with no token stays open for local development.

**Status: FIXED** (PR #14). `tests/agent-api.test.mjs` (401 without / 401 wrong / 200 correct) and
`tests/agent-openapi.test.mjs` (spec documents the scheme).

---

### SEC-5 — LOW — dependency advisories in the wallet stack (partially remediated)

**What.** `npm audit` reported 9 high / 2 moderate / 16 low advisories, all transitively through the
wallet libraries: `@here-wallet/core` → `bn.js`; `@meteorwallet/sdk` → `nanoid`, `query-string` →
`decode-uri-component` (DoS); `near-api-js`/`bs58` → `base-x` (homograph). The `npm audit fix`
recommendation was a **breaking** downgrade of the wallet selector (10 → 9), which was rejected.

**Remediation (this mission).** The vulnerable leaves were pinned **forward** with npm `overrides`
(same-major, API-compatible patch/minor releases), which clears every high and moderate advisory
without touching the wallet-selector major:

| Package | Was | Now | Advisory cleared |
| --- | --- | --- | --- |
| `nanoid` | 5.1.5 | 5.1.16 | infinite-loop generators (high) |
| `bn.js` (via `@here-wallet/core`, `borsh`) | 5.2.1 | 5.2.5 | affected-by-infinite-loop (moderate) |
| `base-x` (via `bs58`) | 2.0.6 | 3.0.11 | homograph (high) |
| `decode-uri-component` (via `query-string`) | 0.2.2 | 0.5.1 | exponential-decoding DoS (high) |

Result: `npm audit` **19 low / 0 high / 0 moderate**. The residual 19 low advisories are
`elliptic` (via `crypto-browserify`, a **devDependency** used only to build the bundle; the 6.x line
is the patched one and the advisory is informational), plus the transitive wallet-lib parents that
still list an affected range in their own metadata.

**Why the leaves were safe to bump.** All four are patch/minor moves within their major (except
`base-x` 2→3 and `decode-uri-component` 0.2→0.5, both of which are bug-fix lines with no API change
that these consumers use). The overrides were verified not to regress the product: the shipped
bundle was rebuilt and the real browser path re-tested — the wallet selector still initialises with
both HERE and Meteor, the console tests (108), agent tests (53), and the live connectivity proof
(12/12) all pass against the rebuilt bundle.

**Status: FIXED for every high/moderate advisory (verified).** 19 low advisories remain; recommended
follow-up is to track an upstream `@near-wallet-selector` release that drops the affected transitive
ranges and then remove the overrides.

---

### SEC-6 — HIGH — a nullified or expired observation permanently locked reserved capital

**Where:** `contract/src/lib.rs`, `resolve` / `observation_settlement` (present in the deployed v3
module).

**What.** A policy reserves its payout at purchase. If the observation for its `(metric, city, date)`
key was **nullified** by a resolver quorum, or **expired**, no replacement reading can ever be
finalised for that key, so the policy can never pay. But `resolve` refused on *any* non-payable
observation — including these terminal ones — and no other path released the reservation. The
reservation stayed locked forever, and because `withdraw` fails while `capital − amount < reserved`,
the provider capital backing that policy could **never** be withdrawn.

**Impact.** Permanent, permissionless denial of provider capital. The attacker pays only the premium
of one policy; the pool's whole payout for that policy is stranded, and `withdraw` for the affected
providers keeps failing indefinitely. It compounds: every stranded policy reduces the withdrawable
fraction of the pool.

**Reproduction (contract test, pre-fix).** `sec6_nullified_observation_releases_the_reservation` and
`sec6_expired_observation_releases_the_reservation` in `contract/src/tests.rs`: before the fix
`resolve` panicked and `reserved` stayed at the payout. End-to-end on the compiled wasm,
`tests/sandbox-lifecycle.mjs` (the SEC-6 block) nullifies a real reading on a real `neard` node and
asserts the reservation is released and `withdraw` no longer fails.

**Root cause.** `observation_settlement` returned one undifferentiated "cannot settle" for two very
different situations — a *transient* block (missing reading, live challenge window, unresolved
dispute) where the reservation must be held, and a *terminal* invalidity (nullified/expired) where it
must be released.

**Fix.** Introduce a `Settlement` enum (`Ok` / `Blocked` / `Invalid`). `resolve` holds the
reservation on `Blocked` and releases it on every terminal outcome (`Invalid` → no-pay settlement).
The release is unconditional and happens exactly once. The `reason` is emitted in the
`policy_settled` event so the outcome is observable.

**Status: FIXED in source (this branch); mirrored in the reference model (`sim/engine.mjs`
`observationValid`, `sim/scenarios.mjs` A14b/A17/A26). Regression tests: 3 Rust tests + the sandbox
SEC-6 block.** NOTE: the **deployed** v3 module (`code_hash CQR8x1kW…`, sha256 `a97034e6…`) still
carries the old behaviour; closing it on the live address needs a redeploy (operator key).

---

### SEC-7 — HIGH — a policy whose reading is NEVER reported permanently locked reserved capital

**Where:** `contract/src/lib.rs`, `observation_settlement` (missing-observation branch).

**What.** A reading for date `D` may only be submitted while `D ≤ reported_at ≤ now` and
`reported_at − D ≤ 24 h` (`REPORT_MAX_DELAY_SEC`), and it must be unexpired at submission. If **no**
observation is finalised for a policy's key by the last instant a reading can still be accepted, the
key is terminally empty: no reading can ever arrive, so the policy can never pay. `observation_settlement`
nonetheless returned the *transient* "no observation" block forever, so `resolve` refused forever and
the reservation was locked permanently. This is the same capital-lock class as SEC-6, reached through a
**missing** reading rather than an invalid one.

**Impact.** A permissionless denial of provider capital that an attacker can trigger with a
**permissionless** product (`propose_product`) for a city no operator covers: the attacker stakes the
proposal cost and buys a policy, and the whole payout of provider capital is stranded forever. No
operator misbehaviour is required — an ordinary outage (no reading published) is enough.

**Reproduction.** `sec7_a_reading_that_never_arrives_releases_the_reservation` (`contract/src/tests.rs`):
pre-fix `resolve` panicked `cannot settle: no observation` and `reserved` stayed at the payout.
`sec7_a_reading_still_possible_keeps_the_reservation` proves the guard is not over-eager.

**Root cause.** `observation_settlement` returned one undifferentiated "no observation" for two very
different situations — a *transient* block (a reading may still arrive) where the reservation must be
held, and a *terminal* emptiness where it must be released.

**Fix.** In the missing-observation branch, classify by time. The terminal instant is **not**
`D + 24 h`: because `reported_at` is an operator-declared, signed field that may be **backdated**, a
valid reading can legitimately be submitted up to `D + REPORT_MAX_DELAY_SEC + READING_MAX_VALIDITY_SEC`
wall-clock (a report backdated to `D + 24 h` whose expiry sits at the validity horizon). Settling
no-pay before that would deny a real payout. So: before that last instant it is `Blocked` (hold); after
it, `Invalid` (release). Mirrored in `sim/engine.mjs` and `sim/scenarios.mjs` (A30 / A30b / A30b2 / A30c).

> **A flaw caught during this mission.** The first version of this fix used the bound `D + 24 h`, which
> is wrong: `sec7_a_backdated_reading_can_arrive_after_the_report_delay` (Rust) shows a breach reading
> backdated to `D + 24 h` and submitted at `D + 24 h + 6 h` still finalises, so a `D + 24 h` release
> would have settled it no-pay and denied the payout. The bound was corrected to
> `D + REPORT_MAX_DELAY_SEC + READING_MAX_VALIDITY_SEC`. This is recorded deliberately: it is exactly
> the kind of premature-settlement bug a naive "missing reading" fix introduces.

**Status: FIXED in source (this branch). Regression tests: 4 Rust tests + model scenarios A30–A30c.**
The deployed v3 module also carries the old behaviour (same redeploy caveat as SEC-6).

---

### SEC-8 — LOW/MEDIUM — production response headers were incomplete (no clickjacking or CSP control)

**Where:** `vercel.json` (the only place headers are set for the static site).

**What.** The production site returned `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and HSTS
(added by Vercel), but **no** `X-Frame-Options` / `frame-ancestors` and **no** `Content-Security-Policy`.
The console is a single static page that holds no key and signs nothing except, at the user's explicit
click, one `buy_cover` through the injected NEAR wallet extension. With no framing control the page can
be embedded in an attacker's iframe and overlapped (clickjacking); a wallet-approval surface is a
sensible target for a UI-redress attack.

**Reproduction.** `curl -sD - -o /dev/null https://overcover.vercel.app/ | grep -i 'x-frame\|content-security'`
returned nothing before the fix.

**Fix.** `vercel.json` now also sets `X-Frame-Options: DENY` and a conservative `Permissions-Policy`
(`camera=(), microphone=(), geolocation=(), payment=()`). Both are safe for the page: it embeds no
frames of its own and uses none of those features.

**CSP — now added, pinned to the inline script.** A `Content-Security-Policy` **is** applied. The page
ships one inline `<script>` (the whole console) plus two same-origin bundles
(`vendor/wallet-bundle.js`, `vendor/policy.js`). Rather than allow `unsafe-inline` for script, the
policy pins the inline script by its exact `sha256` (`script-src 'self' 'sha256-…'`); the browser
hashes the script and only runs it if the bytes match. This is verified in a real browser, not assumed:

- `tests/ui.browser.mjs` now serves the header from `vercel.json`, so `npm run ui:qa` loads the page
  **under the deployed policy** and passes across 7 viewports — including the wallet dialog and the
  full agent round-trip. A policy that blocked the page's own script (or the wallet's inline styles)
  fails this run.
- The policy also sets `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
  `form-action 'none'` and `style-src 'self' 'unsafe-inline'` (the wallet selector writes inline styles;
  allowing inline **styles** is not a script-injection vector).
- `connect-src` is `'self' https: http://127.0.0.1:* http://localhost:*` — deliberately broad on the
  https scheme because the wallet selector reaches a wide, evolving set of wallet/RPC origins, plus the
  local agent service over loopback. The honest gain is the **script**, `object`, `base-uri`,
  `frame-ancestors` and `form-action` locks; the network egress allowlist is not tight and is not claimed
  to be. Tightening `connect-src` to a tested allowlist is a recorded follow-up.
- `tests/console.test.js` recomputes the inline script's hash and asserts the header still contains it,
  so editing the console without updating the policy fails the suite loudly rather than silently
  breaking the deployed page.

**Status: header gap FIXED (X-Frame-Options + Permissions-Policy + a hash-pinned CSP).** The earlier
note that a strict CSP "would need `unsafe-inline` for script" was wrong — hashing removes that need —
and is superseded by the browser-verified policy above.

---

### SEC-9 — HIGH — an unbounded observation date permanently locked reserved capital

**Where:** `contract/src/lib.rs` — `buy_cover` (the lead-time check).

**What.** `buy_cover` bounded `obs_date` only from **below** (`obs_date >= now + min_lead_sec`). There
was **no upper bound**. The reservation taken at purchase is released only in `resolve`, and `resolve`
requires `now >= obs_date + settle_delay_sec` (with `saturating_add`). So a buyer could reserve the
payout against an arbitrarily distant `obs_date` — and `obs_date = u64::MAX` makes `now >= obs_date +
settle_delay` **unreachable forever**. The reserved capital is then locked permanently and providers can
never withdraw it (`withdraw` fails closed while `capital - amount < reserved`). The attacker pays only
the premium — as low as **1 bp** on a permissionless product (`PROPOSAL_MIN_PREMIUM_BP`) — to strand the
whole payout of provider capital.

**Reproduction (Rust unit test, `contract/src/tests.rs`).**
`sec9_cover_cannot_be_bought_with_an_unbounded_observation_date` buys cover with a century-out date and
with `u64::MAX`. Before the fix the purchase **succeeded** (a policy was issued and 100 NEAR reserved) —
the test failed with "an unbounded observation date must be refused". Model parity: `sim/scenarios.mjs`
A31/A31b/A31c.

**Root cause.** A missing upper bound on a caller-supplied time field that gates a funds-release path.
The `min_lead_sec` check protects only the *lower* end of the window; nothing protected the upper end.

**Fix.** A protocol maximum lead `MAX_LEAD_SEC = 365 * 24 * 3600` (one year — longer than any legitimate
parametric product, short enough to keep `obs_date + settle_delay_sec` far from `u64` overflow).
`buy_cover` now requires `obs_date - now <= MAX_LEAD_SEC` (the subtraction is safe because the lower
bound already guarantees `obs_date >= now`). Product creation also validates `min_lead_sec <= MAX_LEAD_SEC`
so no product can be configured with an unusable lead. Mirrored in `sim/engine.mjs`.

**Regression tests.** `sec9_…` (Rust, 2 refused cases + 1 in-bound control) and model A31/A31b/A31c/A31d.

**Independent reproduction (isolated git worktree at `d086dd8`, never the release branch).** Removing
the guard and adding an attack probe gives a complementary pair: with the guard removed the **probe
passes** — `buy_cover(obs_date = u64::MAX)` issues policy 1, `reserved` becomes 100 NEAR, the provider's
withdrawable capital drops to `capital − reserved`, and withdrawing the provider's full 1000 NEAR deposit
is refused (the provider is left holding 100 NEAR it can never recover) — while the **regression test
fails** ("an unbounded observation date must be refused"). Restoring the guard reverses both. Boundary
probes (also in the worktree): `obs_date == now + MAX_LEAD_SEC` is accepted, `+1` is refused; a product
whose `min_lead_sec == MAX_LEAD_SEC` is accepted, `+1` is refused at creation; a **past** `obs_date` is
refused by the min-lead check, which runs first, so `obs_date - now` never underflows. No alternate
path sets `obs_date` (`buy_cover` is the only policy-creation entry point; `propose_product` hardcodes
`min_lead_sec = 3600`). Mutation-tested: the tests fail against the pre-fix code and against a plausible
wrong fix that bounds the lead at an absurdly large constant.

**Status: FIXED in source.** The **deployed** v3 module (`code_hash CQR8x1kW…`, sha256 `a97034e6…`)
still carries the unbounded-lead behaviour; see the deployment-divergence section.

---

### SEC-10 — LOW — a code-only hardening deploy would have locked buying in the console

**Where:** `ui/index.html` — the console's approved-build map (`TRUSTED`).

**What.** The console decides whether it may sign a `buy_cover` by reading the deployment's `code_hash`
and comparing it to a hardcoded approved value. For the hardened address that value was a **single**
hash (`CQR8x1kW…`). The planned SEC-6/7/9 hardening is a **code-only** redeploy to the same account: the
account keeps its state but its `code_hash` changes to `9h296MCN…`. After that deploy the console would
have read the contract fine but shown *"its deployed module does not match the approved build"* and
**disabled buying** — a self-inflicted availability failure that looks like a trust refusal.

**Reproduction.** Deploy `811e0427…` to `contract.ovc-v3-ctl-2f6c4c.testnet`, open the console: the buy
button is disabled with the "does not match the approved build" reason, although the module is the
correct, hardened one. (No funds move; the failure is a refused purchase.)

**Root cause.** A one-value allowlist that must be edited in lockstep with a deploy, with no test tying
the two together.

**Fix.** The map is now a **list** of approved builds per address and `trustFor` accepts any member.
Both the live module and the SEC-6/7/9 build are accepted for the hardened address; the superseded hash
is dropped once the deploy is verified (recorded in `docs/DEPLOY_RUNBOOK.md` §4). `tests/console.test.js`
asserts the hardened address accepts both builds and that trust is decided against the whole list.

**Status: FIXED.** The deployed contract is unchanged; this is a console/runbook change.

---

### SEC-11 — LOW — an evidence URL from the factory feed was rendered without a scheme check

**Where:** `ui/index.html` — `renderFactory`, the evidence link (`<a href="' + esc(ev.sourceUrl) + '">`).

**What.** The factory view renders each proposal's `evidence.sourceUrl` (from `ui/factory.json`) as a
hyperlink. `esc()` correctly stops attribute break-out (`"`, `<`, `>`), so there is no HTML injection —
but it does **not** restrict the URL **scheme**. A value of `javascript:…` or `data:text/html,…` would
have been emitted as a live `href` and executed on click. The feed is generated by an operator script
(`scripts/factory-feed.mjs`), so reaching this needs the feed to be compromised or replaced — hence LOW —
but the console renders it as untrusted input and should not rely on the feed being benign.

**Reproduction.** Put `"sourceUrl": "javascript:alert(document.domain)"` in a proposal in
`ui/factory.json`, load the page, click the evidence link: the handler runs. Before the fix the markup
contained a live `javascript:` href.

**Root cause.** Attribute-escaping was treated as sufficient for a value that is used in a URL context,
where the scheme is the dangerous part.

**Fix.** A `safeUrl` helper returns the escaped URL only when it starts with `http://` or `https://`, and
an empty string otherwise; the renderer uses it for the evidence link, so a non-http(s) value renders as
a link with no destination rather than a live one. Regression tests assert `javascript:`/`data:` are
refused and that the dangerous scheme never appears in the output, alongside the existing escaping test
for `<`, `>`, `&`, `"`, `'`.

**Status: FIXED.** Console-only; the deployed contract is unchanged.

---

## 3. Controls that held

| Threat | Control | Evidence |
| --- | --- | --- |
| Pool promises more than it holds | `reserved ≤ capital` re-checked after every state change | 70-attack model (70 defended); Rust tests; live `check_invariant` true |
| Withdraw capital backing live policies | `withdraw` refuses unless `capital − amount ≥ reserved` | model A5; live `reconcile` true |
| Buyer re-prices or underpays | Product owns threshold + premium; deposit must equal `quote` | model A4; Rust tests |
| Forged / replayed / cross-contract observation | ed25519 signature binds city, date, value, time, nonce **and contract id** | Rust tests; live demo |
| Double payout | `resolve` settles exactly once (terminal status) | Rust tests; policies 3/4 |
| Oracle lies | Bonded `challenge_observation`; disputed reading cannot settle | live demo (both directions) |
| Unauthorised admin | `add_product`, `set_attestor`, `set_paused`, `resolve_dispute` owner-only | Rust tests; live |
| Silent failure | every refusal aborts with a `panic_utf8` reason | live refusals observed |
| UI reaches an owner-only method | page/wallet/agent never name one | `verify:connectivity` check 8 |
| UI holds a key | page signs nothing; wallet signs one `buy_cover` scoped key | `verify:connectivity` 7, 10, 11 |
| Secret in tracked files | no ed25519 secret, key file, or private key | `git grep` scan clean; CI check |
| Terminal observation cannot lock capital | a nullified / expired / never-reported reading settles no-pay and releases the reservation | SEC-6 + SEC-7 Rust tests; model A30; sandbox SEC-6 block |
| A transient block still holds the reservation | a live challenge or unresolved dispute refuses settlement and keeps the reservation | `sec6_a_transient_block_still_refuses_and_holds_the_reservation`, `sec7_a_reading_still_possible_keeps_the_reservation` |
| An unbounded observation date cannot lock capital | `buy_cover` caps the lead at `MAX_LEAD_SEC` (1 year) | SEC-9 Rust test; model A31/A31b/A31c |
| A hardening redeploy cannot silently disable buying | the approved-build list accepts the live module and the pending SEC-6/7/9 build | SEC-10 console test |

---

## 4. Live adversarial suite (17 tests) — status and blockers

`npm run test:onchain` runs `tests/adversarial.test.js` against the **live** contract. It needs two
gitignored operator files — `keys/identities.json` and `keys/state.json` — which do not exist in this
environment. It fails cleanly with `missing …/keys/identities.json; run: node driver/keys.js`, it does
not corrupt state, and it is not part of `npm test`. **Blocked by human action (the funded operator
key); this is by design — the keys are never committed.**

The 17 cases it covers, and where each is independently defended today:

| # | Case | Also proven by |
| --- | --- | --- |
| 1 | Non-owner cannot publish a product | Rust tests; model |
| 2 | Capacity < a single max payout rejected | Rust tests; model A3 |
| 3 | Premium rate > 100 % rejected | Rust tests |
| 4 | Buy beyond product capacity rejected | model A3 |
| 5 | Underpaid premium rejected | Rust tests; model A4 |
| 6 | Buy past the observation date rejected | Rust tests; model A7 |
| 7 | Coverage beyond available capital rejected (solvency) | Rust tests; model A8 |
| 8 | Non-owner cannot pause / rotate attestor | Rust tests |
| 9 | Non-attestor signature rejected | Rust tests |
| 10 | Replayed observation nonce rejected | Rust tests |
| 11 | Cross-contract signature rejected | Rust tests |
| 12 | Stale observation rejected | Rust tests |
| 13 | Implausible reading rejected | Rust tests |
| 14 | Resolve before observation date rejected | Rust tests; model A9 |
| 15 | Disputed observation cannot settle | Rust tests |
| 16 | Double resolve rejected | Rust tests |
| 17 | Paused pool refuses purchases | Rust tests; v2 sandbox |

---

## 5. Residual risk (honest)

- **The live v1 contract is vulnerable to SEC-1 until it is redeployed.** No key material exists in
  this environment; the operator account `attestor-overcover.testnet` holds 13.31 NEAR and the contract
  account `contract.attestor-overcover.testnet` holds 18.55 NEAR (funding is sufficient — the blocker
  is the key, not the balance). Closing it needs one in-place upgrade: `node driver/upgrade.js`
  (DeployContract + self-call `migrate`, ~4.63 NEAR refundable code stake). The runbook is
  `docs/DEPLOY_RUNBOOK.md`. The upgrade is non-destructive: `migrate` preserves the address, pool
  capital, products and policies — proven against the exact live v1 bytecode by
  `npm run verify:upgrade-preservation` (the earlier `migrate` that called `new_state` did **not**
  preserve state; that is the bug this fixed). It cannot be done from this environment.
- **Single attestor on v1; owner-resolved disputes** — a centralisation point. v2 (operator quorum +
  independent resolvers) removes it but is not deployed.
- **No third-party audit; testnet only.** Not for real funds.
- **Agent rate limits and idempotency are per-process**, not a distributed limit. A multi-process
  deployment must centralise spend state.
- **Dependency advisories (SEC-5)** — every high/moderate advisory is now cleared via forward
  `overrides` (nanoid, bn.js, base-x, decode-uri-component); 19 low advisories remain (dev-only
  `elliptic` and transitive parents), no exploit path identified in the shipped static page.

---

## 6. Verification matrix

| Check | Command | Result |
| --- | --- | --- |
| Reference adversarial model | `npm run test:model` | 73 attacks, 73 defended, 0 exploitable |
| Contract unit tests | `npm run test:contract` | 83 passed |
| Console + wallet journey | `npm run test:console` | 108 passed |
| Agent limits/API/OpenAPI | `npm run test:agent` | 53 passed |
| Product feed + agent eval | `npm run test:agent-eval` | 33 passed |
| Deploy fail-closed regression | `npm run test:deploy` | 21 passed |
| Dependency audit | `npm audit` | 19 low / 0 high / 0 moderate (SEC-5) |
| v3 lifecycle (local sandbox) | `npm run verify:sandbox` | 28/28 passed |
| SEC-1 guard on compiled wasm | `npm run verify:upgrade` | 8/8 passed |
| SEC-1 reproduction (deployed v1) | local sandbox attack | VULNERABLE (pre-fix) |
| SEC-1 fix (v2 wasm) | local sandbox attack | SAFE (post-fix) |
| SEC-9 mutation check | temporary mutation harness | 5/5 mutations detected (original + plausible wrong fixes) |
| Secret scan | `git grep -nIE 'ed25519:[0-9A-Za-z]{40,}\|BEGIN .*PRIVATE KEY'` | clean |
