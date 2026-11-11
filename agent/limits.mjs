// Spending policy for the autonomous agent.
//
// This is pure logic: it takes a proposed purchase and the agent's current
// spending state and returns allow/deny with explicit reasons. It touches no
// network and holds no key, so it is exhaustively testable and is the single
// place that decides whether the agent may spend.
//
// Every limit is a hard ceiling. There is no override, no "force" flag, and no
// path that executes a purchase the engine refused.

export const DEFAULT_LIMITS = Object.freeze({
  enabled: true,
  maxPremiumPerPolicy: "50000000000000000000000", // 0.05 NEAR
  maxPayoutPerPolicy: "1000000000000000000000000", // 1 NEAR
  dailyPremiumBudget: "200000000000000000000000", // 0.2 NEAR / rolling 24h
  dailyPolicyLimit: 5,
  cooldownSec: 60,
  allowedProducts: [], // empty = any product the contract exposes
  allowedCities: [], // empty = any city
  minLeadSec: 0, // extra lead the agent requires on top of the product's
});

function toBig(v, name) {
  try {
    const b = BigInt(v);
    if (b < 0n) throw new Error();
    return b;
  } catch {
    throw new Error(`limit ${name} must be a non-negative integer, got ${JSON.stringify(v)}`);
  }
}

/** Validate a limits object and return a normalised copy. Throws on anything
 *  malformed so a bad config can never silently widen the agent's authority. */
export function normalizeLimits(input = {}) {
  const l = { ...DEFAULT_LIMITS, ...input };
  const out = {
    enabled: l.enabled !== false,
    maxPremiumPerPolicy: toBig(l.maxPremiumPerPolicy, "maxPremiumPerPolicy").toString(),
    maxPayoutPerPolicy: toBig(l.maxPayoutPerPolicy, "maxPayoutPerPolicy").toString(),
    dailyPremiumBudget: toBig(l.dailyPremiumBudget, "dailyPremiumBudget").toString(),
    dailyPolicyLimit: Number(l.dailyPolicyLimit),
    cooldownSec: Number(l.cooldownSec),
    allowedProducts: Array.isArray(l.allowedProducts) ? l.allowedProducts.map(String) : [],
    allowedCities: Array.isArray(l.allowedCities) ? l.allowedCities.map(String) : [],
    minLeadSec: Number(l.minLeadSec),
  };
  for (const k of ["dailyPolicyLimit", "cooldownSec", "minLeadSec"]) {
    if (!Number.isInteger(out[k]) || out[k] < 0) throw new Error(`limit ${k} must be a non-negative integer`);
  }
  return out;
}

/** Sum premium spent within the rolling window ending at `nowMs`. */
export function premiumSpentWithin(history, nowMs, windowMs) {
  return history
    .filter((h) => nowMs - h.atMs < windowMs && h.kind === "buy")
    .reduce((a, h) => a + BigInt(h.premiumYocto), 0n);
}

export function policiesWithin(history, nowMs, windowMs) {
  return history.filter((h) => nowMs - h.atMs < windowMs && h.kind === "buy").length;
}

export function lastBuyAtMs(history) {
  const buys = history.filter((h) => h.kind === "buy");
  return buys.length ? Math.max(...buys.map((h) => h.atMs)) : 0;
}

const DAY_MS = 24 * 3600 * 1000;

/** Extra NEAR the agent keeps above the premium so the transaction's gas and
 *  storage are covered even after the deposit leaves the account. A buy whose
 *  deposit would spend the account down to (or below) this margin is refused
 *  before it is signed, so the agent never sends a transaction it cannot pay
 *  for. 0.05 NEAR is far above the real cost of a `buy_cover` call. */
export const GAS_BUFFER_YOCTO = "50000000000000000000000";

/**
 * Serialize async critical sections: each task runs only after the previous one
 * has settled, in submission order. The spending limits are check-then-act
 * (read history, decide, then record), so two buys that overlap would both read
 * the same pre-buy history and both pass — letting the daily budget or policy
 * count be exceeded by concurrency. Passing every buy through one serializer
 * makes each buy see the effects of the previous one.
 *
 * A rejection never breaks the chain: the next task still runs.
 */
