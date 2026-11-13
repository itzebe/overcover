// Overcover — deterministic reference model of the DECENTRALIZED contract.
//
// This is the executable spec for `contract/src/lib.rs` (v2). It mirrors the
// on-chain rules exactly, but runs in a few seconds with a manual clock and no
// network, so a design flaw is found here rather than in a testnet deployment.
//
// Everything in this module is SIMULATED. No function here touches the chain,
// and nothing it produces may be presented as a real NEAR transaction.
//
// Units: money is BigInt yoctoNEAR; time is a manual integer clock (seconds);
// measured values are integers scaled by the metric's `scale`.
//
// Signatures are REAL ed25519 (node:crypto) over the same canonical message the
// contract builds, so signature binding, cross-product replay and cross-contract
// replay are genuinely exercised rather than stubbed.

import crypto from "node:crypto";

export const ONE_NEAR = 10n ** 24n;
export const DISPUTE_OPEN = Number.MAX_SAFE_INTEGER;
/// Canonical domain tag for an oracle reading (mirrors the contract's
/// `READING_DOMAIN`). Binds the contract, the schema version and the field set.
export const READING_DOMAIN = "overcover:v3:observation";
/// Longest validity an operator may claim for a reading (mirrors the contract).
export const READING_MAX_VALIDITY_SEC = 7 * 24 * 3600;
/// Cap on the challenge window (mirrors the contract's CHALLENGE_WINDOW_MAX_SEC).
export const CHALLENGE_WINDOW_MAX_SEC = 7 * 24 * 3600;
/// Cap on the off-chain evidence reference (mirrors the contract).
export const MAX_EVIDENCE_BYTES = 128;
/// Longest delay between a reading's date and its report (mirrors the
/// contract's REPORT_MAX_DELAY_SEC). Past this, a missing reading is terminal.
export const REPORT_MAX_DELAY_SEC = BigInt(24 * 3600);

export class ContractError extends Error {}

// ---- ed25519 helpers -------------------------------------------------------

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Deterministic ed25519 key pair from a single seed byte (tests only). */
export function keyPairFromSeed(seed) {
  const seedBuf = Buffer.alloc(32, seed & 0xff);
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seedBuf]),
    format: "der",
    type: "pkcs8",
  });
  const pub = crypto
    .createPublicKey(priv)
    .export({ format: "der", type: "spki" })
    .subarray(SPKI_ED25519.length);
  return { priv, pub };
}

export function sign(priv, msg) {
  return crypto.sign(null, msg, priv);
}

export function verify(pubRaw, msg, sig) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519, pubRaw]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, msg, key, sig);
}

// ---- the model -------------------------------------------------------------

export class Decentralized {
  constructor({
    owner,
    challengeBond = ONE_NEAR / 10n,
    settleDelaySec = 0,
    challengeWindowSec = 3600,
    quorum = 3,
    resolverQuorum = 3,
    disputeWindowSec = 3600,
    now = 0,
    contractId = "contract.ovc-v3-ctl-2f6c4c.testnet",
  } = {}) {
    if (!owner) throw new ContractError("owner required");
    this.owner = owner;
    this.contractId = contractId;
    this.challengeBond = BigInt(challengeBond);
    this.settleDelaySec = BigInt(settleDelaySec);
    this.challengeWindowSec = BigInt(challengeWindowSec);
    this.quorum = quorum;
    this.resolverQuorum = resolverQuorum;
    this.disputeWindowSec = BigInt(disputeWindowSec);
    this.now = BigInt(now);

    this.metrics = new Map();
    this.products = new Map();
    this.providers = new Map();
    this.policies = new Map();
    this.operators = new Map();
    this.readings = new Map();
    this.signers = new Map();
    this.observations = new Map();
    this.disputes = new Map();
    this.resolvers = new Map();
    this.disputeVotes = new Map();
    this.nextPolicyId = 1;

    this.capital = 0n;
    this.reserved = 0n;
    this.heldBonds = 0n;
    this.totalDeposited = 0n;
    this.totalWithdrawn = 0n;
    this.premiumsCollected = 0n;
    this.totalPaid = 0n;
    this.bondsForfeited = 0n;
    this.events = [];
  }

