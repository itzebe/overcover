# Overcover × OutLayer — attested external observations (POC)

Overcover settles cover from **signed external observations**. Today the signature
proves *who* asserted a reading; it does not prove *how* the reading was produced.
This POC closes that gap: the reading is fetched and normalized by a pinned WASM
adapter running inside an **Intel TDX** worker, and the worker's **per-execution
attestation** binds the exact adapter binary, the input, and the output.

Result: an operator can sign a reading that is bound, end to end, to a specific
build and a specific execution — not merely to a claim.

## The chain

```
external source (Open-Meteo)
        │  HTTPS
        ▼
adapter WASM (pinned, sha256)      ── runs in OutLayer's Intel TDX worker ──► TDX quote
        │  normalized observation                                              (report_data binds
        ▼                                                                       wasm/input/output)
attestation verification (this repo)
        │  dcap-qvl: Intel signature + TCB   +   report_data binding
        ▼
Overcover observation  ──►  operator ed25519 signatures (readingMessageV3)
        │
        ▼
quorum (≥ threshold) ──► report_reading ──► dispute window ──► settlement
```

The attestation proves **execution integrity**. It does **not** prove the external
source is truthful, and it does not remove the need for operator quorum or
disputes. It adds a hardware-rooted, third-party-verifiable link between the
signed reading and the exact code that produced it.

## Layout

| Path | What it is |
| --- | --- |
| `adapter/` | Rust WASI-P2 guest: fetch → preserve → normalize. Builds to a wasm component. |
| `lib/observation.mjs` | Normalisation into Overcover's schema + preflight mirroring the contract's `report_reading` guards. |
| `lib/attestation.mjs` | TDX quote parsing, the canonical OutLayer **task hash**, and Intel verification via `dcap-qvl`. |
| `lib/outlayer.mjs` | OutLayer HTTPS API client (register, trial key, call, fetch attestation). |
| `bin/integration-demo.mjs` | Runs the whole chain and writes `evidence/poc-report.json`. |
| `bin/execute-on-outlayer.mjs` | Runs a real execution on OutLayer and captures its attestation. |
| `bin/verify-attestation.mjs` | Offline verifier for a captured attestation + quote. |
| `test/adversarial.test.mjs` | 17 adversarial tests (synthetic + template quote). |
| `test/outlayer-real.test.mjs` | 17 serialization + real-evidence tests (vectors + a real OutLayer quote). |
| `test/vectors/task-hash.json` | Canonical task-hash vectors from an independent Python implementation. |
| `fixtures/outlayer-real/` | A **real** OutLayer-hosted Intel TDX execution: record + `quote.bin`. |
| `fixtures/` | Approved measurements (verified against `worker.outlayer.testnet` on chain). |

## Reproduce

```bash
# 1. Build the adapter (WASI Preview 2 component)
cd adapter
cargo build --target wasm32-wasip2 --release

# 2. Install the official Intel DCAP verifier (the crate OutLayer's register
#    contract uses) and the WASI-P2 runtime
cargo install dcap-qvl-cli --version 0.3.11 --locked
# wasmtime >= 27 (https://wasmtime.dev)

# 3. Run the end-to-end chain (fetches a real source; writes the report)
cd ..
node bin/integration-demo.mjs

# 4. Tests (the Intel tests need dcap-qvl on PATH)
export DCAP_QVL_BIN=dcap-qvl
node --test "test/*.test.mjs"

# 5. Verify the recorded real OutLayer execution offline
node bin/verify-attestation.mjs fixtures/outlayer-real/attestation.json \
     fixtures/outlayer-real/quote.bin

# 6. Run a fresh real execution (free testnet; registers an anonymous wallet)
node bin/execute-on-outlayer.mjs --register
```

## What is real vs simulated

The integration report labels every step. Honest statuses:

| Step | Status | Basis |
| --- | --- | --- |
| Adapter execution | **LIVE** | The pinned WASM runs in a WASI-P2 runtime and fetches a real source. |
| Observation normalisation | **VERIFIED** | Deterministic transform, asserted by tests. |
| OutLayer-hosted execution | **VERIFIED** | A real OutLayer-hosted Intel TDX execution was run and captured (`fixtures/outlayer-real/`). |
| Attestation (binding) | **VERIFIED** | The canonical task hash recomputed from the record equals the quote's `report_data[0..32]`. |
| Attestation (Intel signature/TCB) | **VERIFIED** | The real quote verifies via `dcap-qvl` against Intel collateral; `status: UpToDate`. |
| Operator quorum | **VERIFIED** | Real ed25519 signatures over the production `readingMessageV3`. |