export function createSerializer() {
  let tail = Promise.resolve();
  return function run(fn) {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/** Return a human-readable reason if `balanceYocto` cannot cover `premiumYocto`
 *  plus `bufferYocto`, or null if it can. Pure: no network, so it is asserted
 *  directly in the tests. */
export function fundsShortfall(balanceYocto, premiumYocto, bufferYocto = GAS_BUFFER_YOCTO) {
  if (balanceYocto === null || balanceYocto === undefined) return "agent account balance is unknown";
  const required = BigInt(premiumYocto) + BigInt(bufferYocto);
  const balance = BigInt(balanceYocto);
  if (balance < required) {
    return `agent balance ${balance} is below premium + gas buffer ${required}`;
  }
  return null;
}

/**
 * Decide whether the agent may execute a purchase.
 *
 * @param {object} proposal  { productId, city, payoutYocto, premiumYocto, obsDateSec, nowSec }
 * @param {object} product   the contract product { min_payout, max_payout, min_lead_sec, active }
 * @param {object} ctx       { limits, history, nowMs }
 * @returns {{ allow: boolean, reasons: string[] }}
 */
export function evaluate(proposal, product, ctx) {
  const limits = ctx.limits;
  const nowMs = ctx.nowMs;
  const history = ctx.history ?? [];
  const reasons = [];

  if (!limits.enabled) reasons.push("agent is disabled");

  const premium = toBig(proposal.premiumYocto, "premium");
  const payout = toBig(proposal.payoutYocto, "payout");

  if (premium > BigInt(limits.maxPremiumPerPolicy)) {
    reasons.push(`premium ${premium} exceeds maxPremiumPerPolicy ${limits.maxPremiumPerPolicy}`);
  }
  if (payout > BigInt(limits.maxPayoutPerPolicy)) {
    reasons.push(`payout ${payout} exceeds maxPayoutPerPolicy ${limits.maxPayoutPerPolicy}`);
  }

  const spent = premiumSpentWithin(history, nowMs, DAY_MS);
  if (spent + premium > BigInt(limits.dailyPremiumBudget)) {
    reasons.push(`premium ${premium} would exceed dailyPremiumBudget (spent ${spent} of ${limits.dailyPremiumBudget} in 24h)`);
  }

  const count = policiesWithin(history, nowMs, DAY_MS);
  if (count + 1 > limits.dailyPolicyLimit) {
    reasons.push(`would exceed dailyPolicyLimit ${limits.dailyPolicyLimit} (already ${count} in 24h)`);
  }

  const last = lastBuyAtMs(history);
  if (last && nowMs - last < limits.cooldownSec * 1000) {
    const wait = Math.ceil((limits.cooldownSec * 1000 - (nowMs - last)) / 1000);
    reasons.push(`cooldown active, ${wait}s remaining`);
  }

  if (limits.allowedProducts.length && !limits.allowedProducts.includes(proposal.productId)) {
    reasons.push(`product ${proposal.productId} is not in allowedProducts`);
  }
  if (limits.allowedCities.length && !limits.allowedCities.includes(proposal.city)) {
    reasons.push(`city ${proposal.city} is not in allowedCities`);
  }

  if (product) {
    if (product.active === false) reasons.push("product is inactive");
    const min = BigInt(product.min_payout);
    const max = BigInt(product.max_payout);
    if (payout < min || payout > max) {
      reasons.push(`payout ${payout} outside product bounds ${min}..${max}`);
    }
    const requiredLead = Number(product.min_lead_sec) + limits.minLeadSec;
    if (proposal.obsDateSec < proposal.nowSec + requiredLead) {
      reasons.push(`observation date is less than ${requiredLead}s ahead`);
    }
  }

  return { allow: reasons.length === 0, reasons };
}
