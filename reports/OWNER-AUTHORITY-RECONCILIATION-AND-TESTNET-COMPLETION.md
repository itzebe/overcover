# Owner-authority reconciliation & testnet completion

**Date:** 2026-11-14 · **Network:** NEAR **testnet only** · **Author:** OpenHands agent (execution session)
**Base:** `main` = `0f79dc6afa7995d86a75c2327ebf3792d26f9b45`

This is an execution report. It records what was investigated, what was **actually executed** on
testnet, what was independently verified over RPC, and what remains a genuine owner-controlled action.
Every transaction hash below was re-read from an independent indexer after the run; every code hash was
re-read from `view_code`. No secret value appears in this report, and no secret was printed, copied or
committed at any point.

---

## 0. Headline result

| Operation | Status |
| --- | --- |
| Reconstruct the full wallet/account history | **COMPLETE** |
| Prove which signing credentials remain accessible | **COMPLETE** |
| Deploy the hardened module (SEC-1/6/7/9) to a fresh testnet contract | **COMPLETE — independently verified** |
| Preserve existing v3 state | **COMPLETE** (fresh `new()`; code-only upgrade path prepared for the production account) |
| Harden the **production** v3 account `contract.ovc-v3-ctl-2f6c4c.testnet` | **OWNER ACTION REQUIRED** (key unavailable) |
| Contain legacy v1 `contract.attestor-overcover.testnet` | **BLOCKED** (owner key unavailable) |
| OutLayer production adapter | **NOT REQUIRED** for release (POC optional; deploy BLOCKED on CLI + key) |
| Live human wallet acceptance | **OWNER ACTION REQUIRED** |
| **Overall release-readiness** | **PARTIAL** — fresh hardened testnet contract is live and verified; the production account, legacy containment and human acceptance are owner-only |

The mission's central question — *does this environment control a signer for the existing contracts?* —
is answered with evidence in §2–§4: **it does not**, for any pre-existing account. What it *can* do (and
did) is stand up a **fresh, fully hardened** contract from the free faucet, which requires no pre-existing
key.

---

## 1. Phase A — Wallet / account identity reconciliation

All values read live from `https://test.rpc.fastnear.com` (`view_account`, `view_access_key_list`).

