# Successor deployment readiness

**Question this answers:** can the hardened reference deployment serve as the basis for a
controlled successor, so new cover runs on a contract whose authority is durable and held — without
the lost original keys, and without touching the legacy address or its policyholders?

**Verdict: YES — the architecture is ready and independently verified; the remaining gap is durable
key custody, which is an owner action, not an engineering one.** No deployment was executed. Per the
mission's rule, a new deployment waits for explicit owner approval of the architecture, the
authority model and the exact testnet operation (§7).

Evidence base: `proof/controlled-v3-onchain-evidence.json` (independently re-read from RPC),
`proof/controlled-v3-deploy.json`, `proof/controlled-v3-sandbox.json`, `npm run verify:controlled-v3:plan`,
`npm run verify:controlled-v3:evidence`, and the Rust suite (`cargo test`, 97/97 — including the new
`rot1..rot5` key-rotation tests).

---

## 1. The reference deployment, as it stands

| Field | Value |
| --- | --- |
| Contract account | `contract.ovc-v3-ctl-mwgci3u8.testnet` |
| Deployed wasm sha256 | `811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f` (500,342 bytes) |
| code_hash (base58) | `9h296MCND93dzHQn4vVUeEVai3VuohDbo9VJFntpT45C` |
| Owner | `owner.ovc-v3-ctl-mwgci3u8.testnet` (a **separate** account from the contract) |
| Guards present in deployed bytes | SEC-1, SEC-6, SEC-7, SEC-9 (verified by string scan of the live code) |
| Operators / resolvers | 5 + 5, quorum 3 + 3 |
| Live checks | **40/40** (`verify:controlled-v3`, run 4) and **39/39** in sandbox |
| Source parity | The deployed bytes are **byte-identical to this repository's HEAD source** (the local `cargo build` reproduces `811e0427…` exactly) |

**Crucially, the owner/operator authority for this deployment is held.** `keys/controlled-v3.json`
(mode `0600`, gitignored) holds FullAccess keys for all 15 accounts, including
`owner.ovc-v3-ctl-mwgci3u8.testnet` (`ed25519:9U3GiCaE…`) and the contract account
(`ed25519:2B9AjToa…`). This is what the original v3/v1 deployments lacked: their keys were generated
in earlier sandboxes and lost.

## 2. The ten questions, answered with evidence

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Deploy an owner-controlled contract without the lost keys? | **Yes.** A fresh account is created with a new keypair; the owner is a separate account. The reference proves it end-to-end. | `verify:controlled-v3:plan` prints the exact 16-account plan; `proof/controlled-v3-onchain-evidence.json` shows the live result. |
| 2 | Persist owner/operator keys securely? | **Mechanism yes; durability is an owner action.** The tooling reads a `0600`, gitignored `keys/*.json` or an env var (`OVC_V3_SECRET_KEY`); keys are never printed or committed. **But** a sandbox-local file is exactly how the originals were lost. Durable custody must be the owner holding the key off-platform. | `driver/redeploy-v3.mjs` `loadKey()`; `keys/controlled-v3.json` is `0600` and gitignored; `.gitignore`. |
| 3 | Test key rotation and recovery before deployment? | **Rotation: yes (now).** `rotate_operator_key` is owner-gated and covered by 5 new tests (`rot1..rot5`). **Recovery of a *lost* key: no such path exists** — NEAR has no escrow. | `contract/src/tests.rs` `rot1_rotated_operator_key_is_the_only_accepted_key` … `rot5`; `cargo test` 97/97. |
| 4 | Support the complete original lifecycle? | **Yes.** Deploy+init, products (owner and permissionless factory), buy, quorum observation, challenge, resolver-quorum dispute, settle, pool accounting. | `verify:sandbox` 28/28; `verify:controlled-v3:sandbox` 39/39; live 40/40. |
| 5 | Preserve capital-reservation and settlement invariants? | **Yes.** `reserved ≤ capital` is re-checked after every mutation on-chain, and asserted independently by the fuzz harness. | `check_invariant()`, `reconcile()`; `contract/src/tests.rs` `assert_pool_sound`; `stateful_fuzz_seed_*`. |
| 6 | Prevent accidental interaction with legacy? | **Yes (front-end).** The console signs only against an allowlisted `(address, code_hash)`; the legacy address is a distinct account that never matches. | `ui/index.html` `TRUSTED`/`trustFor`; `verify:connectivity` check 13. |
| 7 | Distinguish old vs successor addresses? | **Yes.** By deployed code hash, not a label: *Hardened build* vs *Legacy build*, and buying is blocked on legacy. | `ui/index.html` `renderSecurityBanner`; `verify:connectivity` 13/13. |
| 8 | Represent existing policies without a false migration claim? | **Yes.** The console lists legacy policies as legacy state; no successor claims to have assumed them. | `LEGACY_POLICYHOLDER_RECONCILIATION.md`; console *Policies written* reads the selected contract only. |
| 9 | Accept new human purchases without harming legacy holders? | **Yes.** Separate account, separate pool. A successor purchase cannot move or strand a legacy policy. | Distinct `capital`/`reserved` on each account (`proof/legacy-reconciliation.json`). |
| 10 | Independently verifiable and recoverable by the authorised user? | **Verifiable: yes** (public RPC + committed evidence). **Recoverable: only if the owner holds the key** — hence §3/§7. | `verify:controlled-v3:evidence` re-reads all four runs from RPC. |

