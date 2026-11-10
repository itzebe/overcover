// Overcover — pure reference model of the mutual's accounting rules.
//
// This file is the executable SPEC for the Rust contract in
// contract/src/lib.rs. Every rule here is intended to be enforced on-chain;
// the adversarial suite (attacks.mjs) attacks THIS model, so that a flaw is
// found in a 5-second JS run rather than in a testnet deployment.
//
// Units:
//   * money is BigInt yoctoNEAR (1 NEAR = 1e24 yocto)
//   * time is Number seconds (the model has a manual clock; no wall time)
//   * rainfall is BigInt tenths of a millimetre (so 12.3 mm === 123n)
//
// Design principles:
//   1. The CONTRACT is the financial authority. Nothing an agent supplies is
//      trusted for balances, eligibility, truth or settlement.
//   2. Fail closed: when a rule cannot be shown to hold, reject.
//   3. One accounting invariant, checked after every mutation:
//        reserved <= capital   (the pool can always cover what it promised)

export class ContractError extends Error {}

export const ONE_NEAR = 10n ** 24n;

/** Coarse per-policy safety bounds. */
export const LIMITS = {
  // Rainfall sanity window: 0 .. 500.0 mm (in tenths). Anything outside is a
  // malformed/implausible observation and is rejected.
  MAX_RAINFALL_TENTHS: 5000n,
  // A product's premium is set by the contract (basis points of the payout),
  // never by a buyer or an underwriter.
  MAX_PREMIUM_BP: 5000n, // 50% cap, a hard ceiling
  // Observation for date D must be reported within this window after D.
  REPORT_MAX_DELAY_SEC: 24 * 3600,
};

export class Mutual {
  constructor({
    owner,
    attestor,
    challengeWindowSec = 3600,
    settleDelaySec = 0,
    challengeBond = 10n ** 23n, // 0.1 NEAR
    now = 0,
  }) {
    if (!owner || !attestor) throw new ContractError("owner and attestor required");
    this.owner = owner;
    this.attestor = attestor;
    this.challengeWindowSec = BigInt(challengeWindowSec);
    this.settleDelaySec = BigInt(settleDelaySec);
    this.challengeBond = BigInt(challengeBond);
    this.now = BigInt(now);

    this.products = new Map(); // id -> {premiumBp, minPayout, maxPayout, minLeadSec, active}
    this.providers = new Map(); // acct -> {deposited: BigInt, withdrawn: BigInt}
    this.policies = new Map(); // id -> policy
    this.observations = new Map(); // key -> {valueTenths, reportedAt, disputed, reportedBy}
    this.nextPolicyId = 1;

    // Pool-level accounting.
    this.capital = 0n; // deposits - withdrawals + premiums - payouts
    this.reserved = 0n; // sum of payouts of ACTIVE policies
    this.premiumsCollected = 0n;
    this.totalPaid = 0n;
  }

  // ---- invariant ---------------------------------------------------------
  /** The single safety property. Throws if the pool promises more than it holds. */
  checkInvariant() {
    if (this.reserved < 0n) throw new ContractError("invariant: reserved < 0");
    if (this.capital < 0n) throw new ContractError("invariant: capital < 0");
    if (this.reserved > this.capital) {
      throw new ContractError(
        `invariant: reserved ${this.reserved} > capital ${this.capital}`
      );
    }
    return true;
  }

  available() {
    return this.capital - this.reserved;
  }

  // ---- time --------------------------------------------------------------
  advanceTo(t) {
    if (BigInt(t) < this.now) throw new ContractError("time cannot go backwards");
    this.now = BigInt(t);
  }

  // ---- products ----------------------------------------------------------
  /** A product is an IMMUTABLE risk definition published by the contract.
   *  Crucially the THRESHOLD and the PREMIUM RATE live here, not in the buy
   *  call: a buyer cannot choose a near-certain trigger or a cheap price.
   *  (Adversarial finding E1 — see OVERCOVER_ADVERSARIAL_FEASIBILITY.md.) */
  addProduct(id, {
    city,
    thresholdTenths,
    premiumBp,
    minPayout,
    maxPayout,
    minLeadSec,
    maxTotalCoverage,
    active = true,
  }) {
    if (this.products.has(id)) throw new ContractError("product exists");
    if (BigInt(premiumBp) < 0n || BigInt(premiumBp) > LIMITS.MAX_PREMIUM_BP)
      throw new ContractError("premiumBp out of range");
    if (BigInt(minPayout) <= 0n || BigInt(maxPayout) < BigInt(minPayout))
      throw new ContractError("bad payout bounds");
    if (BigInt(thresholdTenths) < 0n || BigInt(thresholdTenths) > LIMITS.MAX_RAINFALL_TENTHS)
      throw new ContractError("threshold out of range");
    if (BigInt(maxTotalCoverage) < BigInt(maxPayout))
      throw new ContractError("capacity below a single max payout");
    this.products.set(id, {
      id,
      city,
      thresholdTenths: BigInt(thresholdTenths),
      premiumBp: BigInt(premiumBp),
      minPayout: BigInt(minPayout),
      maxPayout: BigInt(maxPayout),
      minLeadSec: BigInt(minLeadSec),
      maxTotalCoverage: BigInt(maxTotalCoverage),
      reserved: 0n, // outstanding liability for this product
      active,
    });
  }

