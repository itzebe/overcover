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

## 3. Controls that held

| Threat | Control | Evidence |
| --- | --- | --- |
| Pool promises more than it holds | `reserved ≤ capital` re-checked after every state change | 66-attack model (66 defended); Rust tests; live `check_invariant` true |
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
| Reference adversarial model | `npm run test:model` | 66 attacks, 66 defended, 0 exploitable |
| Contract unit tests | `npm run test:contract` | 76 passed |
| Console + wallet journey | `npm run test:console` | 108 passed |
| Agent limits/API/OpenAPI | `npm run test:agent` | 53 passed |
| Product feed + agent eval | `npm run test:agent-eval` | 33 passed |
| Deploy fail-closed regression | `npm run test:deploy` | 21 passed |
| Dependency audit | `npm audit` | 19 low / 0 high / 0 moderate (SEC-5) |
| v2 lifecycle (local sandbox) | `npm run verify:sandbox` | 21/21 passed |
| SEC-1 guard on compiled wasm | `npm run verify:upgrade` | 8/8 passed |
| SEC-1 reproduction (deployed v1) | local sandbox attack | VULNERABLE (pre-fix) |
| SEC-1 fix (v2 wasm) | local sandbox attack | SAFE (post-fix) |
| Secret scan | `git grep -nIE 'ed25519:[0-9A-Za-z]{40,}\|BEGIN .*PRIVATE KEY'` | clean |
