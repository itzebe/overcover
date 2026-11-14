# Mission report — final security deployment, OutLayer integration, funding

Date: 2026-11-13 · Branch: `feat/outlayer-attested-observation-poc`
Base: `main` @ `ad1d59e82f9d7c1c06eacba8b9f017e70cf1894f`

This report states what was **verified**, what was **built**, and what remains
**blocked on external authority**. Nothing here is claimed that was not run.

## 1. Baseline (verified)

| Check | Result |
| --- | --- |
| `main` HEAD | `ad1d59e82f9d7c1c06eacba8b9f017e70cf1894f` (matches the expected release head) |
| Release PR #40 | merged (head `f1dd49ad2995`) |
| PR #39 | open, draft, **untouched** (head `8c373a6b2b17`) |
| Tag `v1.0.0` | `bb8f3233e85c015eb62101722a367e35e26d9fd2` |
| Working tree | clean |

## 2. WASM rebuild (verified)

Rebuilt `overcover.wasm` from merged `main`:

- `sha256 811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f`
- 500342 bytes, rustc/cargo 1.99.1
- SEC-9 guard string present: `observation date too far in the future`

The artifact the deployment would ship is byte-identical to the reviewed build.

## 3. Deployment — **blocked on external authority**

The hardened v3 module is ready to ship, and the operator path is verified end to
end **except for the signing step**, which needs a key this environment does not
hold.

`node driver/redeploy-v3.mjs --plan` (no key, sends nothing) reports:

```
target account : contract.ovc-v3-ctl-2f6c4c.testnet (testnet)
current code   : code_hash CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL
                 sha256    a97034e65fb0c53fe0a6e27e8541e2d8f3ea0ff54ddd037fab1c4e23fb0e37c1
new code       : sha256    811e0427...  (500342 bytes)
operation      : DeployContract(<wasm>) — code only, no new()/migrate()
rollback       : re-run with the previous module (sha256 a97034e6...); code-only
```

Running it without a key fails closed:

```
error: no signing key: set OVC_V3_SECRET_KEY or create keys/v3-operator.json
```

**Operator command (requires the v3 account key):**

```bash
OVC_EXPECTED_SHA=811e0427ec467582913a47400ecf1b7c272ddea20ff5074f04a4513d896c0a7f \
OVC_V3_KEY_FILE=keys/v3-operator.json \
node driver/redeploy-v3.mjs
```

The script refuses unless the wasm sha256 matches `OVC_EXPECTED_SHA` and contains
the SEC-9 guard, then verifies the post-deploy code hash equals the built wasm.
No key material is present, printed, or committed. **This is the one item blocked
on external authority.**

## 4. OutLayer attested-observation POC (built and verified)

The security gap this closes: an operator signature proves *who* asserted a
reading, not *how* it was produced. The POC binds a reading to a pinned WASM build
executed in an **Intel TDX** worker, and verifies the resulting attestation.

Committed as `8dee212`. Full detail in
`poc/outlayer-attested-observation/README.md`.

**Real components exercised:** the pinned adapter WASM runs in a WASI-P2 runtime
and fetches a real source (Open-Meteo); a real Intel TDX quote verifies with the
official `dcap-qvl` verifier; operators sign the production `readingMessageV3`;
approved measurements are read live from `worker.outlayer.testnet` (129 sets).

**Test result — `npm run poc:outlayer:test`: 34 pass / 0 fail** (17 synthetic + 17
serialization/real-evidence). Attacks that are refused, each by a real check:

- tampered WASM hash, tampered input hash, tampered output hash → `report_data` binding fails;
- a wrong caller identity → `report_data` binding fails;
- a non-TDX quote → rejected;
- measurements not in the approved set → rejected;
- a **spliced `report_data`** → fails real Intel verification (the hardware signature cannot be forged);
- a **replayed quote** → it binds one `task_id`; another `task_id` fails the hash check;
- stale / expired / future-dated / out-of-bounds reading → refused before signing;
- altered source payload → evidence hash changes, signature no longer matches;
- replayed reading for the same operator+metric+city+date → duplicate.

**A3 finding (fixed).** The POC's task hash wrote every integer as *unsigned*. The
canonical OutLayer hash uses **signed i64 LE** for `task_id` and `timestamp`,
**unsigned u64 LE** for `block_height`, folds hashes in as **lowercase hex
strings**, and skips absent optional fields. Fixed and locked by vectors from an
**independent Python implementation** (`poc/outlayer-attested-observation/test/vectors/task-hash.json`).

