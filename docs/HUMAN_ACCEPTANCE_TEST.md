# Human acceptance test — a live wallet purchase on hardened v3

**This is the one acceptance activity that cannot be completed from an agent environment.** Every
other check in this repository runs green without a human; this one needs a person with a funded
NEAR **testnet** wallet and a browser, because a real wallet extension approval cannot be produced by
a headless process. This document is the exact, self-contained procedure. It takes about three
minutes.

**What it proves.** That a human, using the deployed production console and their own wallet, can
buy cover on the hardened v3 contract `contract.ovc-v3-ctl-2f6c4c.testnet`, that the console signs
exactly one `buy_cover`, and that the resulting policy and reserved capital are real on-chain state.

**What it does not prove, and must not be read as proving.** Nothing here exercises the legacy v1
address `contract.attestor-overcover.testnet`. A recorded human purchase exists on v1 (PR #39) and is
**not** evidence of a v3 human purchase. Do not present the v1 recording as this test.

---

## 0. Prerequisites

- A NEAR **testnet** account with a small balance (a few NEAR is ample; one purchase costs ~0.005 NEAR
  premium plus gas). Create one at https://testnet.mynearwallet.com/ or https://wallet.herewallet.app/.
- A browser wallet extension (HERE or Meteor) holding that account, set to **testnet**.
- No private key or seed phrase is ever pasted into chat, a file, or the repository. The wallet
  extension holds the key; the console never sees it.

## 1. Open the deployed console

Open **https://overcover.vercel.app/**.

Confirm, without connecting anything:

- The page loads with no error and reads live state (a capital figure and the contract address are
  visible).
- The default contract shown is `contract.ovc-v3-ctl-2f6c4c.testnet`.
- The products list shows `heat-lagos` and `heat-lagos-factory` (both temperature, trigger 40.0 °C).

## 2. Connect the wallet

1. Click **Connect a wallet**.
2. Choose HERE or Meteor and approve the connection in the extension.
3. Confirm the console shows the connected account and does **not** report a network mismatch. If it
   says the wallet is not on testnet, switch the extension to testnet and reconnect — buying stays
   disabled until it matches.

## 3. Buy cover

1. In the buy panel choose product **`heat-lagos`** and payout **0.1 NEAR**.
2. The console re-reads the premium from the contract. The expected premium for this exact selection
   is **0.005 NEAR** (the product's `premium_bp` is 500 = 5 % of payout). If a different figure
   appears, stop and record it — it means the live product changed and this document is stale.
3. Click **Buy this cover with your own wallet**.
4. The extension opens **exactly one** `buy_cover` approval. Confirm the receiver is
   `contract.ovc-v3-ctl-2f6c4c.testnet` and the attached deposit equals the quoted premium
   (0.005 NEAR).
5. Approve.

**Expected on success:** the console shows **"Transaction confirmed"** with a real transaction hash
and a link to `testnet.nearblocks.io`. A new row appears under **Policies written** whose buyer is
your account and whose status is `active`.

**Expected on rejection (also a pass):** if you decline in the extension, the console says **"No
cover was bought"** and nothing is charged. A purchase is only ever claimed from the wallet's own
confirmed hash; a rejection is never rendered as success.

**Expected on a wallet that never answers:** the console keeps buying **blocked** with an explanatory
hint until the wallet responds, so a retry cannot issue a second signed `buy_cover` for the same
intent. If you wait past the deadline (~120 s) and the extension then answers, the console reconciles
honestly — a confirmed hash is shown with its link, anything else as no cover.

## 4. Verify the result on-chain (read-only)

Substitute your `<tx_hash>` and `<your_account>`:

```bash
# The transaction must exist, be Final, and succeed.
curl -s -X POST https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"<tx_hash>","sender_account_id":"<your_account>","wait_until":"FINAL"}}' \
  | python3 -c "import json,sys;r=json.load(sys.stdin)['result'];print('outcome:', r['status'].get('SuccessValue') is not None, '| block:', r['transaction_outcome']['block_hash'][:12])"

# The policy count must have increased and the new policy must name you as buyer.
curl -s -X POST https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"list_policies","args_base64":""}}' \
  | python3 -c "import json,sys;[print(p['id'],p['buyer'],p['product_id'],p['status']) for p in json.loads(bytes(json.load(sys.stdin)['result']['result']))]"

# Reserved capital must have risen by the new policy's payout (reserved <= capital must still hold).
curl -s -X POST https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"get_pool","args_base64":""}}' \
  | python3 -c "import json,sys;d=json.loads(bytes(json.load(sys.stdin)['result']['result']));print('capital',int(d['capital'])/1e24,'reserved',int(d['reserved'])/1e24,'solvent',d['solvent'])"
```

**Pass criteria:** the transaction is Final with a success value; a new `active` policy exists with
your account as `buyer`; `reserved` rose by the payout and `solvent` is `true`.

## 5. Record the result

- **PASS** — capture the transaction hash, the console screenshot, and the four command outputs above.
- **FAIL** — capture the same, plus the browser console errors, and open an issue. Do not describe a
  failure as a pass.

---

## Why this is the only open item

Everything else is verified without a human:

| Concern | How it is already verified |
| --- | --- |
| The exact `buy_cover` shape the console builds | `tests/wallet-journey.test.mjs` runs the page's **real** inline script against a mock wallet: one action, deposit equal to the contract's own `quote`, beneficiary handling, the future-date clamp, and honest success / failure / no-hash / rejection states. |
| Wrong-network refusal, duplicate-click guard, wallet timeout | The same suite; the timeout path is covered by the `OVERCOVER_SIGN_TIMEOUT_MS` cases. |
| The public console with no signing service | `npm run verify:connectivity` (13/13). |
| A real `buy_cover` on hardened v3 | Agent purchase tx `45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn` → policy 3, re-derived from the chain by `npm run verify:proof`. |
| Reserved capital and solvency invariant | `npm run verify:proof` reads `get_pool` live and asserts `reserved <= capital`. |

The only thing a mock cannot produce is a **human pressing Approve in a real extension**. That is
what step 3 does, and why it is listed in `docs/HUMAN_ACTIONS_REQUIRED.md` §B.
