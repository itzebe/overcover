# OVERCOVER — hackathon submission

**One line:** An autonomous, on-chain parametric risk mutual that lets AI-operated businesses buy
verifiable, instant-paying cover against objective public indices, and lets anyone underwrite it
with guaranteed solvency.

**Live contract:** `contract.attestor-overcover.testnet` (NEAR testnet)
**Live console:** https://overcover.vercel.app/ · https://itzebe.github.io/overcover/
**Deployed code hash:** `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R`
**Tracks:** Business (primary) · Swarms (agent-operated businesses) · DeFi (underwriting pool)
**X demo post:** see [`docs/DEMO_POST.md`](docs/DEMO_POST.md)

Verify the deployed bytecode is exactly this source:

```bash
cargo build --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
sha256sum contract/target/wasm32-unknown-unknown/release/overcover.wasm
# expected: 1f30ccf1d4c735ad58dd858a41293187fd6598a4d20fe2ee1ab99d4d766dd26e
```

The RPC returns the same 344857-byte module for `contract.attestor-overcover.testnet`.

**Try it without installing anything.** Open `ui/index.html` (or the hosted console). It reads the
contract directly from your browser over public testnet RPC and shows, right now: capital backing
cover, payouts promised, both invariants (`reserved ≤ capital`, `reconcile`), 22 products, 15
policies and 16 observations — including one **nullified** reading that was successfully challenged
on-chain. Open the Proof panel, copy the `curl`, run it, and you get the same JSON. Nothing on the
page has to be taken on trust.

---

## 1. The problem

Autonomous agents are beginning to run real economic activity — routing deliveries, operating
fleets, running market-making and compute-broking businesses. They can transact, but they cannot
**insure**. Insurance today requires a legal person to apply, a human to underwrite, and a human
adjuster to settle — a process measured in weeks, gated on identity a software agent does not have.

The capital that would underwrite these risks has no trustless way in: no verifiable index, no
dispute mechanism, and no on-chain guarantee that a pool never promises more than it holds.

## 2. The solution

Overcover is a parametric mutual. It removes the underwriter and the adjuster from the loop and
replaces them with three primitives:

1. **Immutable products.** Risk is *defined*, not negotiated. A product fixes the city/index,
   the trigger threshold, the premium rate, the payout bounds, the minimum lead time and a
   capacity cap. It cannot change after publication.
2. **Reserved capital.** Buying cover reserves the payout from the pool at purchase. The invariant
   `reserved ≤ capital` is enforced after every mutation, so a promise is always backed.
3. **Signed index + bonded disputes.** An attestor reports `(city, date, value)` signed with
   ed25519; the contract verifies the signature, the freshness and a replay nonce. Anyone can
   challenge with a bond, and the owner resolves; the loser's bond is forfeited into the pool.

The result: a business buys cover, an index is observed, and a claim settles in **seconds** —
deterministically, with no discretion and no queue.

Two actors can drive that flow. A **person** connects their own NEAR wallet and signs a single
`buy_cover` call — the console re-reads the premium from the contract and attaches exactly that, and
never claims a policy was bought until the wallet confirms it. An **autonomous agent** runs the same
contract from software: a hard, pre-set spending-limits engine gates every buy (a denial never
reaches the network), so the agent can act on its own without ever exceeding the authority a human
granted it. The public console evaluates a purchase with that **same engine, read-only in the
browser** — no key, nothing signed — so a visitor can see the agent's decision without running
anything; buying through the agent needs a local service the operator runs.

## 3. Why this fits the tracks

| Track | Fit |
| --- | --- |
| **Business** | A real revenue model (premiums), a real risk product, real capital markets. |
| **Swarms** | The primary customer is an AI-operated business; the whole flow is machine-callable. |
| **DeFi** | A transparent, solvency-checked underwriting pool with programmatic payout. |

## 4. Why NEAR

