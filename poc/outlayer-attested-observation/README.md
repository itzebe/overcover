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
| `lib/attestation.mjs` | TDX quote parsing, `report_data` binding, and Intel verification via `dcap-qvl`. |
| `bin/integration-demo.mjs` | Runs the whole chain and writes `evidence/poc-report.json`. |
| `test/adversarial.test.mjs` | 17 adversarial tests. |
| `fixtures/` | Real inputs: approved measurements from `worker.outlayer.testnet`, a real Intel TDX quote. |

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

# 4. Adversarial tests (the Intel tests need dcap-qvl on PATH)
export DCAP_QVL_BIN=dcap-qvl
node --test test/adversarial.test.mjs
```

## What is real vs simulated

The integration report labels every step. Honest statuses:

| Step | Status | Basis |
| --- | --- | --- |
| Adapter execution | **LIVE** | The pinned WASM runs in a WASI-P2 runtime and fetches a real source. |
| Observation normalisation | **VERIFIED** | Deterministic transform, asserted by tests. |
| Attestation (binding) | **VERIFIED** | `report_data` = SHA-256 of the task fields; recomputed and compared. |
| Attestation (Intel signature/TCB) | **VERIFIED** | Real quote verified by `dcap-qvl` against Intel collateral (PCCS). |
| OutLayer-hosted execution | **SIMULATED** | The TDX worker run itself needs an OutLayer account/approval; not executed here. |
| Operator quorum | **VERIFIED** | Real ed25519 signatures over the production `readingMessageV3`. |

The **SIMULATED** row is the one honest gap: this POC does not (and cannot, without
an OutLayer account) run the adapter on OutLayer's hardware. Everything downstream
of the attestation is exercised with real primitives, and the attestation
verification is proven against a real Intel quote.

## Security properties demonstrated (by test)

- A tampered **WASM hash** fails `report_data` binding.
- A tampered **input** or **output hash** fails binding.
- A **non-TDX** quote is rejected.
- A quote whose **measurements** are not in OutLayer's approved set is rejected.
- A **spliced** `report_data` (forged binding) fails real Intel verification —
  the hardware signature cannot be forged, so a genuine execution is required.
- A **stale**, **expired**, **future-dated**, or **out-of-bounds** reading is
  refused before signing (mirrors the contract's own guards).
- An **altered source payload** changes the evidence hash, so the signed reading
  no longer matches the bytes.
- A **replayed** reading for the same operator+metric+city+date is a duplicate.

## Limitations (honest)

- **OutLayer-hosted execution is not run here.** The TDX worker step is simulated;
  the real execution is the outstanding integration step. The verification path is
  nevertheless proven against a real Intel quote.
- **`report_data` serialisation.** The field order and integer encoding follow
  OutLayer's `WORKER_ATTESTATION.md`; a live run is required to confirm the exact
  serialisation byte-for-byte. `lib/attestation.mjs` isolates this in `taskHash()`.
- **Source truthfulness is out of scope.** Attestation binds execution, not the
  truth of the source. Operators and disputes still decide.
- **`dcap-qvl` TCB status.** The sample platform reports `OutOfDate` for the TCB
  level; a production policy must decide which TCB statuses are acceptable.

## References

- OutLayer: <https://outlayer.ai> — worker attestation model, `worker.outlayer.testnet`.
- Intel DCAP verification: Phala `dcap-qvl` (`dcap-qvl-cli` 0.3.11).
- Overcover reading message (v3): `driver/attestor.js` `readingMessageV3`.
