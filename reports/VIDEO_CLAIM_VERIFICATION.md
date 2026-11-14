# Claim-verification table — Overcover company film

Every factual claim made in the film's narration or on-screen cards, the evidence behind it, and
its verified status. Evidence was gathered on **2026-11-14** from the live system; nothing here is
taken from a previous report without re-checking.

Legend — **Verified (live)**: re-checked against the chain/repo today. **Verified (repo)**:
re-checked against the committed source/tests. **Qualified**: true but stated with an explicit
limitation in the narration. **Not used**: deliberately omitted because it could not be verified.

| # | Film claim | Supporting evidence | Verified status |
| --- | --- | --- | --- |
| 1 | "capital-backed risk mutual that runs on NEAR" | Contract `contract.ovc-v3-ctl-2f6c4c.testnet` on NEAR testnet; `get_pool` returns capital 1.4250 NEAR, reserved 0.2000 NEAR (live RPC `test.rpc.fastnear.com`). | Verified (live) |
| 2 | "Each product is an immutable, machine-readable risk — a city, an index, a trigger, a payout" | `docs/CONTRACT.md`; `add_product` in `contract/src`; console "Cover available now" renders live products (`get_products`). | Verified (repo + live) |
| 3 | "every policy is backed by reserved funds before it is sold" | `buy_cover` reserves payout; invariant `reserved ≤ capital` (`check_invariant_or_panic`); `docs/SECURITY.md` control row; live `get_pool` reserved 0.2. | Verified (repo + live) |
| 4 | "This is the live console, reading the contract directly" | `ui/index.html` calls `call_function` views over public RPC; frames captured from `https://overcover.vercel.app/` returning HTTP 200. | Verified (live) |
| 5 | "Overcover is built on NEAR" / "one Rust smart contract" | `contract/` is Rust `near-sdk` 5; deployed module 500023 bytes; code hash `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL` (live). | Verified (live) |
| 6 | "It holds the capital, issues policies, verifies signed observations, runs disputes, and settles" | `docs/CONTRACT.md` method list (`deposit`, `withdraw`, `buy_cover`, `report_observation`, `challenge`, `resolve_dispute`, `resolve`); 62 Rust unit tests (`npm run test:contract`). | Verified (repo) |
| 7 | "A product defines the risk … cover is bought, and the payout is reserved from the pool at that moment" | `docs/DEMO.md` + `demo-log.json` (18 real testnet txs: add_product → deposit → buy_cover → report → resolve → withdraw). | Verified (live, via `verify:proof`) |
| 8 | "An operator submits a signed index reading" | `driver/operator.js` ed25519-signs the canonical reading; contract verifies the signature. | Verified (repo) |
| 9 | "a quorum of operators must independently sign the same reading before it is accepted" | Live `get_config`: `quorum = 3` (of registered operators), `resolver_quorum = 3`. `docs/SECURITY.md`: "3-of-5 operator quorum". | Verified (live + repo) |
| 10 | "Anyone can challenge it with a bond" | `challenge` method; live `challenge_bond = 100000000000000000000000` (0.1 NEAR); `challenge_window_sec = 3600`. `demo-log.json` contains two real challenges. | Verified (live) |
| 11 | "An independent resolver settles the dispute" | `resolve_dispute`; live `resolver_quorum = 3`; owner "cannot resolve a dispute alone" (`docs/SECURITY.md`). | Verified (live + repo) |
| 12 | "settlement … a single comparison, run exactly once" | `resolve` settles once (`settled` guard); `docs/SECURITY.md` "settles policies exactly once"; tests in `contract/`. | Verified (repo) |
| 13 | "Readings are cryptographically signed" | ed25519 signature verified on-chain; `docs/ARCHITECTURE.md`. | Verified (repo) |
| 14 | "Disputes are bonded" / "a false claim forfeits it" | `challenge_bond` held; `demo-log.json` shows one reading **upheld** (bond forfeited) and one **rejected** (nullified). `verify:proof` check "a challenged reading was nullified on-chain". | Verified (live) |
| 15 | "after every state change, the contract enforces that reserved capital never exceeds the pool" | `check_invariant_or_panic`; `verify:proof`: `check_invariant() = true`, `reconcile() = true`, `reserved ≤ capital`. | Verified (live) |
| 16 | "An attestation prototype can prove that code ran inside a secure enclave — but execution integrity is not proof that an observation is true" | `poc/outlayer-attested-observation/` — Intel TDX attestation **prototype**, 34/34 local tests; **not deployed** (`docs/OPERATOR_ACTIONS_REQUIRED.md`). Stated explicitly as a prototype. | Qualified (prototype, labelled) |
| 17 | "External sources feed signed observations into the contract" | `driver/adapters.js` reads Open-Meteo; operators sign. | Verified (repo) |
| 18 | "A console, an autonomous agent, and a permissionless factory all read and write the same contract" | Console (`ui/`), agent (`agent/server.mjs`, limits engine), factory (`driver/discovery`), all targeting `contract.ovc-v3-ctl-2f6c4c.testnet`. | Verified (repo) |
| 19 | "Reproduce every figure yourself at overcover.vercel.app" | `npm run verify:proof` → 13/13 checks; console shows the copy-paste `curl`. | Verified (live) |
| 20 | On-screen: contract id, code hash, "NEAR testnet" | Live `view_account` code_hash `CQR8x1kWkr2zmCWsc5iZYpPPDTcBt5WdBvqAgw7HSvWL`; account is on testnet. | Verified (live) |
| 21 | "The customer journey … captured on the live console" (scene 05) | Captured read-only from `https://overcover.vercel.app/` with `video/company/capture-journey.mjs`; frames in `video/company/frames-journey/`; on-page text in `frames-journey/journey-text.json`. No wallet connected, no purchase made. | Verified (live) |
| 22 | "the contract quotes the price — five percent of the payout" (scene 05) | Live `list_products` (`heat-lagos`, premium 5.00 %) and the live quote panel (0.30 NEAR payout ⇒ 0.0150 NEAR premium). | Verified (live) |
| 23 | "policy three on the hardened contract is active on-chain, with reserved capital behind it" (scene 05) | v3 `list_policies` policy #3: `heat-lagos`, payout 0.10 NEAR, premium 0.0050 NEAR, status `active`; live `get_pool` reserved 0.20 NEAR. | Verified (live) |
| 24 | Card: `buy_cover` → policy #3, transaction `45A1s3hz…` | Tx `45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn`: signer `oc-agent-demo.ovc-v3-ctl-2f6c4c.testnet`, receiver the v3 contract, `SuccessValue` = policy id. | Verified (live) |
| 25 | Card flag: "Signed by the project's agent … a human-wallet purchase … is the one acceptance step still outstanding" | The signer is the project's agent account, not a browser wallet; the repo's own register lists the live human-wallet purchase as blocked (`reports/OVERCOVER-FINALIZATION-AND-HUMAN-TEST-READINESS.md` §4). | Verified (live + repo) |

