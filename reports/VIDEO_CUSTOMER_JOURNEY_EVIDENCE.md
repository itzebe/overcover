# Human-verified customer journey — evidence report

**Scope.** This report establishes, from authoritative sources, exactly what is and is not proven
about the Overcover cover-purchase journey, and what the company film may therefore claim. It was
produced read-only: **no purchase was made, no wallet was connected, no funds were spent, and no
contract state was changed.**

**As of:** 2026-11-14 · NEAR testnet block height 277,698,223.

---

## 0. Headline finding (read this first)

**There is no human-wallet purchase — on v3 or on legacy v1.** Every recorded `buy_cover` on both
contracts was **signed programmatically by a scripted account**, not approved in a browser wallet by
a person.

This is not a new discovery by this report; it is what the repository already states, and this report
re-verifies it directly from the chain:

- The only purchase ever described as "human" is tx `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`,
  and it was **signed programmatically** (its signer is a sub-account of the project's agent). It
  also ran on **legacy v1**.
- The repository's own finalization report lists **"Live human wallet purchase on v3 — needs a
  person + funded testnet wallet (the outstanding acceptance test)"** as **blocked**:
  `reports/OVERCOVER-FINALIZATION-AND-HUMAN-TEST-READINESS.md` §4, and `docs/HUMAN_ACCEPTANCE_TEST.md`.

Therefore the mission brief's premise — that a real human has already completed the purchase journey
and received an active policy — **does not hold against the available evidence.** This report records
the truth and the film is updated to match it: the journey is shown as **exercised end-to-end on-chain
by the project's own agent**, with the **human-wallet signature explicitly named as the one step still
outstanding.**

---

## 1. Method and reproduction

All reads are public and read-only. Exact commands are in §7. Sources, in order of authority:

1. The live contract, read directly over NEAR RPC (`list_products`, `list_policies`, `get_pool`,
   `get_policy`, `view_account`).
2. The transaction objects themselves, re-fetched by hash from an archival RPC and a public indexer.
3. The console's rendered page text, captured live (not OCR).
4. The repository's own evidence documents, re-read.

---

## 2. What was purchased, and did it succeed?

### 2a. The hardened v3 contract — `contract.ovc-v3-ctl-2f6c4c.testnet` (the default purchase destination)

Live catalogue (`list_products`): two products, both **active**.

| Product | Metric | Trigger | Premium | Payout bounds | Capacity |
| --- | --- | --- | --- | --- | --- |
| `heat-lagos` | Lagos temperature | 40.0 °C or more | 5.00 % | 0.10–0.30 NEAR | 0.40 NEAR |
| `heat-lagos-factory` | Lagos temperature | 40.0 °C or more | 5.00 % | 0.10 NEAR | 0.50 NEAR |

Live policies (`list_policies`): **3 policies**, all created by **scripted signers**.

| Policy | Product | Payout | Premium | Buyer (signer) | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `heat-lagos` | 0.30 NEAR | 0.0150 NEAR | `buyer.ovc-v3-ctl-2f6c4c.testnet` | `settled_paid` |
| 2 | `heat-lagos-factory` | 0.10 NEAR | 0.0050 NEAR | `buyer.ovc-v3-ctl-2f6c4c.testnet` | `active` |
| 3 | `heat-lagos` | 0.10 NEAR | 0.0050 NEAR | `oc-agent-demo.ovc-v3-ctl-2f6c4c.testnet` | `active` |

**Every `buy_cover` on v3** (full history, 3 transactions) and its signer:

| Tx hash | Signer | Receiver | Result |
| --- | --- | --- | --- |
| `45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn` | `oc-agent-demo.ovc-v3-ctl-2f6c4c.testnet` | v3 contract | policy 3, **Success** |
| `3SDiX9BY3KH4UZwMNGVavitnGSeqroarn4fkwd7SkVC1` | `buyer.ovc-v3-ctl-2f6c4c.testnet` | v3 contract | policy 2, Success |
| `2GGqY5FbDCekndXje2PY3kcw2fUmL2vL1Ab1VyRKnuzV` | `buyer.ovc-v3-ctl-2f6c4c.testnet` | v3 contract | policy 1, Success |

The **agent purchase** `45A1s3hz…` is a real, finalised `buy_cover`: deposit 0.005 NEAR, receiver the
v3 contract, `SuccessValue` = policy id, and policy 3 reads back as `active` with reserved capital.
It is the cleanest on-chain proof that the **purchase path works on the hardened contract** — and it
was **signed by the project's agent, not a human wallet.**

### 2b. The legacy v1 contract — `contract.attestor-overcover.testnet` (not a purchase destination)

15 policies, code hash `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` (the original v1 module). The
"human" purchase is **policy 15**, tx `87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`: `rain-lagos`,
1 NEAR payout, 0.05 NEAR premium, status `active`, **re-confirmed live**. Its signer is
`human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet` — **a sub-account of the project's agent account
`oc-agent-mwb87z4k.testnet`** — i.e. signed programmatically, exactly as `docs/JUDGE_DEMO.md` and
`docs/FINAL_RELEASE_READINESS.md` already record. The console labels this contract **"Legacy build"**
and **disables buying there**.

---

## 3. The customer journey, captured live

The journey below was captured from the **live production console** (`https://overcover.vercel.app/`)
on 2026-11-14 with `video/company/capture-journey.mjs` (read-only; no wallet connected). Every figure
on screen is read from the contract by the page itself. The on-page text of each step was also
extracted (`video/company/frames-journey/journey-text.json`).

| Step | What the live application showed |
| --- | --- |
| **Discover** | "Cover available now… Each card is an immutable risk definition read from the contract." |
| **Select** | Product `heat-lagos` chosen: Lagos temperature, trigger **40.0 °C**, premium **5.00 %**, max payout **0.30 NEAR**, capacity **0.40 NEAR** (0.30 left). |
| **Terms & price** | Quote panel, read from the contract: premium **0.0150 NEAR**, payout reserved **0.30 NEAR**, premium rate **5.00 %**, capacity remaining after this policy **0.00 NEAR**. |
| **Purchase surface** | "Buy this cover with your own wallet… the premium is fixed by the contract — not by this page." Destination stated: `contract.ovc-v3-ctl-2f6c4c.testnet · NEAR testnet · verified hardened module`. |
| **Wallet approval** | The genuine wallet picker the page opens ("A NEAR wallet holds your account and signs transactions. Overcover never sees your key."). |
| **Policy register** | Live policies with the contract's own status: #1 `settled paid`, #2 and #3 `awaiting resolve()`. The page states: "Status is the contract's own field." |
| **Legacy disclosure** | On `?contract=contract.attestor-overcover.testnet` the console shows the legacy banner and disables buying. |

These are **genuine application screens and genuine application responses**. No state was fabricated
and none was staged.

---

## 4. Independent verification — what is proven, and by what

| Claim | Status | Evidence |
| --- | --- | --- |
| The purchase journey is discoverable and operable on the live console | **Verified** | Live capture, §3 |
| The contract prices cover (premium 5 %; 0.30 payout ⇒ 0.0150 NEAR) | **Verified** | Live `list_products` + live quote panel, §2a/§3 |
| A `buy_cover` call completes on the hardened v3 contract | **Verified** | tx `45A1s3hz…`, `SuccessValue` = policy id, policy 3 `active` |
| The resulting policy exists with real reserved capital | **Verified** | `list_policies` policy 3; `get_pool` reserved 0.20 NEAR |
| The pool is solvent and the invariant holds | **Verified** | `get_pool`: capital 1.425, reserved 0.20, available 1.225, `solvent: true`, `paused: false` |
| **A human approved a purchase in their own browser wallet** | **NOT verified — outstanding** | No such transaction exists on v3 or v1; every `buy_cover` signer is a scripted account |
| The v1 "human" purchase was a wallet-extension approval | **NOT verified — and contradicted** | Signer is an agent sub-account; signed programmatically |

---

## 5. Steps completed by whom

- **The project's agent / scripts:** every on-chain purchase on both contracts, including the
  hardened-v3 policy 3 (`oc-agent-demo…`). These are real, verifiable transactions.
- **A human:** nothing on-chain. The human element present in this mission is the **console journey**
  (the customer-facing flow exists and is operable), which this report captured read-only.

---

## 6. What the film may therefore say (and must not)

**May say:** the customer journey exists, is live, and is exercised end-to-end on-chain; the purchase
path on the hardened v3 contract is real; the policy and reserved capital are real; the human-wallet
signature is the one step still outstanding.

**Must not say:** that a human has bought cover; that a human-wallet purchase has been verified; that
one purchase (of any kind) proves adoption, licensing, partnerships, or production readiness. The film
carries these boundaries explicitly.

---

## 7. Reproduction

```bash
# v3 catalogue, policies, pool (read-only)
curl -s -X POST https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"list_policies","args_base64":"e30="}}'

# the v3 agent purchase, re-fetched by hash
curl -s -X POST https://archival-rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn","sender_account_id":"oc-agent-demo.ovc-v3-ctl-2f6c4c.testnet","wait_until":"FINAL"}}'

# the legacy v1 "human" purchase and its signer
curl -s -X POST https://archival-rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i","sender_account_id":"human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet","wait_until":"FINAL"}}'

# re-capture the live customer journey (read-only, no wallet)
cd video/company && node capture-journey.mjs
```

---

## 8. Remaining limitation (external authority)

The human-wallet purchase on hardened v3 remains the outstanding acceptance test. It requires a person
with a **funded NEAR testnet wallet** and a browser wallet extension — a step that cannot be produced
from an agent environment. The exact procedure is `docs/HUMAN_ACCEPTANCE_TEST.md`. When it is done, the
new transaction hash and policy id should be added here and to the film's claim table.
