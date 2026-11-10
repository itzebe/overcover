# OVERCOVER — Adversarial Feasibility (Mission 1)

**Date:** 2026-11-10 · **Status:** complete · **Verdict: CONDITIONAL GO** (conditions listed in §7)

This document is the output of Mission 1: I tried, as a hostile competitor / malicious
underwriter / dishonest oracle operator / opportunistic claimant, to break Overcover's business
model and technical assumptions **before** writing the Rust contract.

**How the attacks were run.** Every attack is executable, not narrative. I built a pure reference
model of the mutual's accounting rules (`research/model/mutual.mjs`, BigInt yoctoNEAR) and an
attack suite (`research/model/attacks.mjs`) that reproduces each attack and records the result.
Run it yourself:

```bash
cd overcover
node research/model/attacks.mjs     # exits non-zero if any attack is EXPLOITABLE
```

Current result: **31 attacks, 0 exploitable, 31 defended.**

The model is the executable SPEC for the Rust contract: every rule enforced in `mutual.mjs` is
intended to be enforced on-chain, and the Rust unit tests mirror this suite (Mission 5).

---

## 1. What the model enforces (the rules under attack)

| Rule | Where |
| --- | --- |
| `reserved <= capital` after every mutation (the one invariant) | `checkInvariant()` |
| Products are **immutable** and own the threshold + premium rate + capacity | `addProduct()` |
| The buyer chooses only the payout and the observation date | `buyCover()` |
| Payout is **reserved** at issuance; premium is **contract-computed** | `buyCover()` |
| Withdrawal is allowed only for own capital **and** only if solvency survives | `withdraw()` |
| Only the attestor may report; observations are range-, freshness- and replay-checked | `reportObservation()` |
| Disputes are **bonded**; a disputed observation cannot settle | `challenge()` |
| A policy settles **exactly once**, in both outcomes | `resolve()` |

---

## 2. Every tested attack, reproduction and result

Legend: **DEFENDED** = the contract rejected it or the invariant held. **EXPLOITABLE** = the
attacker gained something they should not have.

### Surface A — insurance economics

| ID | Attack (reproduction) | Expected | Actual | Verdict | Severity if exploitable |
| --- | --- | --- | --- | --- | --- |
| A1 | 100 NEAR policy; index 25.0 mm ≥ 20.0 mm threshold; settle | pays exactly 100 NEAR | paid 100 NEAR | DEFENDED | Critical (happy path) |
| A2 | Same policy, index 5.0 mm < threshold; settle | pays 0 | paid 0; capital unchanged (premium kept) | DEFENDED | Critical |
| A3 | Deposit 150 NEAR; buy five 100 NEAR policies | ≤1 issued | issued 1, rejected 4 | DEFENDED | Critical |
| A4 | Buyer passes `premium: 0` to `buyCover` | contract-computed premium (3 NEAR) | charged 3 NEAR | DEFENDED | Critical |
| A5 | Deposit 100; buy 100 cover; withdraw 100 | rejected (reserved) | rejected | DEFENDED | Critical |
| A6 | 10 × 100 NEAR claims on a 1000 NEAR pool, all at once | all pay, invariant holds | paid 1000, invariant OK | DEFENDED | Critical |
| A7 | Buy cover 1 h before the observation date | rejected (min lead 24 h) | rejected | DEFENDED | High |
| A8 | Buy 100 NEAR cover from a 50 NEAR pool | rejected | rejected | DEFENDED | Critical |
| A9 | Resolve before the observation date | rejected | rejected | DEFENDED | High |

### Surface B — oracle

| ID | Attack | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- |
| B1 | Non-attestor reports a value | rejected | rejected | DEFENDED |
| B2 | Report a 7-day-old observation | rejected (stale > 24 h) | rejected | DEFENDED |
| B3 | Report 10 000 mm rainfall | rejected (implausible) | rejected | DEFENDED |
| B4 | Re-report the same (city,date) to overwrite | rejected | rejected | DEFENDED |
| B5 | Report an observation dated in the future | rejected | rejected | DEFENDED |
| B6 | Resolve 1 s after the observation | rejected (challenge window) | rejected | DEFENDED |
| B7 | Attestor lies; a watchdog disputes; claim attempted | no payout while disputed | blocked | DEFENDED |
| B8 | Griefer disputes every honest observation | griefer pays a bond; honest policies still pay | griefer forfeits bond; all paid | DEFENDED (with residual — §5) |