  setProductActive(id, active) {
    const p = this.products.get(id);
    if (!p) throw new ContractError("no product");
    p.active = active;
  }

  // ---- capital -----------------------------------------------------------
  deposit(acct, amount) {
    amount = BigInt(amount);
    if (amount <= 0n) throw new ContractError("deposit must be > 0");
    const pr = this.providers.get(acct) ?? { deposited: 0n, withdrawn: 0n };
    pr.deposited += amount;
    this.providers.set(acct, pr);
    this.capital += amount;
    this.checkInvariant();
    return this.providerBalance(acct);
  }

  providerBalance(acct) {
    const pr = this.providers.get(acct);
    return pr ? pr.deposited - pr.withdrawn : 0n;
  }

  /** Withdraw is allowed only if (a) it is this provider's own capital and
   *  (b) the pool still covers every outstanding liability afterwards. */
  withdraw(acct, amount) {
    amount = BigInt(amount);
    if (amount <= 0n) throw new ContractError("withdraw must be > 0");
    const pr = this.providers.get(acct);
    if (!pr) throw new ContractError("not a provider");
    if (amount > pr.deposited - pr.withdrawn)
      throw new ContractError("withdraw exceeds own capital");
    if (this.capital - amount < this.reserved)
      throw new ContractError("withdraw would break solvency (funds reserved)");
    pr.withdrawn += amount;
    this.capital -= amount;
    this.checkInvariant();
    return this.providerBalance(acct);
  }

  // ---- pricing (deterministic, contract-owned) ---------------------------
  /** premium = ceil(payout * premiumBp / 10000). The buyer cannot pass this. */
  quotePremium(productId, payout) {
    const p = this.products.get(productId);
    if (!p) throw new ContractError("no product");
    payout = BigInt(payout);
    if (payout <= 0n) throw new ContractError("payout must be > 0");
    return (payout * p.premiumBp + 9999n) / 10000n;
  }

  // ---- policy issuance ---------------------------------------------------
  /** Issue a policy. The premium AND the trigger threshold come from the
   *  immutable product; the buyer chooses only the payout amount and the
   *  observation date. The payout is RESERVED and the product's capacity cap
   *  is enforced. Rejects unless the pool can fund it. */
  buyCover({ buyer, beneficiary, productId, payout, obsDate }) {
    const p = this.products.get(productId);
    if (!p) throw new ContractError("no product");
    if (!p.active) throw new ContractError("product inactive");
    payout = BigInt(payout);
    if (payout < p.minPayout || payout > p.maxPayout)
      throw new ContractError("payout outside product bounds");
    obsDate = BigInt(obsDate);
    // Anti-adverse-selection: the covered date must be far enough in the future.
    if (obsDate < this.now + p.minLeadSec)
      throw new ContractError("observation date too soon (min lead not met)");
    // Per-product capacity cap: total outstanding coverage cannot exceed the
    // cap, so a single product can never concentrate unlimited liability.
    if (p.reserved + payout > p.maxTotalCoverage)
      throw new ContractError("product capacity exceeded");

    const premium = this.quotePremium(productId, payout);

    // The pool must be able to fund the payout AFTER this reservation.
    if (this.available() < payout)
      throw new ContractError("insufficient available capital to underwrite");

    // Premium enters the pool first, then the payout is reserved.
    this.premiumsCollected += premium;
    this.capital += premium;

    const id = this.nextPolicyId++;
    this.policies.set(id, {
      id,
      buyer,
      beneficiary: beneficiary ?? buyer,
      productId,
      city: p.city,
      thresholdTenths: p.thresholdTenths,
      payout,
      premium,
      obsDate,
      issuedAt: this.now,
      status: "active",
    });
    this.reserved += payout;
    p.reserved += payout;
    this.checkInvariant();
    return id;
  }

  // ---- oracle ------------------------------------------------------------
  /** Register a signed observation. Key is `${city}|${obsDate}`.
   *  Only the registered attestor may report. The contract validates the
   *  value's range and that it is for a real, elapsed date. */
  reportObservation({ reporter, city, obsDate, valueTenths, reportedAt }) {
    if (reporter !== this.attestor) throw new ContractError("not the attestor");
    obsDate = BigInt(obsDate);
    reportedAt = BigInt(reportedAt);
    valueTenths = BigInt(valueTenths);
    if (obsDate > this.now) throw new ContractError("cannot observe a future date");
    if (reportedAt < obsDate) throw new ContractError("observation predates its date");
    if (reportedAt - obsDate > BigInt(LIMITS.REPORT_MAX_DELAY_SEC))
      throw new ContractError("observation reported too late (stale)");
    if (valueTenths < 0n || valueTenths > LIMITS.MAX_RAINFALL_TENTHS)
      throw new ContractError("implausible rainfall value");
    const key = `${city}|${obsDate}`;
    if (this.observations.has(key)) throw new ContractError("observation already reported");
    this.observations.set(key, {
      valueTenths,
      reportedAt,
      reportedBy: reporter,
      disputed: false,
      challenger: null,
      bond: 0n,
    });
    return key;
  }

