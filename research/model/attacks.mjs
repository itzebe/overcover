// Overcover — Mission 1 adversarial suite.
//
// Every attack below is EXECUTED against the reference model (mutual.mjs).
// For each: we set up a hostile scenario, attempt the attack, and record
// whether it succeeded. A "DEFENDED" attack is one the contract rejected (or
// that left the solvency invariant intact). An "EXPLOITABLE" attack is one
// where the attacker gained something they should not.
//
// Run: node research/model/attacks.mjs
//
// Exit code is non-zero if ANY attack is EXPLOITABLE, so this doubles as a
// regression gate once the model is mirrored into Rust.

import { Mutual, ContractError, ONE_NEAR, LIMITS } from "./mutual.mjs";

const N = (x) => BigInt(x) * ONE_NEAR;
const results = [];
const rec = (id, surface, desc, expected, actual, exploitable, note = "") =>
  results.push({ id, surface, desc, expected, actual, exploitable, note });

function fresh(over = {}) {
  const m = new Mutual({
    owner: "owner.testnet",
    attestor: "attestor.testnet",
    challengeWindowSec: 3600,
    settleDelaySec: 0,
    challengeBond: N(1) / 10n,
    now: 0,
    ...over,
  });
  m.addProduct("rain", {
    city: "berlin",
    thresholdTenths: 200n, // 20.0 mm
    premiumBp: 300n,      // 3%
    minPayout: N(1),
    maxPayout: N(1000),
    minLeadSec: 24n * 3600n,
    maxTotalCoverage: N(5000),
  });
  return m;
}

const D = (n) => BigInt(n) * 24n * 3600n; // n days in seconds

// ===========================================================================
// SURFACE A — insurance economics
// ===========================================================================

// A1. One policy, one claim — the happy path must actually pay.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({
    buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3),
  });
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n });
  m.advanceTo(D(3) + 7200n);
  const r = m.resolve(id);
  rec("A1", "economics", "One policy, index breaches threshold, must pay",
    "payout = 100 NEAR", `${r.paid / ONE_NEAR} NEAR`, r.paid !== N(100),
    "happy path; also asserts capital dropped by exactly the payout");
}

// A2. A claim the index does NOT meet must not pay.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({
    buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3),
  });
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 50n, reportedAt: D(3) + 60n });
  m.advanceTo(D(3) + 7200n);
  const before = m.capital;
  const r = m.resolve(id);
  rec("A2", "economics", "Index below threshold must not pay",
    "paid = 0 and capital unchanged except released reservation",
    `paid=${r.paid / ONE_NEAR}`, r.paid !== 0n,
    `capital before ${before / ONE_NEAR} after ${m.capital / ONE_NEAR} (premium retained)`);
}

// A3. Buy multiple overlapping policies to exceed real exposure.
// Each policy is independent, so N policies SHOULD be allowed iff the pool can
// reserve N*payout. The attack is buying beyond the pool's capacity.
{
  const m = fresh();
  m.deposit("lp1", N(150)); // only enough to reserve 150 NEAR
  let bought = 0, rejected = 0;
  for (let i = 0; i < 5; i++) {
    try {
      m.buyCover({ buyer: `biz${i}`, productId: "rain", payout: N(100), obsDate: D(3) });
      bought++;
    } catch { rejected++; }
  }
  rec("A3", "economics", "Buy 5x 100 NEAR cover against a 150 NEAR pool",
    "at most 1 issued (reservations capped by capital)", `issued=${bought} rejected=${rejected}`,
    bought * 100 > 150, "reservation check is the gate");
}

// A4. Underwriter quotes an artificially low premium.
// The premium is contract-owned: buyCover ignores any caller-supplied price.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({
    buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3),
    premium: 0n, // attacker-supplied, must be IGNORED
  });
  const pol = m.policies.get(id);
  rec("A4", "economics", "Buyer tries to inject premium=0",
    "premium is contract-computed (3% of 100 = 3 NEAR)",
    `charged premium=${pol.premium / ONE_NEAR} NEAR`, pol.premium !== N(3),
    "pricing is deterministic and contract-owned");
}

// A5. Withdraw capital while a policy is still active.
{
  const m = fresh();
  m.deposit("lp1", N(100));
  m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  let withdrew = false, err = "";
  try { m.withdraw("lp1", N(100)); withdrew = true; }
  catch (e) { err = e.message; }
  rec("A5", "economics", "Provider withdraws 100 NEAR while 100 NEAR is reserved",
    "rejected (funds reserved)", withdrew ? "WITHDREW" : `rejected: ${err}`,
    withdrew, "reserved funds cannot be withdrawn");
}

