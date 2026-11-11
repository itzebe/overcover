# Judge demonstration

**Live console:** https://overcover.vercel.app/ · **Contract:** `contract.attestor-overcover.testnet`
**Length:** 2–3 minutes. **Everything shown is real**: live contract reads and real testnet
transactions. Nothing is staged.

> Read this first. Two kinds of evidence appear below and they are labelled apart:
> **LIVE** — you do it now, in front of the judge, against the live contract.
> **RECORDED** — a real testnet transaction with a hash you can open on the explorer, captured
> earlier because it needs a wallet extension or a funded operator account.
> Never present a RECORDED item as if it just happened.

---

## The opening question (15 s)

> "An autonomous AI agent can now buy, sell and move money with no person in the loop. But it
> cannot buy insurance — every insurer underwrites a legal person, and an agent has no legal
> identity to sign with. And if we let the agent hold a key and spend freely, one bug drains the
> account. So: **what happens when an autonomous agent needs protection but cannot be trusted with
> unlimited spending authority?**"

## The problem (15 s)

> "Traditional insurance is built for humans: an application, an underwriter, an adjuster, a claim
> queue measured in weeks. An agent that loses a shipment at 03:00 cannot wait. And the capital that
> would underwrite the risk has no trustless way in. Overcover replaces the underwriter and the
> adjuster with three things: an immutable product, capital reserved at purchase, and a signed index
> with bonded disputes."

---

## 1. The product, read live (20 s) — LIVE

Open **https://overcover.vercel.app/**. Do not narrate the technology; narrate the product.

- Point at the hero: *"Insurance for businesses that cannot afford to wait."*
- Point at the **cover strip**: it is already reading the contract —
  *"capital backing policies, reserved for payouts, policies in force, settlements paid."*
- Open **Cover available now** and read one card aloud: the covered event, the trigger, the premium,
  the payout bounds, and the parametric limitation. *"This is what you would actually buy."*

*Why it is credible:* every number is a `get_pool` / `list_products` read from
`contract.attestor-overcover.testnet`. Refresh it; it changes when the chain changes.

Optional, if a judge asks how software finds the cover: open
**https://overcover.vercel.app/products.json** — *"the whole catalogue, generated from the contract,
with the trigger rule, the premium formula and the exact `buy_cover` call shape. Any agent can read
it; nothing here is hand-written."*

## 2. How a claim settles (15 s) — LIVE

Walk **From buying cover to getting paid**: cover is defined before purchase; the payout is
**reserved** at purchase; the oracle's reading is **challengeable with a bond**; the owner resolves a
dispute; settlement is one comparison, run once. Then open **Observations & disputes** and point at
the **nullified** reading — *"a report that was successfully challenged on-chain."*

## 3. The human buys cover (30 s) — LIVE (needs a funded testnet account)

1. Click **Connect a wallet** (hero or the buy panel). The picker opens in view.
2. Choose **HERE Wallet** (email/social sign-in inside HERE, no extension needed) or **Meteor
   Wallet** (if the extension is installed). Approve the connection. The header shows your
   `*.testnet` account.
3. In **Price a policy**, pick *Lagos rainfall*, move the payout slider. The premium updates from the
   contract's own `quote` — *"this is the contract quoting, not the page."*
4. Click **Buy this cover with your own wallet**. The page re-reads the premium from the contract and
   asks your wallet to approve exactly one `buy_cover` call.
5. Approve in the wallet. The page shows **"Transaction confirmed"** with the real hash, and the new
   policy appears under **Policies written**, read back from the contract.

*If you decline in the wallet:* the page says **"No cover was bought"** and nothing is charged. That
is the honesty guarantee — a purchase is only ever claimed from the wallet's own confirmed hash.

