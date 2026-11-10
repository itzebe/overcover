# The judging demo

**Live console:** https://itzebe.github.io/overcover/

## 60-second script

Open the console and follow it top to bottom. Do not narrate the technology; narrate the problem and
the proof.

1. **0–10 s — the problem and the product.** "An autonomous business can buy, sell and move money,
   but it cannot buy insurance — underwriting needs a legal person and a claim needs an adjuster. So
   a loss is simply absorbed. Overcover writes cover against an objective public index and settles
   it from contract rules." The page is already showing a live pool.
2. **10–25 s — the pool is provable.** Point at **Capital backing cover** vs **Payouts promised** and
   the solvency meter between them, then at the two green invariants. "This is not a slide; it is
   contract state, and this page reads it with no server in between."
3. **25–40 s — how the promise holds.** Walk **How a policy works**: risk is defined and immutable;
   the payout is reserved at purchase; the oracle's word is challengeable with a bond.
4. **40–55 s — the real thing.** Scroll to **Policies written** and **Oracle readings**. Show a
   settled payout, then the **nullified** reading — a report that was successfully challenged
   on-chain. Open **What cover would cost** and move the slider: the premium comes from the
   contract's own `quote`.
5. **55–60 s — close on proof.** Open **Proof**, copy the `curl`, run it. The terminal returns the
   same numbers the page shows. "Don't trust the page. Reproduce it."

## What makes the demo credible

- **Live, not recorded.** The page reads `contract.attestor-overcover.testnet` over public RPC while
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

If you only have half a minute: open the console, point at the solvency meter, say "this pool backs
every promise it has made, and the page reads it from the chain", then open Proof and run the
`curl`. The number matches.