  // ---- invariant ---------------------------------------------------------

  checkInvariant() {
    if (this.reserved < 0n) throw new ContractError("invariant: reserved < 0");
    if (this.capital < 0n) throw new ContractError("invariant: capital < 0");
    if (this.reserved > this.capital)
      throw new ContractError(`invariant: reserved ${this.reserved} > capital ${this.capital}`);
    return true;
  }

  available() {
    return this.capital - this.reserved;
  }

  reconcile() {
    const expected =
      this.totalDeposited - this.totalWithdrawn + this.premiumsCollected +
      this.bondsForfeited - this.totalPaid;
    return expected === this.capital;
  }

  advanceTo(t) {
    if (BigInt(t) < this.now) throw new ContractError("time cannot go backwards");
    this.now = BigInt(t);
  }

  _log(kind, data = {}) {
    this.events.push({ at: Number(this.now), kind, ...data });
  }

  // ---- metrics / products ------------------------------------------------

  addMetric(id, { category, unit, maxValue, scale = 10, direction = "above", active = true }) {
    if (this.metrics.has(id)) throw new ContractError("metric exists");
    if (BigInt(maxValue) <= 0n) throw new ContractError("maxValue must be > 0");
    if (!(scale > 0)) throw new ContractError("scale must be > 0");
    this.metrics.set(id, { id, category, unit, maxValue: BigInt(maxValue), scale, direction, active });
  }

  metricSpec(metricId) {
    if (metricId === "" || metricId == null) {
      return { maxValue: 5000n, scale: 10, direction: "above" };
    }
    const m = this.metrics.get(metricId);
    if (!m) throw new ContractError("no such metric");
    if (!m.active) throw new ContractError("metric is inactive");
    return { maxValue: m.maxValue, scale: m.scale, direction: m.direction };
  }

  _insertProduct(id, { city, metricId, category, threshold, premiumBp, minPayout, maxPayout, minLeadSec, maxCapacity }) {
    if (this.products.has(id)) throw new ContractError("product exists");
    if (BigInt(premiumBp) > 5000n) throw new ContractError("premiumBp too high");
    if (BigInt(minPayout) <= 0n || BigInt(maxPayout) < BigInt(minPayout))
      throw new ContractError("bad payout bounds");
    if (BigInt(maxCapacity) < BigInt(maxPayout)) throw new ContractError("capacity below a single max payout");
    this.products.set(id, {
      id, city, metricId, category,
      threshold: BigInt(threshold),
      premiumBp: BigInt(premiumBp),
      minPayout: BigInt(minPayout),
      maxPayout: BigInt(maxPayout),
      minLeadSec: BigInt(minLeadSec),
      maxCapacity: BigInt(maxCapacity),
      reserved: 0n,
      active: true,
    });
  }

  addProduct(id, opts) {
    if (BigInt(opts.thresholdTenths) > 5000n) throw new ContractError("threshold out of range");
    this._insertProduct(id, {
      city: opts.city, metricId: "", category: "precipitation",
      threshold: opts.thresholdTenths, premiumBp: opts.premiumBp,
      minPayout: opts.minPayout, maxPayout: opts.maxPayout,
      minLeadSec: opts.minLeadSec, maxCapacity: opts.maxTotalCoverage,
    });
  }

