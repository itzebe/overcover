// High-level Overcover actions over the NEAR testnet contract.
// Every function performs a real on-chain call and returns { hash, outcome }.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { call, view, toYocto, txHash, loadIdentities, loadState } from "./near.js";
import { signReading } from "./attestor.js";
import { observe } from "./adapters.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(root, "demo-log.json");

export function contractId() {
  return loadState().contractId ?? loadIdentities().owner.accountId;
}

/** The owner (admin) account, used to sign owner-only calls. */
export function ownerId() {
  return loadIdentities().owner.accountId;
}

/** Operator roles (the oracle quorum), in registration order. */
export function operatorRoles() {
  const ids = loadIdentities();
  return ["operator1", "operator2", "operator3"].filter((r) => ids[r]?.accountId);
}

/** Resolver roles (the independent dispute quorum). */
export function resolverRoles() {
  const ids = loadIdentities();
  return ["resolver1", "resolver2", "resolver3"].filter((r) => ids[r]?.accountId);
}

export function logTx(label, outcome, extra = {}) {
  const hash = txHash(outcome);
  const entry = {
    label,
    hash,
    explorer: `https://testnet.nearblocks.io/txns/${hash}`,
    at: new Date().toISOString(),
    ...extra,
  };
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
  log.push(entry);
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log(`  ${label}: ${hash}`);
  return entry;
}

export async function addMetric(near, m) {
  const c = contractId();
  const o = await call(near, ownerId(), c, "add_metric", {
    id: m.id,
    category: m.category,
    unit: m.unit,
    max_value: m.maxValue,
    scale: m.scale,
    direction: m.direction,
  });
  return logTx(`add_metric:${m.id}`, o);
}

export async function addProduct(near, product) {
  const c = contractId();
  const o = await call(near, ownerId(), c, "add_product", {
    id: product.id,
    city: product.city,
    threshold_tenths: product.thresholdTenths,
    premium_bp: product.premiumBp,
    min_payout: String(product.minPayoutYocto),
    max_payout: String(product.maxPayoutYocto),
    min_lead_sec: product.minLeadSec,
    max_total_coverage: String(product.maxTotalCoverageYocto),
  });
  return logTx(`add_product:${product.id}`, o);
}

export async function addMetricProduct(near, product) {
  const c = contractId();
  const o = await call(near, ownerId(), c, "add_metric_product", {
    id: product.id,
    city: product.city,
    metric_id: product.metricId,
    threshold_tenths: product.thresholdTenths,
    premium_bp: product.premiumBp,
    min_payout: String(product.minPayoutYocto),
    max_payout: String(product.maxPayoutYocto),
    min_lead_sec: product.minLeadSec,
    max_total_coverage: String(product.maxTotalCoverageYocto),
  });
  return logTx(`add_metric_product:${product.id}`, o);
}

export async function deposit(near, accountId, nearAmount) {
  const c = contractId();
  const o = await call(near, accountId, c, "deposit", {}, toYocto(nearAmount));
  return logTx(`deposit:${accountId}:${nearAmount}`, o);
}

export async function buyCover(near, accountId, { productId, payoutYocto, obsDate, beneficiary }) {
  const c = contractId();
  const premium = BigInt((await view(near, c, "quote", { product_id: productId, payout: String(payoutYocto) })).toString());
  const o = await call(near, accountId, c, "buy_cover", {
    product_id: productId,
    payout: String(payoutYocto),
    obs_date: obsDate,
    beneficiary: beneficiary ?? null,
  }, premium.toString());
  return { entry: logTx(`buy_cover:${accountId}:${productId}`, o), premium };
}

export async function withdraw(near, accountId, nearAmount) {
  const c = contractId();
  const o = await call(near, accountId, c, "withdraw", { amount: toYocto(nearAmount) });
  return logTx(`withdraw:${accountId}:${nearAmount}`, o);
}

/** Submit ONE operator's reading. Reads the operator's current nonce on-chain,
 *  reads the public index, signs the canonical message, and calls submit_reading. */