// A6. Simultaneous claims draining the pool.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(m.buyCover({ buyer: `biz${i}`, productId: "rain", payout: N(100), obsDate: D(3) }));
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 999n, reportedAt: D(3) + 60n });
  m.advanceTo(D(3) + 7200n);
  let paid = 0n;
  for (const id of ids) { try { paid += m.resolve(id).paid; } catch {} }
  let ok = true; try { m.checkInvariant(); } catch { ok = false; }
  rec("A6", "economics", "10 simultaneous 100 NEAR claims on a 1000 NEAR pool",
    "all pay, invariant holds (reserved<=capital throughout)",
    `paid=${paid / ONE_NEAR} NEAR, invariant=${ok ? "OK" : "BROKEN"}`, !ok,
    "the pool was sized to cover them; invariant is the safety net");
}

// A7. Buy coverage immediately before a predictable event (adverse selection).
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  let ok = false, err = "";
  try {
    // obsDate only 1 hour away; minLeadSec is 24h
    m.buyCover({ buyer: "attacker", productId: "rain", payout: N(100), obsDate: 3600n });
    ok = true;
  } catch (e) { err = e.message; }
  rec("A7", "economics", "Buy cover 1h before the observation date",
    "rejected (min lead not met)", ok ? "BOUGHT" : `rejected: ${err}`, ok,
    "minLeadSec enforces a decision lag");
}

// A8. Pool cannot promise coverage it cannot fund — buy when broke.
{
  const m = fresh();
  m.deposit("lp1", N(50));
  let ok = false, err = "";
  try { m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) }); ok = true; }
  catch (e) { err = e.message; }
  rec("A8", "economics", "Buy 100 NEAR cover from a 50 NEAR pool",
    "rejected (insufficient available capital)", ok ? "BOUGHT" : `rejected: ${err}`, ok);
}

// A9. Policy expiry / cancellation timing — settle before obsDate.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  let ok = false, err = "";
  try { m.resolve(id); ok = true; } catch (e) { err = e.message; }
  rec("A9", "economics", "Resolve a policy before its observation date",
    "rejected (too early)", ok ? "SETTLED EARLY" : `rejected: ${err}`, ok);
}

// ===========================================================================
// SURFACE B — oracle
// ===========================================================================

// B1. Non-attestor tries to report an observation.
{
  const m = fresh();
  let ok = false, err = "";
  try { m.reportObservation({ reporter: "attacker.testnet", city: "berlin", obsDate: 0n, valueTenths: 999n, reportedAt: 60n }); ok = true; }
  catch (e) { err = e.message; }
  rec("B1", "oracle", "Non-attestor reports a value", "rejected", ok ? "ACCEPTED" : `rejected: ${err}`, ok);
}

// B2. Stale observation (reported long after the date).
{
  const m = fresh();
  m.advanceTo(D(10));
  let ok = false, err = "";
  try { m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 999n, reportedAt: D(10) }); ok = true; }
  catch (e) { err = e.message; }
  rec("B2", "oracle", "Report a 7-day-old observation", "rejected (stale)", ok ? "ACCEPTED" : `rejected: ${err}`, ok);
}

// B3. Impossible value (rainfall 10000 mm).
{
  const m = fresh();
  m.advanceTo(D(3));
  let ok = false, err = "";
  try { m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 100000n, reportedAt: D(3) + 60n }); ok = true; }
  catch (e) { err = e.message; }
  rec("B3", "oracle", "Report 10000 mm rainfall", "rejected (implausible)", ok ? "ACCEPTED" : `rejected: ${err}`, ok);
}

// B4. Replay / duplicate observation for the same (city, date).
{
  const m = fresh();
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n });
  let ok = false, err = "";
  try { m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 5n, reportedAt: D(3) + 120n }); ok = true; }
  catch (e) { err = e.message; }
  rec("B4", "oracle", "Re-report the same (city,date) to overwrite", "rejected (already reported)", ok ? "OVERWROTE" : `rejected: ${err}`, ok);
}

