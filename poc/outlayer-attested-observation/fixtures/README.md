# Fixtures

- `approved-measurements.json` — the TDX measurements approved on
  `worker.outlayer.testnet`, read live via `get_approved_measurements`
  (captured 2026-11-13). A worker's quote must match one of these five-tuples.
- `tdx_quote_template.bin` — a real Intel TDX quote (from Phala's `dcap-qvl`
  test sample). Used as a **template** so the SIMULATED-attestation path can
  exercise the report_data binding with genuine quote bytes; the Intel
  signature covers the template's original report_data, so a spliced quote
  fails `dcap-qvl` verification by design.