  addMetricProduct(id, opts) {
    const spec = this.metricSpec(opts.metricId);
    if (BigInt(opts.thresholdTenths) > spec.maxValue) throw new ContractError("threshold above metric maxValue");
    const m = this.metrics.get(opts.metricId);
    this._insertProduct(id, {
      city: opts.city, metricId: opts.metricId, category: m.category,
      threshold: opts.thresholdTenths, premiumBp: opts.premiumBp,
      minPayout: opts.minPayout, maxPayout: opts.maxPayout,
      minLeadSec: opts.minLeadSec, maxCapacity: opts.maxTotalCoverage,
    });
  }

  setProductActive(id, active) {
    const p = this.products.get(id);
    if (!p) throw new ContractError("no product");
    p.active = active;
  }

  // ---- operators ---------------------------------------------------------

  addOperator(account, pubRaw) {
    if (this.operators.has(account)) throw new ContractError("operator already registered");
    if (pubRaw.length !== 32) throw new ContractError("operator key must be 32 bytes");
    this.operators.set(account, { pub: pubRaw, active: true, readings: 0 });
  }

  revokeOperator(account) {
    const op = this.operators.get(account);
    if (!op) throw new ContractError("no such operator");
    if (!op.active) throw new ContractError("operator already revoked");
    op.active = false;
  }

  rotateOperatorKey(account, newPub) {
    const op = this.operators.get(account);
    if (!op) throw new ContractError("no such operator");
    if (newPub.length !== 32) throw new ContractError("operator key must be 32 bytes");
    op.pub = newPub;
  }

  setQuorum(q) {
    if (q < 1) throw new ContractError("quorum must be >= 1");
    this.quorum = q;
  }

  activeOperatorCount() {
    return [...this.operators.values()].filter((o) => o.active).length;
  }

  // ---- resolvers ---------------------------------------------------------

  addResolver(account) {
    if (account === this.owner) throw new ContractError("the owner may not be a dispute resolver");
    if (this.resolvers.has(account)) throw new ContractError("resolver already registered");
    this.resolvers.set(account, { active: true, owner: this.owner });
  }

  revokeResolver(account) {
    const r = this.resolvers.get(account);
    if (!r) throw new ContractError("no such resolver");
    r.active = false;
  }

  setResolverQuorum(q) {
    if (q < 1) throw new ContractError("resolver quorum must be >= 1");
    this.resolverQuorum = q;
  }

  /// Cap mirrors the contract's CHALLENGE_WINDOW_MAX_SEC: an unbounded window
  /// could freeze a pool forever. Recorded per policy/observation at creation.
  setChallengeWindow(secs) {
    secs = BigInt(secs);
    if (secs > BigInt(CHALLENGE_WINDOW_MAX_SEC)) throw new ContractError("challenge window above maximum");
    this.challengeWindowSec = secs;
  }

  setDisputeWindow(secs) {
    this.disputeWindowSec = BigInt(secs);
  }

  // ---- capital -----------------------------------------------------------

  deposit(acct, amount) {
    amount = BigInt(amount);
    if (amount <= 0n) throw new ContractError("deposit must be > 0");
    const pr = this.providers.get(acct) ?? { deposited: 0n, withdrawn: 0n };
    pr.deposited += amount;
    this.providers.set(acct, pr);
    this.capital += amount;
    this.totalDeposited += amount;
    this.checkInvariant();
    this._log("deposit", { account: acct, amount: amount.toString() });
    return this.providerBalance(acct);
  }

  providerBalance(acct) {
    const pr = this.providers.get(acct);
    return pr ? pr.deposited - pr.withdrawn : 0n;
  }

  withdraw(acct, amount) {
    amount = BigInt(amount);
    if (amount <= 0n) throw new ContractError("withdraw must be > 0");
    const pr = this.providers.get(acct);
    if (!pr) throw new ContractError("not a provider");
    if (amount > pr.deposited - pr.withdrawn) throw new ContractError("withdraw exceeds own capital");
    if (this.capital - amount < this.reserved)
      throw new ContractError("withdraw would break solvency (funds reserved)");
    pr.withdrawn += amount;
    this.capital -= amount;
    this.totalWithdrawn += amount;
    this.checkInvariant();
    this._log("withdraw", { account: acct, amount: amount.toString() });
    return this.providerBalance(acct);
  }