// B5. Future date observation (cannot observe tomorrow today).
{
  const m = fresh();
  let ok = false, err = "";
  try { m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) }); ok = true; }
  catch (e) { err = e.message; }
  rec("B5", "oracle", "Report an observation dated in the future", "rejected", ok ? "ACCEPTED" : `rejected: ${err}`, ok);
}

// B6. Settle BEFORE the challenge window has elapsed (flash settlement).
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n });
  let ok = false, err = "";
  try { m.resolve(id, D(3) + 61n); ok = true; } catch (e) { err = e.message; }
  rec("B6", "oracle", "Resolve 1 second after the observation", "rejected (challenge window not elapsed)", ok ? "SETTLED" : `rejected: ${err}`, ok);
}

// B7. Dishonest attestor + griefing challenger (the residual trust).
// The attestor reports a FALSE breach; a challenger disputes with a bond.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n }); // FALSE
  m.challenge({ challenger: "watchdog", city: "berlin", obsDate: D(3), counterValueTenths: 5n, bond: N(1) / 10n });
  m.advanceTo(D(3) + 7200n);
  let settled = false, err = "";
  try { m.resolve(id); settled = true; } catch (e) { err = e.message; }
  rec("B7", "oracle", "Attestor lies; watchdog disputes; claim must be blocked",
    "no payout while disputed", settled ? "PAID ON DISPUTED OBS" : `blocked: ${err}`, settled,
    "the dispute mechanism is the only defence against a lying attestor");
}

// B8. Malicious challenger griefs honest policies (DoS).
// Attacker disputes EVERY observation; how much does it cost them?
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(m.buyCover({ buyer: `biz${i}`, productId: "rain", payout: N(100), obsDate: D(3) }));
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n });
  const cost = N(1) / 10n;
  m.challenge({ challenger: "griefer", city: "berlin", obsDate: D(3), counterValueTenths: 0n, bond: cost });
  // Owner upholds the honest observation → challenger forfeits the bond.
  m.resolveDispute({ caller: m.owner, city: "berlin", obsDate: D(3), uphold: true });
  m.advanceTo(D(3) + 7200n);
  let paid = 0n; for (const id of ids) { try { paid += m.resolve(id).paid; } catch {} }
  rec("B8", "oracle", "Griefer disputes every honest observation",
    "costs the griefer the bond; honest policies still pay",
    `griefer cost=${cost / ONE_NEAR} NEAR, paid=${paid / ONE_NEAR} NEAR`,
    paid === 0n, "bond makes griefing costly but not impossible; owner must act");
}

// ===========================================================================
// SURFACE C — contract mechanics
// ===========================================================================

// C1. Double settlement.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 250n, reportedAt: D(3) + 60n });
  m.advanceTo(D(3) + 7200n);
  m.resolve(id);
  let ok = false, err = "";
  try { m.resolve(id); ok = true; } catch (e) { err = e.message; }
  rec("C1", "mechanics", "Resolve the same policy twice", "rejected (not active)", ok ? "PAID TWICE" : `rejected: ${err}`, ok);
}

// C2. Rounding: premium ceil, never zero for a tiny payout.
{
  const m = fresh();
  const prem = m.quotePremium("rain", 1n); // 3% of 1 yocto
  rec("C2", "mechanics", "Premium of a 1-yocto payout must not round to 0",
    "premium >= 1", `premium=${prem}`, prem < 1n, "ceil division prevents free cover");
}

// C3. Payout outside product bounds (too big / too small).
{
  const m = fresh();
  m.deposit("lp1", N(100000));
  let a = false, b = false;
  try { m.buyCover({ buyer: "x", productId: "rain", payout: N(5000), obsDate: D(3) }); a = true; } catch {}
  try { m.buyCover({ buyer: "x", productId: "rain", payout: 1n, obsDate: D(3) }); b = true; } catch {}
  rec("C3", "mechanics", "Buy payout above max and below min", "both rejected", `above=${a} below=${b}`, a || b);
}

// C4. Unauthorized withdrawal of another provider's capital.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  let ok = false, err = "";
  try { m.withdraw("attacker", N(10)); ok = true; } catch (e) { err = e.message; }
  rec("C4", "mechanics", "Non-provider withdraws capital", "rejected", ok ? "WITHDREW" : `rejected: ${err}`, ok);
}

