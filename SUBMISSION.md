# OVERCOVER — hackathon submission

**One line:** An autonomous, on-chain parametric risk mutual that lets AI-operated businesses buy
verifiable, instant-paying cover against objective public indices, and lets anyone underwrite it
with guaranteed solvency.

**Live contract:** `contract.attestor-overcover.testnet` (NEAR testnet)
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
cover, payouts promised, both invariants (`reserved ≤ capital`, `reconcile`), 17 products, 8
policies and 13 observations — including one **nullified** reading that was successfully challenged
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

| Step | Transaction |
| --- | --- |
| add_product rain-lagos | https://testnet.nearblocks.io/txns/FfoHwfMm46GpSftP3jTZYucXRSYMXWj85sBF4gfbuUfF |
| add_product rain-bergen-dry | https://testnet.nearblocks.io/txns/DQDTYej8UyhziCteCv4vBimUcYRpe7oDVjQFJYKqa5Xt |
| deposit (LP A) | https://testnet.nearblocks.io/txns/AtHjxY32iLzBSpMAaHotM3ZvYgPXzCyKuvwhYiYcDY39 |
| deposit (LP B) | https://testnet.nearblocks.io/txns/72ynq1MRpNQ5SyKufEhpJSxuJe3NoJtVmcfihTa6p6uq |
| buy_cover (rain-lagos) | https://testnet.nearblocks.io/txns/Ey2URRchg8k9HLbMJddGxJR266qJmneV5LSvzwU8HkkB |
| buy_cover (capacity test) | https://testnet.nearblocks.io/txns/Ey3Aa1L5vDL7BFHS5ReJQD4pXXzYwF9K1wTiXRohjrs3 |
| report_observation lagos | https://testnet.nearblocks.io/txns/3tVKmXJqTANmXxPKYwEtHDJ2GejmF3ok4pohtLry2GD6 |
| report_observation bergen | https://testnet.nearblocks.io/txns/9eV2Geo8cBN7VbxXHfnck7mJHTjXLJk2w9mwzrw7zUHL |
| resolve (paid) | https://testnet.nearblocks.io/txns/4sc4AzeCZfM33MsSpyfwEb87aX4yJ76KDzMgvDhu8SZd |
| resolve (not triggered) | https://testnet.nearblocks.io/txns/8ohgy4ovEZ4JjHtyFXNtXw5Ug8FJVXxt6SowCvzZRw1q |
| withdraw (LP B) | https://testnet.nearblocks.io/txns/5mMFD6qo82qAnfjAt6ByEHqhaZ4EKJcKYHfjvpKVipcS |
| withdraw (LP A) | https://testnet.nearblocks.io/txns/EGHK78HPyC9hnY2qdFn8wRHDuZs4czuQUcxc4iZpaUe |

## 7. Verification results

| Suite | Command | Result |
| --- | --- | --- |
| Reference model attacks | `npm run test:model` | **31 attacks, 0 exploitable, 31 defended** |
| Contract unit tests | `npm run test:contract` | **21 passed, 0 failed** |
| Console regression + live RPC | `npm run test:console` | **12 passed, 0 failed** |
| Live adversarial tests | `npm run test:onchain` | **17 passed, 0 failed** |
| Full economic cycle | `npm run demo` | **18 transactions, all steps green (incl. both dispute outcomes)** |

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
- Testnet only; unaudited; not for real funds.