  // ---- pricing -----------------------------------------------------------

  quotePremium(productId, payout) {
    const p = this.products.get(productId);
    if (!p) throw new ContractError("no product");
    payout = BigInt(payout);
    if (payout <= 0n) throw new ContractError("payout must be > 0");
    return (payout * p.premiumBp + 9999n) / 10000n;
  }

  // ---- policy issuance ---------------------------------------------------

  buyCover({ buyer, beneficiary, productId, payout, obsDate }) {
    const p = this.products.get(productId);
    if (!p) throw new ContractError("no product");
    if (!p.active) throw new ContractError("product inactive");
    payout = BigInt(payout);
    if (payout < p.minPayout || payout > p.maxPayout) throw new ContractError("payout outside product bounds");
    obsDate = BigInt(obsDate);
    if (obsDate < this.now + p.minLeadSec) throw new ContractError("observation date too soon (min lead not met)");
    if (p.reserved + payout > p.maxCapacity) throw new ContractError("product capacity exceeded");
    const premium = this.quotePremium(productId, payout);
    if (this.available() < payout) throw new ContractError("insufficient available capital to underwrite");

    this.premiumsCollected += premium;
    this.capital += premium;

    const id = this.nextPolicyId++;
    const direction = this.metricSpec(p.metricId).direction;
    this.policies.set(id, {
      id, buyer, beneficiary: beneficiary ?? buyer, productId,
      city: p.city, metricId: p.metricId, direction,
      threshold: p.threshold, payout, premium, obsDate,
      challengeWindowSec: this.challengeWindowSec,
      issuedAt: this.now, status: "active", paidAmount: 0n, observedValue: 0n, settledAt: 0n,
    });
    this.reserved += payout;
    p.reserved += payout;
    this.checkInvariant();
    this._log("policy_issued", { id, buyer, payout: payout.toString(), premium: premium.toString() });
    return id;
  }

  // ---- oracle ------------------------------------------------------------

  obsKey(metricId, city, date) {
    return `${metricId}|${city}|${BigInt(date)}`;
  }

  readingKey(metricId, city, date, operator) {
    return `${metricId}|${city}|${BigInt(date)}|${operator}`;
  }

