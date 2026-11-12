# The judging demo

**Live console:** https://itzebe.github.io/overcover/

## 60-second script

Open the console and follow it top to bottom. Do not narrate the technology; narrate the problem and
the proof.

1. **0–12 s — the product, not the chain.** "Insurance for businesses that cannot afford to wait for
   a claims process." Name the covered event on the hero: rainfall in a named city on a named date.
   Point at the illustration — "the risk is outside; the cover is inside" — and at the live line
   under the buttons, which is already reading the pool from the contract.
2. **12–25 s — the cover, in the buyer's terms.** Scroll the cover strip: capital backing policies,
   reserved for potential payouts, policies in force, settlements paid. Then **Cover available now**:
   read one card aloud — the covered event, the trigger, the premium, the payout bounds, capacity
   left, and the parametric limitation. "This is what you would actually be buying."
3. **25–38 s — how a claim settles.** Walk **From buying cover to getting paid**: cover is defined
   before purchase; the payout is reserved at purchase; the attestor's reading is challengeable with
   a bond; the owner resolves a dispute; settlement is one comparison, run once.
4. **38–50 s — the real thing.** **Price a policy** and move the slider: the premium comes from the
   contract's own `quote`. Then **Policies written** for a settled payout, and **Observations &
   disputes** for the **nullified** reading — a report that was successfully challenged on-chain.
5. **50–60 s — the honest part, then close on proof.** Open the disclosures: testnet only, unaudited,
   a single trusted attestor, the owner resolves disputes, a 60-second window. Then **Check it for
   yourself**, copy the `curl`, run it. "Don't trust the page. Reproduce it."

## What makes the demo credible

- **Live, not recorded.** The page reads `contract.ovc-v3-ctl-2f6c4c.testnet` over public RPC while
  the judge watches. It refreshes every 15 seconds.
- **Honest by construction.** If a read fails, the page says **stale** (with the time of the last
  good read) or **no data**. It never shows a stale number as live. A judge can test this by
  blocking the network.
- **Reproducible.** Every figure has a one-line `curl` behind it, and every demo transaction is a
  real testnet hash linked to the explorer.
- **Both dispute outcomes exist on-chain.** The oracle table includes a reading that was **upheld**
  (bond forfeited to the pool) and one that was **rejected** (nullified) — the mechanism is not
  theoretical.

## The recorded demo

`demo-log.json` records the full economic cycle with a real testnet hash per step:

| Step | What it shows |
| --- | --- |
| `add_product` ×2 | Immutable risk definitions published. |
| `deposit` ×2 | Two providers fund the pool. |
| `buy_cover` ×2 | Cover written; payouts reserved. |
| `report_observation` | A signed index reading accepted. |
| `resolve` ×2 | One policy paid, one not — both deterministic. |
| `withdraw` ×2 | Providers withdraw unencumbered capital. |
| `challenge` + `resolve_dispute:true` | A reading upheld; the challenger's bond forfeited. |
| `challenge` + `resolve_dispute:false` | A reading rejected and **nullified**. |

Regenerate it end to end with:

```bash
node driver/keys.js
npm run deploy
npm run demo
```

## The 30-second version

If you only have half a minute: open the console, read one **Cover available now** card aloud — "it
pays if the rainfall reading meets this trigger, and the payout is reserved from the pool" — then
open **Check it for yourself** and run the `curl`. The number matches.