**The recorded execution is `connector-probe` (`whoami`), not the Overcover
adapter.** Running the *Overcover adapter* on OutLayer requires the project to be
deployed on chain (`outlayer deploy`), which needs a NEAR FullAccess signature the
operator has not authorised. The attestation path — the part that was previously
simulated — is now proven against a **real** OutLayer quote, so the remaining gap
is a deployment action, not an unverified mechanism.

### The captured execution

| Field | Value |
| --- | --- |
| `call_id` | `d79b387e-c986-4551-aea5-f92a24bed0df` |
| `task_id` | 89277 |
| project | `connectors.outlayer.testnet/connector-probe` |
| worker measurement | `d85416a5…6f99b6` (on-chain approved) |
| `report_data[0..32]` | `78a2832f7d2b476f8d7f1ed3929cd0ec4fa60335e50cd762a09b023ed46c612d` |
| Intel TCB status | `UpToDate` |

## Security properties demonstrated (by test)

- A tampered **WASM hash** fails `report_data` binding.
- A tampered **input** or **output hash** fails binding.
- A **non-TDX** quote is rejected.
- A quote whose **measurements** are not in OutLayer's approved set is rejected.
- A **spliced** `report_data` (forged binding) fails real Intel verification —
  the hardware signature cannot be forged, so a genuine execution is required.
- A **replayed** quote is refused: it binds one `task_id`, so another `task_id`
  fails the task-hash check.
- A **stale**, **expired**, **future-dated**, or **out-of-bounds** reading is
  refused before signing (mirrors the contract's own guards).
- An **altered source payload** changes the evidence hash, so the signed reading
  no longer matches the bytes.
- A **valid attestation over false source data** still yields a false reading:
  the attestation binds execution, not truth. Operator quorum and disputes
  remain the gate for truthfulness (see Limitations).

## Serialization (the A3 finding, resolved)

The previous POC wrote every integer as unsigned. The canonical OutLayer task
hash (`worker/src/tdx_attestation.rs`, `WORKER_ATTESTATION.md`) is:

```
SHA-256( task_type ‖ task_id:i64LE ‖ repo? ‖ commit? ‖ build_target? ‖ wasm_hash?
       ‖ input_hash? ‖ output_hash ‖ block_height:u64LE? ‖ caller_account_id?
       ‖ project_id? ‖ secrets_ref? ‖ timestamp:i64LE ‖ attached_usd? )
```

with hashes folded in as **lowercase hex strings**, absent optional fields
skipped, `task_id`/`timestamp` **signed** i64 LE, and `block_height` unsigned u64
LE. `lib/attestation.mjs#taskHash` now matches this exactly, is locked by
independent Python vectors, and is confirmed against the real quote above. The
`report_data` field sits at offset **568** in the quote, 64 bytes, tail zeroed.

## Limitations (honest)

- **The Overcover adapter is not yet deployed on OutLayer.** A real OutLayer-hosted
  Intel TDX execution was run and captured (`connector-probe`), which proves the
  attestation path end to end, but the *adapter* project itself needs
  `outlayer deploy` — a NEAR FullAccess signature the operator has not authorised.
- **`report_data` serialisation.** Now confirmed byte-for-byte against a real
  OutLayer quote (see above); the earlier uncertainty is resolved.
- **Source truthfulness is out of scope.** Attestation binds execution, not the
  truth of the source. Operators and disputes still decide.
- **`dcap-qvl` TCB status.** The captured platform reports `UpToDate`; a
  production policy must still decide which TCB statuses are acceptable.
- **Free-testnet only.** All OutLayer work here is on testnet with the free
  trial / open-mint USDC. No mainnet, no paid service, no funds.

## References

- OutLayer: <https://outlayer.ai> — worker attestation model, `worker.outlayer.testnet`.
- Intel DCAP verification: Phala `dcap-qvl` (`dcap-qvl-cli` 0.3.11).
- Overcover reading message (v3): `driver/attestor.js` `readingMessageV3`.