export async function submitReading(near, role, { metricId, city, obsDate, valueTenthsOverride }) {
  const ids = loadIdentities();
  const c = contractId();
  const me = ids[role];
  if (!me?.accountId) throw new Error(`no identity for ${role}`);
  const operator = me.accountId;

  const onchain = await view(near, c, "get_operator", { account: operator });
  if (!onchain) throw new Error(`${operator} is not a registered operator`);
  if (!onchain.active) throw new Error(`${operator} is revoked`);
  const nonce = onchain.readings;

  const obs = valueTenthsOverride === undefined
    ? await observe(metricId, city, obsDate)
    : { valueTenths: valueTenthsOverride, unit: "?", source: "override" };
  const reportedAt = Math.floor(Date.now() / 1000);

  const kp = KeyPair.fromString(me.secretKey);
  const { signature } = signReading(kp, {
    operator, metricId, city, obsDate, valueTenths: obs.valueTenths, reportedAt, nonce, contractId: c,
  });

  const o = await call(near, operator, c, "submit_reading", {
    metric_id: metricId,
    city,
    obs_date: obsDate,
    value_tenths: obs.valueTenths,
    reported_at: reportedAt,
    nonce,
    signature,
  });
  return { entry: logTx(`submit_reading:${role}:${metricId}:${city}`, o, { valueTenths: obs.valueTenths, reportedAt }), obs, reportedAt, operator };
}

/** Submit readings from EVERY operator so the observation reaches quorum. */
export async function submitQuorum(near, { metricId, city, obsDate, valueTenthsOverride }) {
  const roles = operatorRoles();
  if (roles.length === 0) throw new Error("no operator identities; run driver/keys.js");
  const out = [];
  for (const role of roles) {
    out.push(await submitReading(near, role, { metricId, city, obsDate, valueTenthsOverride }));
  }
  const finalized = await view(near, contractId(), "get_observation", { metric_id: metricId, city, obs_date: obsDate });
  return { readings: out, finalized, reportedAt: out[out.length - 1].reportedAt };
}

export async function challengeObservation(near, accountId, { metricId, city, obsDate, counterValueTenths, bondNear }) {
  const c = contractId();
  const o = await call(near, accountId, c, "challenge_observation",
    { metric_id: metricId, city, obs_date: obsDate, counter_value_tenths: counterValueTenths }, toYocto(bondNear));
  return logTx(`challenge:${metricId}:${city}`, o);
}

/** One independent resolver votes on a dispute. `uphold=true` keeps the
 *  reading, `false` voids it. A quorum of independent resolvers decides. */
export async function resolverVote(near, role, { metricId, city, obsDate, uphold }) {
  const ids = loadIdentities();
  const c = contractId();
  const o = await call(near, ids[role].accountId, c, "resolver_vote",
    { metric_id: metricId, city, obs_date: obsDate, uphold });
  return logTx(`resolver_vote:${role}:${metricId}:${city}:${uphold}`, o);
}

/** Every resolver votes the same way to reach the resolver quorum. */
export async function resolveByQuorum(near, { metricId, city, obsDate, uphold }) {
  const roles = resolverRoles();
  if (roles.length === 0) throw new Error("no resolver identities; run driver/keys.js");
  for (const role of roles) await resolverVote(near, role, { metricId, city, obsDate, uphold });
  return view(near, contractId(), "get_dispute", { metric_id: metricId, city, obs_date: obsDate });
}

export async function resolve(near, accountId, policyId) {
  const c = contractId();
  const o = await call(near, accountId, c, "resolve", { policy_id: policyId });
  return logTx(`resolve:${policyId}`, o);
}

/** Attempt a call that is EXPECTED to fail (adversarial negative test).
 *  Returns the on-chain error message, or throws if it unexpectedly succeeded. */
export async function expectFailure(near, accountId, method, args, depositYocto = "0") {
  const c = contractId();
  try {
    await call(near, accountId, c, method, args, depositYocto);
  } catch (e) {
    return e.message;
  }
  throw new Error(`EXPECTED FAILURE but ${method} succeeded`);
}