### Surface C — contract mechanics

| ID | Attack | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- |
| C1 | Resolve the same policy twice | rejected | rejected | DEFENDED |
| C2 | 1-yocto payout premium rounds to 0 | premium ≥ 1 | premium = 1 (ceil) | DEFENDED |
| C3 | Payout above max / below min | both rejected | both rejected | DEFENDED |
| C4 | Non-provider withdraws capital | rejected | rejected | DEFENDED |
| C5 | Provider withdraws more than they deposited | rejected | rejected | DEFENDED |
| C6 | 20 000 random operations (deposit/withdraw/buy/advance/resolve) | invariant never breaks | invariant held | DEFENDED |

### Surface D — agent abuse

| ID | Attack | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- |
| D1 | Bot rotates cities to multiply exposure | capped by capital | issued 1 | DEFENDED |
| D2 | Underwriter agent withdraws 51 from 50 deposited | rejected | rejected | DEFENDED |
| D3 | Agent re-registers a product to change pricing | rejected (exists / owner-only) | rejected | DEFENDED |
| D4 | 50 sybil providers pool 50 NEAR, buy 100 cover | rejected (capital is capital) | rejected | DEFENDED |
| D5 | Buyer agent self-attests the trigger | rejected (not the attestor) | rejected | DEFENDED |

### Surface E — economic-design attacks discovered during this mission

| ID | Attack | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- |
| **E1** | **Buyer supplies a near-certain threshold (0.1 mm)** | the product's fixed threshold is used | policy threshold = 200 (product-owned) | **DEFENDED after fix — was EXPLOITABLE** |
| E2 | Buy 10 × 100 NEAR cover on a product capped at 250 | ≤2 issued | issued 2, rejected 8 | DEFENDED |
| E3 | 10 correlated policies all trigger at once | all pay, invariant holds | paid 1000, 0 failures | DEFENDED |

---

## 3. The one attack that actually worked (E1) — and the fix

**Reproduction (against the pre-fix model).** In the first design, `buyCover` accepted the
threshold from the caller and priced the policy at a flat rate (3% of payout).

```
buyCover(buyer, product="rain", payout=100 NEAR, threshold=0.1 mm, obsDate=D+3)
  premium charged:   3 NEAR
  payout received: 100 NEAR
  attacker net:     97 NEAR   ← guaranteed profit whenever 0.1 mm falls (near-certain)
```

**Economic consequence.** A buyer picks the trigger closest to a certainty, pays a 3% fee, and
drains the pool. Repeated across policies, the pool is emptied. Severity: **Critical** (it defeats
the entire premise).

**Fix (now in the model).** The **threshold and the premium rate are properties of an immutable
product**, not arguments to `buyCover`. The buyer chooses only the payout amount and the
observation date. A caller-supplied `thresholdTenths` is ignored (verified by E1). I also added a
per-product **capacity cap** (`maxTotalCoverage`) so a single product cannot concentrate unbounded
liability (E2).

**What this proves.** The pre-fix concept was *not* defensible. The concept becomes defensible only
with product-owned triggers, contract-owned pricing and reservation-based solvency — i.e. the
"CONDITIONAL" in the verdict is real and load-bearing.

---

## 4. Economic model that survives (what the attacks force)

The attacks force a **fully-collateralised mutual**, not an actuarially-priced insurer:

1. **Every payout is reserved in full at issuance.** `reserved` is the sum of all active payouts;
   the contract refuses any policy whose payout it cannot cover. It can therefore never promise
   money it does not hold.
2. **Products are the risk catalogue.** An immutable product = `(city, threshold, premium rate,
   payout bounds, min lead, capacity)`. Buyers choose how much cover, never the risk.
