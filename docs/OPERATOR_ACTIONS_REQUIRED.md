# Operator actions required — the four credential-gated operations

Every write operation below is **prepared, plan-verified and reproducible**, and every read-only check
around it has been executed. Each one stops at a single, precise authority boundary: a signing key the
automation environment does not hold. Nothing here has been performed. Nothing here should be run
without the correct authorized account.

Run the read-only state check at any time (it never signs, never needs a key):

```bash
npm run verify:release-ops        # → proof/release-ops.json
```

## 1. Contain the live legacy v1 exposure (highest priority)

**Why.** `contract.attestor-overcover.testnet` still runs the v1 module whose `migrate()` is
`#[init(ignore_state)]` with no caller guard: any account can overwrite the contract's state, replace
the owner and the attestor, and then forge an observation to drain the pool. The exposure is
**live** (verified: `get_pool().paused == false`, sha256 `1f30ccf1…`). Blocking purchases in the
console is not contract-level containment.

**Authority needed.** The full-access key of `owner.attestor-overcover.testnet` (the account
`get_config().owner` returns). Without it the operation cannot be authorized, and it must not be
bypassed.

**Account.** `contract.attestor-overcover.testnet` (owner `owner.attestor-overcover.testnet`).

**Smallest human action** — one signed call, using the `near` CLI with the owner key already installed
in `~/.near-credentials` (never paste the key into chat):

```bash
near call contract.attestor-overcover.testnet set_paused '{"paused": true}' \
  --accountId owner.attestor-overcover.testnet
```

**Verify (independent, read-only):**

```bash
near view contract.attestor-overcover.testnet get_pool    # expect "paused": true
npm run verify:release-ops                                # legacy.paused must read true
```

Then confirm the pool is untouched: `capital` = `14050000000000000000000000`,
`reserved` = `10500000000000000000000000`, `policy_count` = `15` (values captured in
`proof/release-ops.json`).

**What pausing does and does not do.** `set_paused(true)` is **containment**: it makes the contract
refuse new purchases and other mutating calls. It does **not** fix the `migrate()` authorization
defect — a determined attacker can still call `migrate()`. Only redeploying the guarded module
(§2) closes SEC-1 permanently. Report the two as separate things.

## 2. Redeploy hardened v3 (closes SEC-1 for the primary contract)

**Why.** `contract.ovc-v3-ctl-2f6c4c.testnet` still runs the **pre-fix** module
(sha256 `a97034e6…`, 500023 bytes). The built, approved module is sha256
`811e0427…` (500342 bytes). The redeploy is **code-only** (a single `DeployContract`, no `new()`,
no `migrate()`) and therefore state-preserving and reversible (rollback = redeploy the prior module,
also code-only).

**Authority needed.** `OVC_V3_SECRET_KEY` in the environment, or `keys/v3-operator.json`
(gitignored), holding the full-access key of `contract.ovc-v3-ctl-2f6c4c.testnet` — or of an account
the contract account delegates to. The environment holds neither.

**Verify the plan first (no key needed):**

```bash
node driver/redeploy-v3.mjs --plan
```

**Deploy (only with the correct key present):**

```bash
OVC_V3_SECRET_KEY=<key> npm run redeploy:v3
```

**Verify (independent, read-only):**

```bash
npm run verify:release-ops        # v3.sha256 must become 811e0427…, 500342 bytes
npm run verify:upgrade-preservation
```

State preservation to check: pool (capital/reserved/paused), config (owner/attestor/quorum), products,
observations, policies, operators, resolvers. Then run the SEC-6 / SEC-7 / SEC-9 suites.

## 3. Hardened-v3 human purchase (the outstanding acceptance test)

**Why.** PR #39's recorded human purchase was made against **legacy v1**, not v3. It is historical
evidence and must never be presented as proof that a human bought cover on the hardened contract. A
real human-approved `buy_cover` on v3 is the outstanding acceptance test, and it depends on §2 being
complete first.

**Authority needed.** A funded NEAR **testnet** wallet the human controls (a browser wallet is fine).
No key ever leaves the human's control.

**Smallest human action.** With §2 verified, open https://overcover.vercel.app/ , connect the testnet
wallet, confirm the page shows `contract.ovc-v3-ctl-2f6c4c.testnet` and network `testnet`, choose a
product, and approve exactly one `buy_cover` call. The console holds no key and signs nothing on its
own.

**Verify.** `npm run verify:release-ops` (or a NEAR explorer) must show the transaction on the v3
account, with a new policy and a matching `reserved` increase.

## 4. OutLayer TDX adapter deployment (optional provenance layer)

**Why.** The adapter that binds an external observation to a verified Intel TDX quote exists and is
tested locally (`poc/outlayer-attested-observation/`, 34/34). Deploying it to OutLayer makes the
provenance real. It is an **optional** layer: it strengthens provenance and never replaces operator
signatures, oracle quorum, bonded disputes or deterministic settlement.

**Prerequisites (both absent here).**

- The official **OutLayer CLI** (verify its source before installing; do not install an untrusted
  binary).
- A funded NEAR **FullAccess** operator key authorized to publish the adapter.

**Smallest human action.** Install the reviewed CLI, authenticate with the authorized operator
account, and publish the adapter WASM (hash recorded in the POC evidence). Do not purchase credits or
create financial commitments.

---

Nothing in this file should be executed by an automation without the correct authorized account, and
no private key, seed phrase or secret should ever be pasted into chat, a commit, or a log.