**RECORDED (if no funded account is available):** the console's exact `buy_cover` shape is already
proven on-chain — tx
[`87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i`](https://testnet.nearblocks.io/txns/87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i)
→ policy 15 (`rain-lagos`, 1 NEAR payout, 0.05 NEAR premium, `active`). Say plainly that this was
signed with the page's exact arguments, not by an extension, if you show it instead of doing step 3.

**TESTED OFFLINE:** `tests/wallet-journey.test.mjs` (run by `npm run test:console`) executes the
page's **real** inline script against a frozen contract snapshot with a mock wallet and asserts the
exact `buy_cover` shape — one action, deposit equal to the contract's own `quote`, beneficiary
handling, the future-date clamp, and honest success/failure/no-hash/rejection states. It is the
strongest evidence short of the live approval, and it broadcasts nothing.

## 4. The autonomous agent buys cover (40 s) — LIVE with a local service

The agent is a normal NEAR account with its own key. The public console's **Agent console** panel
defaults to **Public (read-only)**: it runs the *same* spending-policy engine in the browser and
signs nothing. To let the agent actually buy, an operator runs its service on their own machine:

```bash
export OVERCOVER_AGENT_ACCOUNT=oc-agent-mwb87z4k.testnet
export OVERCOVER_AGENT_SECRET_KEY=ed25519:...        # the agent's own key; never committed
node agent/server.mjs
```

Then, in the console's **Agent console** panel:

1. Switch the mode to **Local service**, enter the URL `http://127.0.0.1:8787` and click **Connect**.
   The panel shows the agent's account and its **limits** (max 0.05 NEAR premium / 1 NEAR payout per
   policy, 0.2 NEAR per 24 h, 5 policies per 24 h, 60 s cooldown).
2. Let it **evaluate** a product. It reads the live `quote` and shows allow/deny **with reasons**.
3. A permitted purchase executes and shows the real transaction hash and the resulting policy.

In **Public (read-only)** mode (the default a judge sees), the panel still evaluates the live product
against the same engine and shows the allow/deny verdict, but there is no key and no buy button —
that is the honest default for a public page.