- **Speed + cost** make small parametric payouts economic and make settlement seconds, not weeks.
- **ed25519 host verification** (`env::ed25519_verify`) makes a signed oracle a first-class,
  cheap primitive rather than an expensive precompile.
- **Named accounts** make the roles (business, LP, attestor, challenger) legible on-chain.
- **Free testnet + keyless weather API** mean the entire critical path costs nothing to run.

## 5. The 60-second demonstration

> Narration in the left column; the right column is what actually happens on NEAR testnet.

1. **"A pool anyone can fund."** Two LPs deposit; the pool shows `capital 5, reserved 0`. → `deposit` txs.
2. **"A business buys cover."** It buys a 1 NEAR payout for a Lagos rainfall trigger. The premium is
   charged and **1 NEAR is reserved** — the pool now shows `capital 5.05, reserved 1.0`. → `buy_cover` tx.
3. **"The risk is defined, so no one can argue later."** The threshold was published with the
   product and is immutable. → `add_product` txs.
4. **"A real reading comes in."** The oracle reads Open-Meteo live, cross-checks it, and the
   attestor signs it; the contract verifies the signature. → `report_observation` tx.
5. **"A premature claim is refused."** Resolving inside the challenge window is rejected:
   *"challenge window not elapsed."* → refused `resolve`.
6. **"The claim settles."** After the window, `resolve` pays the beneficiary; the balance rises by
   exactly the payout, and `total_paid` moves. → `resolve` tx.
7. **"It cannot be paid twice."** A second `resolve` is rejected: *"policy not active."*
8. **"A claim that did not trigger pays nothing."** A dry-city policy settles with **zero payout**;
   the premium is retained. → `resolve` tx.
9. **"The pool cannot be drained."** A non-provider withdrawal is rejected: *"not a provider."*
10. **"The oracle is not trusted blindly."** A challenger disputes a reading by posting a bond.
    If the report was true, the report stands and the bond is **forfeited to the pool**. If the
    report was false, the report is **nullified** and the bond is returned. Both are shown live.
    → `challenge` + `resolve_dispute` txs (both outcomes).
11. **"It reconciles."** Final state satisfies `reserved ≤ capital` and
    `capital == deposited − withdrawn + premiums + bonds − paid` — both `true`.

**The one thing to remember:** every refusal above is a **real on-chain error string**, not a
client-side check. The rules live in the contract.

## 6. Verified testnet evidence

Every row is a real transaction; run `npm run demo` to reproduce and regenerate `demo-log.json`.
All 18 hashes resolve on-chain via the `tx` RPC method.