  readingMessage(operator, metricId, city, obsDate, value, reportedAt, expiry, evidence, nonce) {
    const ev = Buffer.isBuffer(evidence) ? evidence : Buffer.from(evidence || []);
    const head = [
      READING_DOMAIN, this.contractId, operator, metricId, city,
      BigInt(obsDate), BigInt(value), BigInt(reportedAt), BigInt(expiry), BigInt(nonce),
    ].join("|");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ev.length, 0);
    return Buffer.concat([Buffer.from(head, "utf8"), Buffer.from("|", "utf8"), len, ev]);
  }

  submitReading({ operator, metricId, city, obsDate, value, reportedAt, expiry, evidenceHash, signature, nonce }) {
    const op = this.operators.get(operator);
    if (!op) throw new ContractError("caller is not a registered operator");
    if (!op.active) throw new ContractError("operator is revoked");
    const spec = this.metricSpec(metricId);
    const n = nonce === undefined ? op.readings : Number(nonce);
    const evidence = Buffer.isBuffer(evidenceHash) ? evidenceHash : Buffer.from(evidenceHash || []);
    if (evidence.length > MAX_EVIDENCE_BYTES) throw new ContractError("evidence reference too large");
    const msg = this.readingMessage(operator, metricId, city, BigInt(obsDate), BigInt(value), BigInt(reportedAt), BigInt(expiry), evidence, n);
    if (!signature || signature.length !== 64) throw new ContractError("signature must be 64 bytes");
    if (!verify(op.pub, msg, signature)) throw new ContractError("invalid operator signature");
    if (n !== op.readings) throw new ContractError("stale operator nonce (replay)");

    obsDate = BigInt(obsDate);
    reportedAt = BigInt(reportedAt);
    expiry = BigInt(expiry);
    value = BigInt(value);
    if (obsDate > this.now) throw new ContractError("cannot observe a future date");
    if (reportedAt < obsDate) throw new ContractError("observation predates its date");
    if (reportedAt - obsDate > 86400n) throw new ContractError("observation reported too late (stale)");
    if (reportedAt > this.now) throw new ContractError("observation reported in the future");
    if (value > spec.maxValue) throw new ContractError("value above metric plausibility bound");
    if (expiry <= this.now) throw new ContractError("observation already expired");
    if (expiry > reportedAt + BigInt(READING_MAX_VALIDITY_SEC)) throw new ContractError("expiry too far in the future");

    const okey = this.obsKey(metricId, city, obsDate);
    const rkey = this.readingKey(metricId, city, obsDate, operator);
    if (this.readings.has(rkey)) throw new ContractError("operator already reported for this date");

    op.readings += 1;
    this.readings.set(rkey, { operator, value, reportedAt, expiry, evidence, nonce: n });
    if (!this.signers.has(okey)) this.signers.set(okey, new Set());
    this.signers.get(okey).add(operator);

    const count = this.signers.get(okey).size;
    this._log("reading_submitted", { metric: metricId, city, date: Number(obsDate), operator, count });

    if (!this.observations.has(okey) && count >= this.quorum) {
      return this._tryFinalize(metricId, city, obsDate, okey);
    }
    return this.observations.get(okey)?.quorum ?? 0;
  }

  _tryFinalize(metricId, city, obsDate, okey) {
    const signers = this.signers.get(okey);
    if (!signers) return 0;
    const spec = this.metricSpec(metricId);
    const tolerance = BigInt(Math.max(1, spec.scale));

    let best = null;
    for (const acct of signers) {
      const r = this.readings.get(this.readingKey(metricId, city, obsDate, acct));
      if (!r) continue;
      let support = 0;
      for (const other of signers) {
        const or = this.readings.get(this.readingKey(metricId, city, obsDate, other));
        if (!or) continue;
        const diff = or.value >= r.value ? or.value - r.value : r.value - or.value;
        if (diff <= tolerance) support += 1;
      }
      if (!best || support > best.support || (support === best.support && r.value < best.value)) {
        best = { value: r.value, support };
      }
    }
    if (!best || best.support < this.quorum) return 0;

    let reportedAt = 0n;
    let expiry = null;
    let evidence = null;
    const confirmed = [];
    for (const acct of signers) {
      const or = this.readings.get(this.readingKey(metricId, city, obsDate, acct));
      if (!or) continue;
      const diff = or.value >= best.value ? or.value - best.value : best.value - or.value;
      if (diff <= tolerance) {
        reportedAt = reportedAt > or.reportedAt ? reportedAt : or.reportedAt;
        expiry = expiry === null || or.expiry < expiry ? or.expiry : expiry;
        if (or.value === best.value && (evidence === null || Buffer.compare(or.evidence, evidence) < 0)) {
          evidence = or.evidence;
        }
        confirmed.push(acct);
      }
    }

    this.observations.set(okey, {
      metricId, city, obsDate, value: best.value, reportedAt,
      challengeWindowSec: this.challengeWindowSec,
      expiry: expiry ?? 0n, evidence: evidence ?? Buffer.alloc(0),
      quorum: best.support, signers: confirmed,
      disputed: false, nullified: false, challenger: null, counterValue: 0n, bond: 0n,
    });
    this._log("observation_finalized", { metric: metricId, city, date: Number(obsDate), value: best.value.toString(), quorum: best.support });
    return best.support;
  }

  // ---- disputes ----------------------------------------------------------

  challenge({ challenger, metricId, city, obsDate, counterValueTenths = 0, bond }) {
    bond = BigInt(bond ?? 0n);
    if (bond < this.challengeBond) throw new ContractError("challenge bond too small");
    const okey = this.obsKey(metricId, city, obsDate);
    const o = this.observations.get(okey);
    if (!o) throw new ContractError("no such observation");
    if (o.disputed) throw new ContractError("observation already disputed");
    if (o.nullified) throw new ContractError("observation already nullified");
    if (this.now >= o.reportedAt + o.challengeWindowSec) throw new ContractError("challenge window has elapsed");

    o.disputed = true;
    o.challenger = challenger;
    o.counterValue = BigInt(counterValueTenths);
    o.bond = bond;
    this.disputes.set(okey, {
      okey, metricId, city, obsDate, value: o.value, signers: o.signers.slice(),
      openedAt: Number(this.now), challenger, counterValue: BigInt(counterValueTenths), bond,
      threshold: this.resolverQuorum,
      resolvedAt: DISPUTE_OPEN, uphold: false, upheldVotes: 0, nullifiedVotes: 0,
    });
    this.disputeVotes.set(okey, new Map());
    this.heldBonds += bond;
    this._log("observation_challenged", { city, date: Number(obsDate), challenger });
    return okey;
  }

  resolverVote({ resolver, metricId, city, obsDate, uphold }) {
    if (resolver === this.owner) throw new ContractError("the owner may not vote on a dispute");
    const r = this.resolvers.get(resolver);
    if (!r) throw new ContractError("not a registered resolver");
    if (!r.active) throw new ContractError("resolver is revoked");
    if (r.owner === this.owner && resolver === this.owner) throw new ContractError("the owner may not vote on a dispute");
    const okey = this.obsKey(metricId, city, obsDate);
    const d = this.disputes.get(okey);
    if (!d) throw new ContractError("no dispute slot");
    if (d.resolvedAt !== DISPUTE_OPEN) throw new ContractError("dispute already resolved");
    if (d.signers.includes(resolver)) throw new ContractError("an operator that signed the reading may not resolve it");
    if (d.challenger === resolver) throw new ContractError("the challenger may not resolve their own dispute");
    const votes = this.disputeVotes.get(okey);
    if (votes.has(resolver)) throw new ContractError("resolver already voted");
    votes.set(resolver, !!uphold);
    if (uphold) d.upheldVotes += 1; else d.nullifiedVotes += 1;
    this._log("dispute_vote", { city, date: Number(obsDate), resolver, uphold: !!uphold });
    // Decide against the threshold frozen when the dispute opened.
    if (d.upheldVotes >= d.threshold || d.nullifiedVotes >= d.threshold) {
      this._finalizeDispute(okey, d.upheldVotes >= d.threshold);
    }
  }

  timeoutDispute({ metricId, city, obsDate }) {
    const okey = this.obsKey(metricId, city, obsDate);
    const d = this.disputes.get(okey);
    if (!d) throw new ContractError("no dispute slot");
    if (d.resolvedAt !== DISPUTE_OPEN) throw new ContractError("dispute already resolved");
    if (this.now < BigInt(d.openedAt) + this.disputeWindowSec) throw new ContractError("dispute window has not elapsed");
    this._finalizeDispute(okey, false);
    this._log("dispute_timed_out", { city, date: Number(obsDate) });
  }

  _finalizeDispute(okey, uphold) {
    const d = this.disputes.get(okey);
    const bond = d.bond;
    d.resolvedAt = Number(this.now);
    d.uphold = uphold;
    const o = this.observations.get(okey);
    if (uphold) {
      o.disputed = false;
      o.bond = 0n;
      this.capital += bond;
      this.bondsForfeited += bond;
    } else {
      o.nullified = true;
      o.disputed = false;
      o.bond = 0n;
      // Refund the challenger; honest disagreement is never slashed.
    }
    this.heldBonds -= bond;
    this.checkInvariant();
    this._log("dispute_resolved", { uphold });
  }

  // Classify the observation at settlement time. `Blocked` is transient (the
  // reservation must be held); `Invalid` is terminal (the reservation must be
  // released so a dead policy cannot lock capital forever).
  observationValid(metricId, city, obsDate, window, at) {
    const o = this.observations.get(this.obsKey(metricId, city, obsDate));
    if (!o) {
      // A reading for date D may be submitted at wall-clock `at` while
      // D <= reportedAt <= at and reportedAt - D <= REPORT_MAX_DELAY_SEC, and it
      // must be unexpired at submission. Because reportedAt may be BACKDATED, the
      // last instant a reading can still be accepted is
      // D + REPORT_MAX_DELAY_SEC + READING_MAX_VALIDITY_SEC. Past that the key is
      // terminally empty (release); before it, hold — releasing earlier would deny
      // a payout a still-admissible late reading would have won.
      const lastPossible = BigInt(obsDate) + REPORT_MAX_DELAY_SEC + BigInt(READING_MAX_VALIDITY_SEC);
      return BigInt(at) > lastPossible
        ? { ok: false, kind: "invalid", reason: "no reading was ever reported" }
        : { ok: false, kind: "blocked", reason: "no observation" };
    }
    if (o.disputed) return { ok: false, kind: "blocked", reason: "observation disputed (unresolved)" };
    if (o.nullified) return { ok: false, kind: "invalid", reason: "observation nullified" };
    if (BigInt(at) < o.reportedAt + window) return { ok: false, kind: "blocked", reason: "challenge window not elapsed" };
    if (o.expiry > 0n && BigInt(at) > o.expiry) return { ok: false, kind: "invalid", reason: "observation expired" };
    return { ok: true, value: o.value };
  }

  // ---- settlement --------------------------------------------------------

  resolve(policyId, atTime = null) {
    const pol = this.policies.get(policyId);
    if (!pol) throw new ContractError("no policy");
    if (pol.status !== "active") throw new ContractError("policy not active");
    const t = atTime === null ? this.now : BigInt(atTime);
    if (t < pol.obsDate + this.settleDelaySec) throw new ContractError("too early to settle");
    const obs = this.observationValid(pol.metricId, pol.city, pol.obsDate, pol.challengeWindowSec, t);
    if (!obs.ok && obs.kind === "blocked") throw new ContractError(`cannot settle: ${obs.reason}`);

    // A terminal-invalid reading settles no-pay; a valid one follows the trigger.
    const triggered = obs.ok && (pol.direction === "below" ? obs.value <= pol.threshold : obs.value >= pol.threshold);
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
    pol.observedValue = obs.ok ? obs.value : 0n;
    this.checkInvariant();
    this._log("policy_settled", { id: policyId, triggered, paid: pol.paidAmount.toString(), value: pol.observedValue.toString() });
    return { triggered, paid: pol.paidAmount };
  }

  // ---- views -------------------------------------------------------------

  getPool() {
    return {
      capital: this.capital, reserved: this.reserved, available: this.available(),
      heldBonds: this.heldBonds, premiumsCollected: this.premiumsCollected,
      totalPaid: this.totalPaid, totalDeposited: this.totalDeposited,
      totalWithdrawn: this.totalWithdrawn, bondsForfeited: this.bondsForfeited,
      policyCount: this.policies.size, solvent: this.reserved <= this.capital,
    };
  }

  getProduct(id) {
    return this.products.get(id);
  }

  getPolicy(id) {
    return this.policies.get(id);
  }

  getObservation(metricId, city, obsDate) {
    return this.observations.get(this.obsKey(metricId, city, obsDate));
  }

  getDispute(metricId, city, obsDate) {
    return this.disputes.get(this.obsKey(metricId, city, obsDate));
  }
}