**A real OutLayer-hosted execution was run.** On testnet (free trial; anonymous
wallet via `/register`, no credentials, no funds), `connector-probe`/`whoami`
executed in OutLayer's Intel TDX worker. The canonical task hash recomputed from
the record equals the quote's `report_data`; the quote's measurements are in the
**live on-chain approved set** (verified against `worker.outlayer.testnet`); and
`dcap-qvl` verifies the Intel signature (TCB `UpToDate`). Evidence is committed
under `fixtures/outlayer-real/` and re-checkable offline via
`bin/verify-attestation.mjs`.

**Honest scope:** the recorded execution is `connector-probe`, not the Overcover
adapter. Running the *adapter* on OutLayer needs `outlayer deploy` (a NEAR
FullAccess signature the operator has not authorised, and a funded wallet). The
attestation mechanism is now proven against real hardware; the remaining gap is a
deployment action, not an unverified path. Stated in the POC README, not hidden.

## 5. Ecosystem funding — research + drafted application

`docs/FUNDING.md` records the verified programs and a complete application draft.

- **NEAR Agentic Accelerator** — application form captured in full.
- **NEAR Protocol Rewards** — up to $10k/month, merit-based; scoring criteria captured.
- `neartreasury.com` is no longer maintained (redirects to Trezu); `dev.near.org` is DNS-dead.

The draft fills every technical field from real repository and deployment facts.
Personal-identity fields, the privacy-policy consent, and submission require the
founder's authority and are marked `[human]`. **Nothing was submitted.**

## 6. Test matrix on merged main (all green)

| Suite | Result |
| --- | --- |
| `test:model` | 74/74 scenarios defended, 0 exploitable |
| `test:contract` | 83 passed |
| `test:console` | 108 passed |
| `test:agent` | 53 passed |
| `test:factory` | 11 passed |
| `test:deploy` | 21 passed |
| `test:sim` | 79 passed |
| `test:agent-eval` | 33 passed |
| `verify:proof` | 13/13 checks passed |
| `verify:connectivity` | 13/13 checks passed |
| `verify:factory` | 22/22 checks passed (sandbox) |
| `axe` | 0 violations at 320/360/390/768/1024/1280/1440 px |
| `poc:outlayer:test` | 34 passed (17 synthetic + 17 serialization/real-evidence) |

Gated suites need a funded root or a local `neard`, so they were not run in
this environment. **They ran in CI** (which provisions `neard`) and passed on the
final commit:

| CI step | Result |
| --- | --- |
| Contract unit tests | success |
| Reference model attacks | success |
| Console regression tests | success |
| Agent limits, API and u128-precision | success |
| Product feed + agent-evaluation | success |
| Discovery agent | success |
| Deploy fail-closed regression | success |
| Build the contract to wasm | success |
| Independent proof (deployed bytecode == source, pool solvent, on-chain evidence) | success |
| SEC-1 migrate() authorization proof | success |
| Contract end-to-end on a local NEAR node | success |
| SEC-1 migrate() guard on the compiled wasm | success |
| In-place upgrade preserves state | success |
| Controlled v3 deploy + SEC-1 closure on the deployed module | success |
| Permissionless factory end-to-end on a local NEAR node | success |
| Agent spend-authorization vs the live contract | success |
| Fail if a secret is tracked | success |

CI run: `https://github.com/itzebe/overcover/actions/runs/43390713217`
(head `cd8d4720`) — conclusion **success**.

Note: the first CI run on this branch (`a07a6c2`) **failed** at the "Fail if a
secret is tracked" step, because the POC report embedded operator public keys in
the `ed25519:<base58>` form that the scanner greps for. Fixed by storing public
keys as raw hex (commit `cd8d472`); the scanner cannot tell a public key from a
secret one, and a public key must not look like committed key material.

## 7. Remaining risks and limitations

- **Deployment unexecuted.** The hardened module is not on chain; the current
  code hash is still `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL`. The rebuilt
  artifact matches the expected `811e0427…` (500342 B) and carries the SEC-9 guard;
  the live module (`a97034e6…`, 500023 B) does not. Needs the v3 key (operator action).
- **The Overcover adapter is not deployed on OutLayer.** A real OutLayer-hosted
  execution (`connector-probe`) was run and its quote verifies, proving the
  attestation path against real hardware; deploying the adapter itself needs
  `outlayer deploy` (a NEAR FullAccess signature and a funded wallet).
- **Funding not submitted.** Drafted only; the cohort year in the draft needs
  human confirmation.
- **No independent third-party audit.** This is internal verification; it is not
  an audit and must not be described as one.
- The legacy v1 contract remains readable but is not a purchase destination;
  this was not changed.

## 8. References

- Branch: `feat/outlayer-attested-observation-poc` (PR #41)
- POC: `poc/outlayer-attested-observation/` (README + `evidence/poc-report.json`)
- Real evidence: `poc/outlayer-attested-observation/fixtures/outlayer-real/`
- Funding: `docs/FUNDING.md`
- Deploy: `driver/redeploy-v3.mjs` (`--plan` sends nothing)