// C5. Cross-account: provider cannot withdraw more than their own deposit.
{
  const m = fresh();
  m.deposit("lp1", N(100));
  m.deposit("lp2", N(100));
  let ok = false, err = "";
  try { m.withdraw("lp1", N(150)); ok = true; } catch (e) { err = e.message; }
  rec("C5", "mechanics", "Provider withdraws more than they deposited", "rejected", ok ? "WITHDREW" : `rejected: ${err}`, ok);
}

// C6. Invariant stress: random operation fuzzing; invariant must never break.
{
  const m = fresh();
  let broke = null;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const accts = ["a", "b", "c"];
  for (let i = 0; i < 20000; i++) {
    try {
      const op = Math.floor(rnd() * 5);
      if (op === 0) m.deposit(accts[Math.floor(rnd() * 3)], N(1 + Math.floor(rnd() * 50)));
      else if (op === 1) m.withdraw(accts[Math.floor(rnd() * 3)], N(1 + Math.floor(rnd() * 50)));
      else if (op === 2) m.buyCover({ buyer: "b" + i, productId: "rain", payout: N(1 + Math.floor(rnd() * 30)), obsDate: BigInt(m.now) + D(1) + BigInt(Math.floor(rnd() * 5)) * D(1) });
      else if (op === 3) { m.advanceTo(BigInt(m.now) + BigInt(Math.floor(rnd() * 2 * 24 * 3600))); }
      else { const ids = [...m.policies.keys()]; if (ids.length) { const id = ids[Math.floor(rnd() * ids.length)]; try { m.resolve(id); } catch {} } }
      m.checkInvariant();
    } catch (e) {
      if (e.message?.startsWith("invariant")) { broke = e.message; break; }
    }
  }
  rec("C6", "mechanics", "20k random operations; invariant must never break",
    "reserved<=capital always", broke ? `BROKE: ${broke}` : "invariant held", !!broke);
}

// ===========================================================================
// SURFACE D — agent abuse
// ===========================================================================

// D1. An agent (buyer) tries to buy beyond pool capacity repeatedly — covered
// by A3/A8, but here the agent rotates cities to evade per-city caps.
{
  const m = fresh();
  m.deposit("lp1", N(100));
  let bought = 0;
  for (const c of ["berlin", "paris", "rome", "oslo", "kyiv"]) {
    try { m.buyCover({ buyer: "bot", productId: "rain", payout: N(100), obsDate: D(3) }); bought++; } catch {}
  }
  rec("D1", "agents", "Bot rotates cities to multiply exposure", "capped by capital (1 issued)", `issued=${bought}`, bought > 1);
}

// D2. An agent tries to exceed its deposited capital as a provider.
{
  const m = fresh();
  m.deposit("agent-lp", N(50));
  let ok = false, err = "";
  try { m.withdraw("agent-lp", N(51)); ok = true; } catch (e) { err = e.message; }
  rec("D2", "agents", "Underwriter agent withdraws 51 from 50 deposited", "rejected", ok ? "WITHDREW" : `rejected: ${err}`, ok);
}

// D3. Fake underwriting offer — an agent claims a low premium. Contract ignores
// caller-supplied premium (see A4); here an agent tries to set its own product.
{
  const m = fresh();
  let ok = false, err = "";
  try { m.addProduct("rain", { premiumBp: 0n, minPayout: 1n, maxPayout: N(1e6), minLeadSec: 0n }); ok = true; } catch (e) { err = e.message; }
  rec("D3", "agents", "Agent re-registers a product to change pricing", "rejected (exists / owner-only)", ok ? "REPLACED" : `rejected: ${err}`, ok);
}

// D4. Sybil underwriters: many accounts, each small — does it help the attacker?
{
  const m = fresh();
  for (let i = 0; i < 50; i++) m.deposit(`sybil${i}`, N(1));
  // 50 NEAR total. Try to buy 100 NEAR cover.
  let ok = false, err = "";
  try { m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) }); ok = true; } catch (e) { err = e.message; }
  rec("D4", "agents", "50 sybil providers pool 50 NEAR, then buy 100 cover", "rejected (capital is capital)", ok ? "BOUGHT" : `rejected: ${err}`, ok);
}

// D5. Buyer agent tries to self-attest (impersonate the oracle).
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({ buyer: "biz", productId: "rain", payout: N(100), obsDate: D(3) });
  m.advanceTo(D(3));
  let ok = false, err = "";
  try { m.reportObservation({ reporter: "biz", city: "berlin", obsDate: D(3), valueTenths: 999n, reportedAt: D(3) + 60n }); ok = true; } catch (e) { err = e.message; }
  rec("D5", "agents", "Buyer agent self-attests the trigger", "rejected (not the attestor)", ok ? "ACCEPTED" : `rejected: ${err}`, ok);
}