## 3. The one real gap: durable authority

Everything above is engineering-complete. The only thing standing between the reference and a
successor that cannot suffer the original failure is **who holds the key, and where**. Today the
reference keys sit in a sandbox-local file — the same class of location that lost the originals.
Three honest options:

| Option | What it is | Requirement |
| --- | --- | --- |
| **A. Adopt the reference** | Keep `contract.ovc-v3-ctl-mwgci3u8.testnet` as the successor and hand its authority to the owner. | The operator (who holds `keys/controlled-v3.json`) adds the **owner's own** public key as a FullAccess key to `owner.ovc-v3-ctl-mwgci3u8.testnet` and `contract.ovc-v3-ctl-mwgci3u8.testnet`, then the owner stores that key off-platform and the operator's key is removed. |
| **B. Fresh deployment under the owner's key** | Create a new root the owner controls and deploy the same wasm. | The owner generates a root account/key they store durably; the plan in §7 runs against it. |
| **C. In-place hardening of the existing v3** | Redeploy the hardened wasm to `contract.ovc-v3-ctl-2f6c4c.testnet` (code-only, state-preserving). | The **lost v3 key** — **not possible**. |

**Recommendation: A or B.** Both put the key in the owner's hands; neither touches the legacy
address or its policies. C is listed only to mark it closed.

## 4. What a successor must have (acceptance criteria)

- [x] Owner/operator **account separation** (owner is its own account).
- [x] **No private keys in the repository** (keys are `0600`, gitignored; verified by the secret scan).
- [x] **No dependency on a sandbox-local file at runtime** for reads; writes need a key the operator supplies.
- [ ] **Durable custody** by the owner (options A/B) — *outstanding owner action*.
- [x] **Reproducible artifact and hash** (`cargo build` → `811e0427…`, byte-identical).
- [x] **Independent post-deployment verification** (`verify:controlled-v3:evidence`).
- [x] **Tested key rotation** (`rot1..rot5`).
- [x] **Explicit successor-vs-legacy distinction** (code-hash allowlist).
- [x] **No automatic migration** of legacy policies or funds.

## 5. Key-rotation and recovery behaviour (evidence)

- `rotate_operator_key(account, new_public_key)` — **owner-gated**, 32-byte key required, replaces the
  operator's key in place (the account is unchanged). `rot2` proves a non-owner is refused; `rot1`
  proves the old key stops verifying and the new one is accepted; `rot3` proves capital/reserved/
  policies are untouched; `rot4` proves a malformed key and an unknown operator fail closed; `rot5`
  proves other operators are unaffected.
- **There is no "recover a lost owner key" function, by design.** The mitigation is custody, not
  recovery: hold the key, and keep an operator-key rotation path for the oracle (which does exist).

## 6. Residual risks (stated plainly)

- **Custody is the whole risk.** If the successor's key is again left in an ephemeral sandbox, the
  same loss recurs. Option A/B must end with the owner holding the key.
- **SEC-6/7/9 are not on the current default v3** (`contract.ovc-v3-ctl-2f6c4c.testnet`). A successor
  built from HEAD includes them; the current default does not. This is a liveness/termination gap on
  the default (reservations on a never-reported reading), not a theft path.
- **The reference is testnet and unaudited.** A successor is not production-ready for real funds.

## 7. The exact operation, for owner approval (nothing executed)

```bash
# Plan only — prints the operation, needs no key, sends nothing:
npm run verify:controlled-v3:plan

# Against an owner-controlled root (the owner supplies the funded root key):
OVERCOVER_USE_FAUCET=0 npm run verify:controlled-v3        # 40/40 on NEAR testnet
npm run verify:controlled-v3:evidence                      # re-read the deployed bytes from RPC
```

Approval requested for: **(a)** the architecture (single pool, operator quorum, resolver quorum,
permissionless factory, as in HEAD); **(b)** the authority model (owner account separate from the
contract; operator keys rotatable; the **owner** holds the durable key); **(c)** the testnet
operation above. **No mainnet, no legacy interaction, no automatic migration.**