**RECORDED:** the agent has already bought cover on the live contract under these limits:
[tax 11](https://testnet.nearblocks.io/txns/7iG4WWy1ixqCSPEEddA9dZJr8JvgE7SVyHhhBqj5DmRJ) →
policy 11 (`rain-lagos`, 1 NEAR = product max) and
[tx 12](https://testnet.nearblocks.io/txns/26UvFN3AZ3143sYFhsmbsrcAP2uPyKvgEHSrNXth1And) →
policy 12 (`rain-bergen-dry`, 0.5 NEAR). Both signed by `oc-agent-mwb87z4k.testnet`. `npm run
verify:proof` re-checks both against the chain.

## 5. The security boundary (25 s) — LIVE

Propose a purchase the agent may not make — a payout five times the product's cap, or a premium above
0.05 NEAR. The engine **refuses it before any transaction is sent** and lists the exact reasons
(over the per-policy cap, over the daily budget, outside the product bounds).

> "The refusal happens in the spending engine, before the network. No funds move on a denied
> proposal. The agent's authority is bounded — and the contract is the final authority regardless."

The same boundary is proven offline: `tests/agent-integration.test.mjs` drives a client that knows
only the published catalogue, the published schema and the documented API through discover → quote →
decide → buy (dry run) → over-limit refusal → allow-list refusal → replay → malformed → kill switch.
A live buy also passes a **balance preflight** before it signs (`tests/agent-funds.test.mjs`), so an
underfunded agent refuses rather than sending a doomed transaction.

Also show the **kill switch**: `POST /api/v1/agent/control {"enabled":false}` stops all buying
immediately; a further buy returns `403` with "agent is disabled".

## Closing payoff (10 s)

> "A person and an autonomous agent both buy the same cover, and both end in a **verifiable on-chain
> policy** — while the agent stays inside explicit spending permissions it can never exceed. Open
> **Check it for yourself**, copy the `curl`, run it: don't trust the page, reproduce it."

---

## Judge checklist

| # | Check | Expected | How |
| --- | --- | --- | --- |
| 1 | The console is live | Pool figures appear and update | Open https://overcover.vercel.app/ and refresh |
| 2 | It reads the contract, not a fixture | `get_pool` matches the page | Copy the `curl` in **Check it for yourself** |
| 3 | The page is honest on failure | Shows **stale**/"no data", never a stale number as live | Block the network and reload |
| 4 | Human purchase shape | `buy_cover` args match the ABI | `npm run test:console` |
| 5 | Human purchase on-chain | Policy 15 exists with the right buyer | Open the policy 15 explorer link / `get_policy` |
| 6 | Agent has an independent account | Signer is `oc-agent-mwb87z4k.testnet` | Open tx 11/12 on the explorer |
| 7 | Spending limits enforced | Over-limit buy refused with reasons, before the network | `npm run verify:agent`; the agent panel |
| 8 | Unauthorized purchase denied | `403` with reasons | `npm run verify:connectivity` |
| 9 | No key is exposed | No `ed25519:` in tracked files or the bundle | `git grep -nIE 'ed25519:'`; `verify:connectivity` check 7 |
| 10 | Deployed code == this source | `1f30ccf1…` (344857 bytes) | `npm run verify:proof` |
| 11 | Tests pass | model 31/0, contract 21/0, console 77/0, agent 36/0 | `npm test` |
| 12 | Production is the deployed commit | the production deployment's `meta.githubCommitSha` | `GET /v6/deployments?...&target=production` |

## Honesty details a judge may probe

These are deliberate, not accidents. If a judge asks, the answers are:

- **The trigger direction is stated correctly.** The contract's `resolve` pays when the reading is
  **≥** the product threshold. The hero says "at or above", and each product card derives its covered
  event from the product's own `threshold_tenths` — never a hand-written sentence that could drift.
- **The observation date must be genuinely in the future.** `min_lead_sec` is 0 for every product
  currently published and the date is compared in whole seconds, so the page refuses a date that is
  only seconds ahead *before* it asks the wallet to sign — you cannot sign a `buy_cover` the contract
  would later refuse.
- **Policy status is never invented.** The contract stores only `active | settled_paid |
  settled_no_pay`. A past-due policy the contract has not settled reads **"settlement due — awaiting
  resolve()"**, derived from the settlement rule — never a fabricated "settled".
- **A product with a broken definition is disclosed, not sold.** `rain-bergen-dry` sets its trigger at
  the contract's own maximum plausible rainfall (500.0 mm), which `report_observation` will only ever
  accept at exactly that value — so it can pay on that single reading and nothing else. It is grouped
  with the other test fixtures and labelled, not offered as live cover. This is the page refusing to
  sell you a definition that cannot work as intended.
- **Wallet errors are actionable.** A cancelled connection, a blocked pop-up, an unreachable wallet
  service or a wrong network each produce a plain sentence, not a raw `Error`.

## Backup procedure (if a wallet extension or testnet is unavailable)

- **No wallet extension / no funded account.** Do not fake it. Show the **RECORDED** policy 15 link
  and say clearly it was signed with the page's exact arguments, then show the console's
  success/failure classifier is unit-tested (`npm run test:console`). The transaction shape is
  proven; the extension click is what was not captured.
- **Local agent service will not start.** Show the **RECORDED** agent txs 11/12 and run
  `npm run verify:agent`, which proves the spend-authorization engine against the **live** product
  without any key.
- **NEAR testnet RPC is slow or down.** The console shows **stale** with the last good read — that is
  the designed behaviour, not a failure. Fall back to `demo-log.json` (18 real hashes) and
  `npm run verify:proof` (which re-derives everything from public RPC).
- **Vercel URL unreachable.** Use the mirror https://itzebe.github.io/overcover/ (byte-identical
  `index.html`).
- **Nothing loads at all.** Run the read-only proof locally: `npm ci --ignore-scripts && npm run
  verify:proof`. It needs no key and writes nothing on-chain.