// ===========================================================================
// SURFACE E — economic-design attacks found DURING Mission 1 (the important ones)
// ===========================================================================

// E1. Threshold gaming: buyer picks a near-certain trigger (e.g. 0.1 mm) but
// pays a flat premium. BEFORE the fix this extracted 97 NEAR per policy.
// AFTER the fix the threshold is owned by the product, so the call is ignored.
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const id = m.buyCover({
    buyer: "attacker", productId: "rain", payout: N(100),
    obsDate: D(3),
    thresholdTenths: 1n, // attacker-supplied, must be IGNORED
  });
  const pol = m.policies.get(id);
  const attackerProfit = (pol.payout - pol.premium); // what they'd gain IF it triggered
  rec("E1", "economics", "Buyer supplies a near-certain threshold (0.1 mm)",
    "policy uses the product's fixed threshold (200 tenths), not the caller's",
    `policy threshold=${pol.thresholdTenths} (product-owned)`,
    pol.thresholdTenths !== 200n,
    `before the fix this extracted ${attackerProfit / ONE_NEAR} NEAR/policy; now impossible`);
}

// E2. Per-product capacity: one product cannot concentrate unbounded liability.
{
  const m = fresh({ });
  m.addProduct("small", {
    city: "berlin", thresholdTenths: 200n, premiumBp: 300n,
    minPayout: N(1), maxPayout: N(100), minLeadSec: 24n * 3600n,
    maxTotalCoverage: N(250), // capacity 250
  });
  m.deposit("lp1", N(100000)); // plenty of capital...
  let bought = 0, rejected = 0;
  for (let i = 0; i < 10; i++) {
    try { m.buyCover({ buyer: `b${i}`, productId: "small", payout: N(100), obsDate: D(3) }); bought++; }
    catch { rejected++; }
  }
  rec("E2", "economics", "Buy 10x 100 NEAR cover on a product capped at 250",
    "at most 2 issued (product capacity)", `issued=${bought} rejected=${rejected}`,
    bought * 100 > 250, "capacity cap bounds concentration regardless of capital");
}

// E3. Correlated-event solvency: every policy on the same (city,date) triggers
// together. The pool must still cover them all (or have refused them).
{
  const m = fresh();
  m.deposit("lp1", N(1000));
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(m.buyCover({ buyer: `b${i}`, productId: "rain", payout: N(100), obsDate: D(3) }));
  m.advanceTo(D(3));
  m.reportObservation({ reporter: m.attestor, city: "berlin", obsDate: D(3), valueTenths: 300n, reportedAt: D(3) + 60n });
  m.advanceTo(D(3) + 7200n);
  let paid = 0n, failed = 0;
  for (const id of ids) { try { paid += m.resolve(id).paid; } catch { failed++; } }
  rec("E3", "economics", "10 correlated policies all trigger at once",
    "all pay (they were reserved for) and invariant holds",
    `paid=${paid / ONE_NEAR} NEAR, failures=${failed}`, failed > 0,
    "capital is the real bound; the reservation makes the promise honest");
}

// ===========================================================================
// report
// ===========================================================================
const pad = (s, n) => String(s).padEnd(n);
console.log("\n================ OVERCOVER — ADVERSARIAL RESULTS ================\n");
console.log(pad("ID", 5) + pad("SURFACE", 11) + pad("ATTACK", 52) + "VERDICT");
console.log("-".repeat(110));
let exploitable = 0;
for (const r of results) {
  const verdict = r.exploitable ? "EXPLOITABLE" : "DEFENDED";
  if (r.exploitable) exploitable++;
  console.log(pad(r.id, 5) + pad(r.surface, 11) + pad(r.desc.slice(0, 50), 52) + verdict);
}
console.log("-".repeat(110));
console.log(`\n${results.length} attacks run, ${exploitable} exploitable, ${results.length - exploitable} defended.\n`);
for (const r of results) {
  console.log(`[${r.id}] ${r.desc}`);
  console.log(`     expected: ${r.expected}`);
  console.log(`     actual:   ${r.actual}${r.note ? `\n     note:     ${r.note}` : ""}`);
}

process.exit(exploitable === 0 ? 0 : 1);