3. **Pricing is a fee on locked capital, not a risk premium.** `premium = ceil(payout × premiumBp
   / 10000)`. This is honest: the mutual does not claim to price risk from a model; it charges a
   transparent fee for capital lock-up. (I do not claim actuarial pricing.)
4. **Solvency is a single, testable invariant:** `reserved ≤ capital`, checked after every state
   change and fuzzed 20 000 times.

---

## 5. Residual risks I could NOT eliminate (stated honestly)

These are not "fixed"; they are bounded and disclosed. I do not claim Overcover is trustless.

| # | Residual risk | Why it remains | Bounded by |
| --- | --- | --- | --- |
| R1 | **Trusted attestor.** The MVP's oracle is one signer that reads Open-Meteo and signs the value. A dishonest signer could report a false breach. | A fully trustless oracle (multi-attestor median, on-chain TLS proofs) is out of scope for 4 days. | A **bonded challenge** (B7/B8) lets anyone dispute; a disputed observation cannot settle; the owner must uphold or the observation dies. The signer key is visible and rotatable. |
| R2 | **Owner-mediated disputes.** Resolving a dispute is owner-only, so a malicious owner could uphold a false report. | No on-chain jury within scope. | The observation + challenge + bond are all public; a false uphold is visible and attributable. |
| R3 | **Parametric basis risk.** The index (rainfall) is not the buyer's actual loss. | Inherent to parametric cover. | The product's threshold and city are explicit; the buyer sees exactly what is covered. |
| R4 | **Full collateralisation is capital-inefficient.** The pool cannot sell cover worth more than its capital. | Deliberate — it is what makes solvency provable. | Capacity caps + the honest "mutual, not insurer" positioning. |
| R5 | **Regulatory optics.** Insurance is regulated. | Out of scope to solve. | Testnet-only, no fiat, no solicitation; positioned as a mutual. |

---

## 6. What I did NOT test (limits of this document)

- No test against a **live NEAR runtime** yet — the attacks run against the JS model. The Rust
  contract and its unit tests are Mission 3/5.
- **No LLM in the loop** was attacked for prompt-injection, because the design forbids the LLM from
  any financial authority (it may only suggest a premium *within contract bounds*; the contract
  ignores anything else). This must still be verified in the agent layer (Mission 5).
- No **gas/DoS** analysis of the on-chain loop beyond the JS fuzz.

---

## 7. Verdict

### **CONDITIONAL GO.**

A credible, bounded product **can** be built within the deadline — *if and only if* the following
conditions hold (each maps to a fix the attacks forced):

1. **Products own the trigger and the price.** `buyCover` must not accept a caller-supplied
   threshold or premium. *(Forced by E1, A4.)*
2. **Reserve every payout in full at issuance**, and refuse issuance when the pool cannot cover it.
   *(Forced by A3, A8, A6.)*
3. **Withdrawal only for unencumbered capital.** *(Forced by A5.)*
4. **A single, tested solvency invariant** `reserved ≤ capital`, fuzzed. *(Forced by C6.)*
5. **A bonded challenge on observations**, with disputed observations unable to settle.
   *(Forced by B7, B8 — this is what makes a single attestor acceptable.)*
6. **Honest disclosure** of R1–R5 in the README and the demo.

If any condition is dropped, the concept degrades to the pre-fix E1 model, which is a **NO-GO**.
Because the conditions are implementable in Rust within the window, the verdict is **CONDITIONAL
GO**, not NO-GO — and the redesign below preserves the core opportunity (an autonomous, verifiable
risk mutual) exactly as intended.

**Smallest defensible redesign vs. the original idea:** unchanged in spirit; tightened in
mechanism. The original "let a buyer choose a risk and an underwriter quote a price" becomes "the
contract publishes immutable products; capital providers fund them; payouts are reserved and
parametrically settled." The differentiator (on-chain, provable solvency + automatic parametric
settlement) is preserved and now defensible.

---

*Produced by an AI agent (OpenHands) on behalf of the user. Every attack above is reproducible with
`node research/model/attacks.mjs`. This document reports what was tested and what was not; it does
not claim the system is trustless.*