| Step | Transaction |
| --- | --- |
| add_product rain-lagos | https://testnet.nearblocks.io/txns/BksQTpHzuZ5hDvGaUBBuNv1qgEzwSn7a3wTiMnm8rRR |
| add_product rain-bergen-dry | https://testnet.nearblocks.io/txns/BfWA4n561dTD4i9bA5UL59zcwAbsa9duAKuZnNw8zkKL |
| deposit (LP A) | https://testnet.nearblocks.io/txns/4VNLFJuzmjJyNCnmuvba6EaZCt3qLfR7r2he7oBN2Qxn |
| deposit (LP B) | https://testnet.nearblocks.io/txns/BLETXja2zYDXybaVcvB1p2WCK72JiZTnHDfdWdAb3ema |
| buy_cover (rain-lagos) | https://testnet.nearblocks.io/txns/HpNNqRyLCQHHrqF5AQBT4ZRSF6Fu9AUbRPNX7HkU7gwL |
| buy_cover (rain-bergen-dry) | https://testnet.nearblocks.io/txns/5NW2sF3yNEfBwEbknbANKKzcru5CcBpG2zPzrbp7qUPG |
| report_observation lagos | https://testnet.nearblocks.io/txns/CLFdnAs14lKNEGsKmLJ8rMtt8J3XmxaH9KjCzRV9Dp7D |
| report_observation bergen | https://testnet.nearblocks.io/txns/DffaSbezWNJA7wyEdEmqGT41sCeYfKxmLJoye8ZTjVg9 |
| resolve (paid) | https://testnet.nearblocks.io/txns/8nvB1dQfBNpJGqfiPcMBC6GScZnzZb3684aKvUzoSnJ3 |
| resolve (not triggered) | https://testnet.nearblocks.io/txns/8sHQujtdYHByd3pydEstxtjd444SRVXJzxhA5CqnXgSD |
| withdraw (LP B) | https://testnet.nearblocks.io/txns/4sizwY4TNri3o7CuEhsAZLJ2sZisiXyvQqxncUprcPP8 |
| withdraw (LP A) | https://testnet.nearblocks.io/txns/FE5AVV3kdjxcTxukZ17MPFGeMQNd44jDAZu1RGxU4awf |
| challenge lagos (→ upheld) | https://testnet.nearblocks.io/txns/EJwM57xGqM32iNrfES38BoDs8eRujp3V4s2zatmgrdpz |
| resolve_dispute upheld (bond forfeited) | https://testnet.nearblocks.io/txns/ztxGRCatv7xvUSZx7gJKo6eGHaSTNx52JxMQ5ejXNW4 |
| challenge lagos (→ rejected) | https://testnet.nearblocks.io/txns/CeaUg3X9R3urZQzSQhF2ewrs6k49ASVSzjnHdDSumB5e |
| resolve_dispute rejected (report nullified) | https://testnet.nearblocks.io/txns/3i1ZwxY1MfkzDnCfhDK2YGaDeCH2wX8j5cpobfamEaG6 |

### Autonomous-agent purchases (independent agent account)

An agent with its own NEAR testnet account (`oc-agent-mwb87z4k.testnet`) and its own key bought
cover on the live contract, gated by the spending-limits engine. Each hash resolves via the `tx` RPC
method; each emitted a `policy_issued` event.

| Step | Transaction |
| --- | --- |
| agent buy_cover (rain-lagos, 1 NEAR payout = product max) → policy 11 | https://testnet.nearblocks.io/txns/7iG4WWy1ixqCSPEEddA9dZJr8JvgE7SVyHhhBqj5DmRJ |
| agent buy_cover via the HTTP API (rain-bergen-dry, 0.5 NEAR payout) → policy 12 | https://testnet.nearblocks.io/txns/26UvFN3AZ3143sYFhsmbsrcAP2uPyKvgEHSrNXth1And |

The first purchase is the regression that proved the u128 precision fix: before the fix the agent's
exact bounds check rejected a payout equal to the product's true maximum (`max_payout` came back
from `JSON.parse` as `999999999999999983222784`). The over-limit case (a 5 NEAR payout against a
1 NEAR cap) is refused by the policy engine before any RPC call, so no funds move.

### Human wallet purchase (independent account)

The console's human path is: connect a NEAR wallet (HERE or Meteor), read a live `quote`, build the
exact `buy_cover` call, and let the wallet sign it. Two layers are verified:

- **The transaction shape is proven on-chain.** An independent testnet account signed the **exact**
  arguments the page constructs (`buildBuyArgs`: `product_id`, `payout`, `obs_date`, `beneficiary`),
  attaching the contract's own quoted premium. Policy 15 reads back with `buyer =
  human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet`, `product = rain-lagos`, `payout = 1 NEAR`,
  `premium = 0.05 NEAR`, `status = active`.

| Step | Transaction |
| --- | --- |
| buy_cover (rain-lagos, 1 NEAR payout) → policy 15 | https://testnet.nearblocks.io/txns/87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i |

- **The wallet-side flow is covered by tests, not a live extension.** The console's
  success/failure classifier (`evaluateWalletOutcome`, lifted from the page) is unit-tested: a
  rejected, failed or hashless wallet result is never presented as a purchase, and the
  `buy_cover` arguments are asserted against the contract ABI. `npm run verify:connectivity`
  additionally drives the real page in a browser with the wallet bundle loaded.

**Honest limitation:** the transaction above was signed **programmatically** with the same
arguments the page builds — it is **not** a recording of a HERE/Meteor extension approval, which
requires an interactive browser with the extension installed. A live extension approval has not been
captured in this environment. A judge can complete it in two minutes by following
[`docs/JUDGE_DEMO.md`](docs/JUDGE_DEMO.md) §3 with any funded NEAR testnet account.


## 7. Verification results

| Suite | Command | Result |
| --- | --- | --- |
| Reference model attacks | `npm run test:model` | **31 attacks, 0 exploitable, 31 defended** |
| Contract unit tests | `npm run test:contract` | **21 passed, 0 failed** |
| Console regression + live RPC | `npm run test:console` | **78 passed, 0 failed** |
| Agent limits + API + u128 precision | `npm run test:agent` | **36 passed, 0 failed** |
| Product feed + agent evaluation | `npm run test:agent-eval` | **22 passed, 0 failed** — feed schema/premium checks, agent boundary cases, live read-only chain check |
| Live adversarial tests | `npm run test:onchain` | **17 tests** — refused-with-the-expected-reason against the LIVE contract; needs a fresh `npm run deploy` and the gitignored operator identities (not run in the CI environment) |
| Console UI (Playwright, 320–1440 px) | `npm run ui:qa` | **7 viewports, 0 console errors, public read-only + local dry-run round-trip OK, wallet picker opens in-viewport** |
| Full economic cycle | `npm run demo` | **18 transactions, all steps green (incl. both dispute outcomes)** |
| Console accessibility (axe-core, WCAG 2.2 AA) | `npm run axe` | **0 violations at 320 / 360 / 390 / 768 / 1024 / 1280 / 1440 px (page and wallet dialog)** |
| One-command independent proof | `npm run verify:proof` | **12/12 checks passed on a clean clone** — deployed bytecode == this source, pool solvent, all 18 demo txs real, the agent's buys real (each tied to its on-chain policy), settled outcomes match |
| Agent authorization vs the live product | `npm run verify:agent` | **over-limit buy refused, in-limit buy permitted; the shipped `createAgent` path agrees** |
| Public console needs no local agent | `npm run verify:connectivity` | **12/12 checks passed** — no localhost default, read-only verdict == shared engine on the live quote, invalid bodies rejected, limits enforced, no owner-only method reachable, buy_cover the only signing path |
| Live production URL | `npm run verify:live` | **5 widths (320–1440 px), 0 console errors, 0 horizontal overflow** |

Track ids for the submission form: `business` (primary), `swarms`, `defi`.

## 8. What is genuinely novel here

- **Risk is a published, immutable product** — a buyer cannot pick a near-certain threshold to
  farm the pool (this was the first exploit found and fixed in Mission 1).
- **Capital is reserved at purchase**, so the pool's promise is provably backed at all times.
- **The oracle's word is challengeable** with a bond, so trust is economic, not assumed.
- **Every refusal carries a reason on-chain** (via `panic_utf8`), so an autonomous client can
  react to a rejection instead of guessing.

## 9. Honest limitations

- Single trusted attestor with a bonded dispute path (not a decentralised oracle). Both dispute
  outcomes (uphold → bond forfeited; reject → report nullified, bond returned) are now exercised
  live on testnet.
- Demo window is 60 s (production 3600 s).
- The demo pins the reported reading to the value the threshold was derived from, so the outcome
  is deterministic; the reading itself is a genuine Open-Meteo observation.
- The **autonomous agent** is operated by the user, not hosted by Overcover, and ships in dry-run:
  a public endpoint that signed with a funded key would let any visitor spend that balance. The
  public console is therefore read-only (it evaluates with the same engine in the browser and signs
  nothing). Its rate limits and single-flight locks are **per-instance**, not a global distributed
  lock.
- Testnet only; unaudited; not for real funds.