  /** Dispute an observation before it settles a payout. A dispute is BONDED:
   *  a frivolous challenger loses their bond to the pool; a genuine one that
   *  the owner does not rebut nullifies the observation (fail closed — no
   *  payout). This makes griefing costly rather than free. */
  challenge({ challenger, city, obsDate, counterValueTenths, bond }) {
    const key = `${city}|${BigInt(obsDate)}`;
    const o = this.observations.get(key);
    if (!o) throw new ContractError("no such observation");
    if (o.disputed) throw new ContractError("already disputed");
    bond = BigInt(bond);
    if (bond < this.challengeBond)
      throw new ContractError("challenge bond too small");
    o.disputed = true;
    o.challenger = challenger;
    o.counterValueTenths = BigInt(counterValueTenths);
    o.bond = bond;
    o.challengedAt = this.now;
    this.capital += bond; // held; released or forfeited on resolution
    this.checkInvariant();
    return key;
  }

  /** Owner resolves a dispute. `uphold=true` keeps the observation (challenger
   *  forfeits the bond to the pool). `uphold=false` nullifies it. If neither
   *  happens within the challenge window, `observationValid` fails closed. */
  resolveDispute({ caller, city, obsDate, uphold }) {
    if (caller !== this.owner) throw new ContractError("only owner resolves disputes");
    const o = this.observations.get(`${city}|${BigInt(obsDate)}`);
    if (!o || !o.disputed) throw new ContractError("no open dispute");
    if (uphold) {
      o.disputed = false;
      o.bond = 0n; // bond stays in the pool
      o.resolvedUpheld = true;
    } else {
      o.nullified = true;
      // refund the challenger's bond
      this.capital -= o.bond;
      o.bond = 0n;
      o.resolvedNullified = true;
    }
    this.checkInvariant();
    return uphold;
  }

  observationValid(city, obsDate, atTime) {
    const key = `${city}|${BigInt(obsDate)}`;
    const o = this.observations.get(key);
    if (!o) return { ok: false, reason: "no observation" };
    if (o.nullified) return { ok: false, reason: "observation nullified" };
    if (o.disputed) {
      // An unresolved dispute past its window fails closed.
      return { ok: false, reason: "observation disputed (unresolved)" };
    }
    if (atTime < o.reportedAt + this.challengeWindowSec)
      return { ok: false, reason: "challenge window not elapsed" };
    return { ok: true, value: o.valueTenths };
  }

  // ---- settlement --------------------------------------------------------
  /** Settle a policy exactly once, after its observation date. Pays iff the
   *  validated observation meets the threshold. */
  resolve(policyId, atTime = null) {
    const pol = this.policies.get(policyId);
    if (!pol) throw new ContractError("no policy");
    if (pol.status !== "active") throw new ContractError("policy not active");
    const t = atTime === null ? this.now : BigInt(atTime);
    if (t < pol.obsDate + this.settleDelaySec)
      throw new ContractError("too early to settle");

    const obs = this.observationValid(pol.city, pol.obsDate, t);
    if (!obs.ok) throw new ContractError(`cannot settle: ${obs.reason}`);

    const triggered = obs.value >= pol.thresholdTenths;
    // Release the reservation exactly once, in both outcomes.
    this.reserved -= pol.payout;
    const prod = this.products.get(pol.productId);
    if (prod) prod.reserved -= pol.payout;
    if (triggered) {
      if (pol.payout > this.capital) throw new ContractError("payout exceeds capital");
      this.capital -= pol.payout;
      this.totalPaid += pol.payout;
      pol.status = "settled_paid";
      pol.paidAmount = pol.payout;
    } else {
      pol.status = "settled_no_pay";
      pol.paidAmount = 0n;
    }
    pol.settledAt = t;
    pol.observedValue = obs.value;
    this.checkInvariant();
    return { triggered, paid: pol.paidAmount };
  }
}

// A convenience snapshot for reports and the UI.
export function snapshot(m) {
  return {
    now: m.now.toString(),
    capital: m.capital.toString(),
    reserved: m.reserved.toString(),
    available: m.available().toString(),
    premiumsCollected: m.premiumsCollected.toString(),
    totalPaid: m.totalPaid.toString(),
    policies: [...m.policies.values()].map((p) => ({
      id: p.id,
      status: p.status,
      payout: p.payout.toString(),
      premium: p.premium.toString(),
      obsDate: p.obsDate.toString(),
    })),
  };
}