## Deliberately NOT claimed (unverifiable or would be misleading)

| Claim | Why omitted |
| --- | --- |
| Any NEAR Foundation endorsement, funding, grant or partnership | No such agreement exists; would be fabricated. |
| Real capital under management, revenue, number of policies sold, users, insurers or partners | No production deployment; all activity is testnet. |
| "Audited" or "certified" | The contract has **not** been professionally audited (`docs/SECURITY.md`). |
| That the TEE/attestation layer is live in the product | It is a tested POC, not deployed. |
| That every deployed contract has all hardened protections | The **deployed** v3 module predates the SEC-6/SEC-7 reservation-release fix (`verify:proof` NOTE); legacy v1 uses a single attestor. |
| That all historical contracts were upgraded | Legacy v1 (`contract.attestor-overcover.testnet`) is unchanged and remains single-attestor. |
| Human wallet purchase against hardened v3 | **No such transaction exists on v3 or v1.** Every recorded `buy_cover` signer is a scripted/agent account; the only "human" purchase (legacy v1 `87n1pdeA…`) was signed programmatically on legacy v1. Scene 05 shows the live journey and the real on-chain purchase, and labels the purchase as agent-signed. Evidence: `reports/VIDEO_CUSTOMER_JOURNEY_EVIDENCE.md`. |
| That one purchase (of any kind) proves adoption, product-market fit, or production readiness | A single testnet purchase is a functional check, not traction. |
| Specific payout/premium figures as "production" numbers | They are testnet values; the film shows the console's live testnet reads and says so. |

## Honesty notes carried into the film

- The narration says "on testnet, unaudited, and built to be verified" in the closing scene.
- The NEAR card states the network is **testnet** and shows the real code hash.
- The security scene states the TEE distinction explicitly (execution integrity ≠ truth of an observation).
- Scene 05 shows the live purchase journey and the **real** on-chain purchase, and the card states
  plainly that the purchase was **signed by the project's agent**, naming the human-wallet signature
  as the outstanding acceptance step. The film never implies a human bought cover.
- The film shows the console's **live** reads; where a wallet approval surface appears it is labelled
  as the approval surface, not a completed signature.

## Independent verification commands (reproducible)

```bash
cd /workspace/project/overcover
npm run verify:proof                 # 13/13 — deployed code, solvency, all 18 demo txs, agent buys
curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"get_pool","args_base64":"e30="}}'
```