| Identity | Account ID | Public key (on chain) | Permission | Created by | Credential in this env? | Verified signer here? |
| --- | --- | --- | --- | --- | --- | --- |
| Agent service account | `oc-agent-mwb87z4k.testnet` | `ed25519:7oPfWX2sKoPUX9XGsLwiFsWMmUNLnCR3CjKPAWBYDsBv` | FullAccess | OpenHands (earlier session) | **No** | No |
| Agent demo sub-account | `human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet` | `ed25519:Hpej6xzdCvcF7CMsuYLMA4hnKRSGCKcNFdA46tfdiYLx` | FullAccess | OpenHands (earlier session) | **No** | No (it signed the historical PR #39 purchase; that key is gone) |
| **v3 contract (production)** | `contract.ovc-v3-ctl-2f6c4c.testnet` | `ed25519:B5iWCqs99Ww7ZJcjZpuPdXtUPSQKrvUCauzRqA136GVT` | FullAccess | OpenHands (earlier session) | **No** | No |
| v3 funding root (original) | `ovc-v3-ctl-2f6c4c.testnet` | `ed25519:EUBFaRRaGLw5HtyguAVYReMNNsww6KgJZ98deceyssYd` | FullAccess | OpenHands (earlier session) | **No** | No |
| Legacy v1 contract | `contract.attestor-overcover.testnet` | `ed25519:CwZBmKyVjtsUYXfZSWWpedw63MDg2UfngQY7A98eiRre` | FullAccess | OpenHands (earlier session) | **No** | No |
| Legacy v1 owner | `owner.attestor-overcover.testnet` | `ed25519:3RJTRuypY91YqWySqZdHJeFBYB5ctMrcAihiKfNdyfGD` | FullAccess | OpenHands (earlier session) | **No** | No |
| Legacy v1 attestor | `attestor-overcover.testnet` | `ed25519:4dhxyFrsS8y8HhS2CCFYHRbpjTGRudSqPWoHYCRECTxC` | FullAccess | OpenHands (earlier session) | **No** | No |
| v3 funding root (this session) | `ovc-v3-ctl-mwgci3u8.testnet` | `ed25519:Czw8gCc6jhMkjvkKmTB1YVJsSRJuyjJZDUKKofA6fLxq` | FullAccess | **OpenHands (this session, free faucet)** | **Yes** — `keys/controlled-v3.json` (gitignored, 0600) | **Yes** |
| Hardened test contract (this session) | `contract.ovc-v3-ctl-mwgci3u8.testnet` | `ed25519:2B9AjToaitKEy8KMfogxUqCmCCbo4P1tqm96Daswtuy6` | FullAccess | **OpenHands (this session)** | **Yes** — same file | **Yes** |

### The five distinctions the mission asked for

1. **Created by OpenHands:** `oc-agent-mwb87z4k.testnet` (+ its `human-demo-…` sub-account), the legacy
   v1 graph (`contract`/`owner`/`attestor`), the original v3 graph (`ovc-v3-ctl-2f6c4c` root + the v3
   contract) — chain history and the deployment drivers establish this. **And, this session, the whole
   `ovc-v3-ctl-mwgci3u8` graph.**
2. **Funded by OpenHands:** every account above (each was funded from a faucet-created root at creation
   time).
3. **Used for a previous transaction:** all of them (the agent accounts and legacy contract are the
   signers/receiver of the PR #39 purchase; the v3 accounts ran the earlier controlled-v3 deploy).
4. **Whose signing credential is accessible *now*:** **only** the fresh `ovc-v3-ctl-mwgci3u8` graph
   (this session's `keys/controlled-v3.json`). None of the pre-existing accounts' keys are present.
5. **Authorized to control the v3 contract:** `ed25519:B5iWCqs9…` on `contract.ovc-v3-ctl-2f6c4c.testnet`
   (not held here). **Authorized to control legacy v1:** `ed25519:CwZBmKyV…` on
   `contract.attestor-overcover.testnet` (not held here) — a *different* key from the v3 operator.

> The mission's warning is confirmed: the agent account (`oc-agent-…`) is **neither** the v3 operator
> **nor** the legacy owner. They are three unrelated key pairs.

---

## 2. Phase B — Cryptographic authority verification

- Each row above was read from `view_access_key_list`; every listed key is **FullAccess** with no
  receiver/method restriction (the plain `{"permission":"FullAccess"}` form), so none is a narrow
  FunctionCall key that could be misread as authority.
- The **v3** and **legacy** contract accounts each expose exactly **one** FullAccess key — the public
  halves `B5iWCqs9…` and `CwZBmKyV…` respectively. Only public halves are readable from chain; the
  private halves are not derivable.
- The legacy contract's owner is `owner.attestor-overcover.testnet` (`ed25519:3RJTRuyp…`) — **a third,
  separate key** — which is why the legacy `set_paused` is owner-gated and unreachable here.

Authority was established **from on-chain access keys only** — never from an account name, a prior
transaction, an environment-variable name, or a previously successful unrelated call.

---

## 3. Phase C — Credential recovery: what was actually searched

The mission correctly warned that a missing `ed25519:` environment variable does not by itself prove no
signer exists. The following were all checked, in this environment and in the OpenHands execution store:

| Location searched | Result |
| --- | --- |
| Environment variables (all), by **value prefix** `ed25519:` | **0** matches |
| OpenHands **secret registry** (`base_state.json → secret_registry.secret_sources`) — names only | 15 secrets (GitHub, GitLab, Vercel, Supabase, Groq, Gemini, OpenHands, …). **No NEAR signer.** `NEAR_INTENTS_AGENT_API_KEY` is a JWT (`eyJh…`), not a key |
| OpenHands conversation **event log** (16 140 events) for a real `ed25519:` secret (≥80 b58 chars) | **0** matches |
| `~/.openhands/` (`profiles`, `provider-connections`, `git-credentials`, `cache`) | only GitHub/GitLab tokens; no NEAR key |
| `~/.near-credentials/` | **absent** |
| Repo `keys/` directory | only this session's fresh `controlled-v3.json` (gitignored) |
| Whole filesystem `grep -rEo 'ed25519:[1-9A-HJ-NP-Za-km-z]{80,}'` | **0** files |
| Filesystem for NEAR key JSON (`"secret_key":"ed25519…"`) | **0** files |
| Git history / working tree for a committed key | none |

**Conclusion (evidence-backed):** no signing credential for any pre-existing account
(`oc-agent-…`, `contract.ovc-v3-ctl-2f6c4c.testnet`, `contract.attestor-overcover.testnet`,
`owner.attestor-overcover.testnet`) exists in this environment. No brute force, seed recovery or
impersonation was attempted; no new key was generated and passed off as controlling an existing contract.

**Recoverable access:** the free faucet was **re-probed this session and is working again**
(`helper.testnet.near.org/account` → HTTP 200, `EXECUTED_OPTIMISTIC`). This does not recover any old key,
but it **does** allow a fresh, fully-funded, fully-controlled identity graph — which is what Phase D used.

---

## 4. Phase D — Hardened deployment: EXECUTED and independently verified

### 4.1 Rebuild reproduces the exact artifact

Rebuilt from the approved source with the pinned toolchain (`rustup 1.99.1`, `wasm32-unknown-unknown`):

```
sha256 811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f   500342 bytes
```

Byte-for-byte the expected artifact. `driver/redeploy-v3.mjs` refuses to deploy a wasm that lacks the
SEC-1 guard string, so a stale build cannot be shipped by accident.

### 4.2 Live testnet deployment — `40/40` checks

Command: `OVERCOVER_USE_FAUCET=1 REQUIRE_TESTNET=1 npm run verify:controlled-v3`

```
40/40 controlled-v3 checks passed (TESTNET). Contract: contract.ovc-v3-ctl-mwgci3u8.testnet
```

This deployed to a **new, independent account** created from the free faucet; it **never touched** the
production v3 account or the legacy contract. 30 receipts were produced; the complete hash list is in
`proof/controlled-v3-deploy.json`. Representative transactions, each re-verified against the NearBlocks
testnet indexer:

| Step | tx hash | signer → receiver | on-chain |
| --- | --- | --- | --- |
| create contract acct | `3EaKP6yjTJa6MjE3QfyzmDFLA5u67jsS3vw13HVn7vEU` | `ovc-v3-ctl-mwgci3u8` → `contract.…` | **true** |
| deploy code | `CtFfnoyrfnVhE2MqdtZebjtGPzpRyQjkcKUwHvVwqNvX` | `contract.…` → `contract.…` | **true** |
| settle / resolve | `2hojE2gtFiut9fi7rnz2W3sHB98UxgvESV2i6zQy1rcs` | `owner.…` → `contract.…` | **true** |
| SEC-1 refusal (failed as required) | `H6g7RTPcZMaJJTDzBdBnfEZdqnnNNoNaRNVXTZL5ACpf` | third party → `contract.…` | refused: *"migrate may only be called by the contract account itself"* |

### 4.3 Independent post-deployment verification (fresh RPC read, not the harness's own claim)

```
account:   contract.ovc-v3-ctl-mwgci3u8.testnet
code_hash: 9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C
bytes:     500342   sha256: 811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f
matches the hardened artifact 811e0427…: TRUE
guards in the deployed bytes: SEC-1 HAS · SEC-6 HAS · SEC-7 HAS
access keys: ed25519:2B9AjToaitKEy8KMfogxUqCmCCbo4P1tqm96Daswtuy6  FullAccess
pool: capital 1 420 000 …000  reserved 100 000 …000  solvent true  policies 2
invariant reserved ≤ available: TRUE
quorum 3-of-5   resolver_quorum 3-of-5
```

The deployed module is **byte-identical to the hardened source**, and every guard is present in the
**live** code, not merely in the source.

### 4.4 What the live run proved (all on testnet, all passing)

- **SEC-1** — a third-party `migrate()` is refused and the owner is unchanged afterwards.
- **SEC-6** — the reservation is released on a terminal (no-pay) settlement; the pool stays solvent.
- **SEC-7** — a never-reported observation cannot lock capital (covered by the settlement path).
- **SEC-9** — observation-date boundaries are enforced by the contract suite on the **same source** that
  produced the deployed artifact (`sec9_cover_cannot_be_bought_with_an_unbounded_observation_date`;
  `u64::MAX` refused — `contract/src/tests.rs`, part of the 92/92 run). The live 40/40 run exercises the
  dated-reading path but does not itself assert the boundary, so SEC-9 is evidenced by the Rust suite
  plus the byte-identical live artifact, not by an explicit live check.
- **Oracle quorum** — 2-of-5 does **not** finalise; 3-of-5 does; a forged operator signature is refused;
  a non-operator cannot submit.
- **Dispute / resolution independence** — the owner cannot vote; an operator that signed the reading
  cannot resolve its own dispute; the challenger cannot resolve their own dispute; a 3-of-5 resolver
  quorum upholds the reading.
- **Deterministic settlement** — the policy paid above threshold and the reservation was released.
- **Permissionless factory** — a **non-owner** proposal activated a product with no owner transaction;
  the product records the proposer, carries the immutable evidence hash; the stake entered the pool; a
  proposal on an unregistered metric is refused.
- **Accounting** — the pool reconciles after both the owner purchase and the factory purchase; the
  invariant holds throughout.

### 4.5 The production v3 account — the one that still needs the owner

`contract.ovc-v3-ctl-2f6c4c.testnet` still runs the **pre-fix** module (sha256 `a97034e6…`, 500023 B;
**lacks** SEC-6/7/9). Hardening it in place is a **code-only, state-preserving** upgrade prepared in
`driver/redeploy-v3.mjs` (deploys only `DeployContract` code — no `new()`, no `migrate()`), and its
state-preservation property is proven on a real `neard` node:

```
npm run verify:upgrade-preservation → RESULT: state PRESERVED, migrated policy settled.
npm run verify:upgrade             → 8/8 (third-party migrate() refused; state untouched)
```

It was **not sent**, because it requires a signature from `ed25519:B5iWCqs9…` (§1–§2), which this
environment does not hold.

---

## 5. Phase E — Legacy v1 containment

- Live state read this session: `contract.attestor-overcover.testnet`, code_hash `36koHoSdqrYi…`,
  **344857 bytes**, owner `owner.attestor-overcover.testnet`, **`paused: false`**, `solvent: true`,
  capital 14.05 NEAR, reserved 10.50 NEAR, **15 policies**.
- The module has **no SEC-1 guard** (the `migrate()` takeover is present). It is **contained in the
  console only** (labelled *Legacy build*, buying disabled).
- **Status: BLOCKED.** The only key is `ed25519:CwZBmKyV…`, whose private half is not in this
  environment (§3). Nothing was signed for the legacy account. **Pausing is containment, not
  remediation** — the unguarded `migrate()` remains; a pause would only stop new activity.
- **Safest valid next action (owner):** `node driver/upgrade.js` with the legacy `FullAccess` key
  (non-destructive, ~4.63 NEAR refundable stake), which deploys the hardened module in place; or run the
  controlled deployment in `docs/AUTHORITY_RECOVERY.md` §5.

---

## 6. Phase F — OutLayer production integration

- **Not required by the approved release architecture.** The deployed contract verifies **ed25519
  operator signatures** with a 3-of-5 quorum; TEE attestation is an *upstream provenance* layer and does
  **not** replace oracle quorum, signatures or bonded disputes.
- The POC is verified independently (Intel DCAP quote, TCB `UpToDate`, canonical task hash /
  `report_data`, offline fixtures; **34/34** POC tests). A working POC is **not** a production-integrated
  adapter, and the report says so.
- **Status: NOT REQUIRED** for release; the adapter deploy is **BLOCKED** on the `outlayer` CLI and a
  funded FullAccess operator key. No credits or paid infrastructure were purchased.

---

## 7. Phase G — Test results

| Gate | Command | Result |
| --- | --- | --- |
| **Live testnet controlled-v3** | `OVERCOVER_USE_FAUCET=1 REQUIRE_TESTNET=1 npm run verify:controlled-v3` | **40/40 (TESTNET)** — real transactions |
| Contract unit | `npm run test:contract` | 92 passed / 0 failed |
| Reference model | `npm run test:model` | 74/74 defended |
| Simulation | `npm run test:sim` | 79/79 |
| Console + wallet | `npm run test:console` | 132/132 |
| Agent | `npm run test:agent` | 54/54 |
| Agent eval | `npm run test:agent-eval` | 33/33 |
| Factory | `npm run test:factory` | 11/11 |
| Deploy fail-closed | `npm run test:deploy` | 21/21 |
| Sandbox lifecycle | `npm run verify:sandbox` | 28/28 |
| Controlled-v3 (sandbox) | `npm run verify:controlled-v3:sandbox` | 39/39 |
| Upgrade guard / preservation | `npm run verify:upgrade` / `verify:upgrade-preservation` | 8/8 · state PRESERVED |
| SEC-1 takeover repro | `npm run verify:sec1-takeover` | 17/17 |
| Proof / migration | `npm run verify:proof` / `verify:migration` | 13/13 · 6/6 |
| OutLayer POC | `npm run poc:outlayer:test` | 34/34 |
| Accessibility / UI | `npm run axe` / `ui:qa` | 0 violations @320–1440 · PASS |

### Live transaction references (independently indexed)

- create `contract.ovc-v3-ctl-mwgci3u8.testnet`: `3EaKP6yjTJa6MjE3QfyzmDFLA5u67jsS3vw13HVn7vEU`
- deploy hardened code: `CtFfnoyrfnVhE2MqdtZebjtGPzpRyQjkcKUwHvVwqNvX`
- deposit / challenge / resolver_vote / resolve: `45tsTdDT…`, `35fmERJd…`, `LBT5bxay…`, `2hojE2gt…`
- factory propose / restore window: `CGhpj56a…`, `7FaUXudN…`
- SEC-1 refusal: `H6g7RTPcZMaJJTDzBdBnfEZdqnnNNoNaRNVXTZL5ACpf`

Explorer: `https://testnet.nearblocks.io/txns/<hash>`.

**Honest labelling:** the `40/40` result is **live testnet**, with real transaction hashes; the sandbox
and local suites are **local/sandbox**. Nothing here is a simulation presented as a live transaction.

---

## 8. Phase H — Human acceptance boundary (OWNER ACTION REQUIRED)

OpenHands did not, and must not, impersonate the owner. The final acceptance remains a genuine
owner-controlled action, procedure in `docs/HUMAN_ACCEPTANCE_TEST.md`:

1. Open https://overcover.vercel.app/ with the owner's own funded NEAR **testnet** wallet.
2. Verify the network (testnet) and the contract address shown.
3. Inspect the product and the contract-generated quote/premium.
4. Personally authorise and sign exactly one `buy_cover` in the wallet extension.
5. Independently verify the transaction hash and the resulting policy.
6. Verify the observation → quorum → dispute → settlement lifecycle.

No seed phrase or private key is ever requested. Human acceptance is **not** marked complete.

---

## 9. Remaining owner-only actions (exact)

1. **Harden the production v3 account** — `node driver/redeploy-v3.mjs` with the `ed25519:B5iWCqs9…`
   key (code-only, state-preserving; rollback = redeploy the previous module).
2. **Contain legacy v1** — `node driver/upgrade.js` with the `ed25519:CwZBmKyV…` key.
3. **Human wallet acceptance on v3** — `docs/HUMAN_ACCEPTANCE_TEST.md`.
4. **OutLayer adapter deploy (optional)** — `outlayer deploy` with a funded FullAccess key.
5. **Search indexing** — submit the sitemap in Search Console / Webmaster Tools.

## 10. Blockers and their evidence

| Blocker | Evidence |
| --- | --- |
| No signer for production v3 | §1–§3: exhaustive search found **0** `ed25519:` secrets; the account exposes only the public key `B5iWCqs9…` |
| No signer for legacy v1 | §1–§3: only the public key `CwZBmKyV…` is on chain; no private half anywhere |
| OutLayer adapter | needs the `outlayer` CLI + a funded FullAccess key (not present); not a release requirement |
| Search indexing | no Search Console / Bing Webmaster account in this environment |

## 11. Final release-readiness verdict

**PARTIAL.**

- **COMPLETE — independently verified:** the hardened module (SEC-1/6/7/9) is **live on testnet** at
  `contract.ovc-v3-ctl-mwgci3u8.testnet`, byte-identical to the approved artifact (`811e0427…`,
  500342 B), with the full insurance lifecycle, oracle quorum, dispute resolution, deterministic
  settlement, permissionless factory and the accounting invariant all proven by **40/40 live checks**
  and re-verified over RPC.
- **OWNER ACTION REQUIRED:** hardening the **production** v3 account, containing legacy v1, and the live
  human purchase — each blocked solely by an unavailable private key (§10), not by any missing work.
- **NOT REQUIRED:** OutLayer production adapter (POC optional).

Full protocol release readiness is **not** declared: the production account still runs the pre-fix
module, legacy v1 is unguarded, and human acceptance has not occurred. The work that this environment
could legitimately perform is done and verified.

---

*No credential was printed, copied or committed. `keys/` is gitignored (`git check-ignore` confirms).
No mainnet transaction was made. No production contract was altered. No owner action was simulated.*
