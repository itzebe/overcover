// High-level Overcover actions over the NEAR testnet contract.
// Every function performs a real on-chain call and returns { hash, outcome }.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { call, view, toYocto, txHash, loadIdentities, loadState } from "./near.js";
import { signObservation } from "./attestor.js";
import { observeCity } from "./oracle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(root, "demo-log.json");

export function contractId() {
  return loadState().contractId ?? loadIdentities().owner.accountId;
}

/** The owner (admin) account, used to sign owner-only calls. */
export function ownerId() {
  return loadIdentities().owner.accountId;
}

export function logTx(label, outcome, extra = {}) {
  const hash = txHash(outcome);
  const entry = {
    label,
    hash,
    explorer: `https://testnet.nearblocks.io/txns/${hash}`,
    rpc: `https://testnet.nearblocks.io/txns/${hash}`,
    at: new Date().toISOString(),
    ...extra,
  };
  const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
  log.push(entry);
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log(`  ${label}: ${hash}`);
  return entry;
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

/** Read live weather for `city`, sign it with the attestor key, and report it. */
export async function reportObservation(near, { city, obsDate, nonce, valueTenthsOverride }) {
  const ids = loadIdentities();
  const c = contractId();
  const att = KeyPair.fromString(ids.attestor.secretKey);
  const obs = valueTenthsOverride === undefined
    ? await observeCity(city)
    : { valueTenths: valueTenthsOverride, crossCheckTenths: valueTenthsOverride, timeUtc: new Date().toISOString() };
  const reportedAt = Math.floor(Date.now() / 1000);
  const { signature } = signObservation(att, {
    city, obsDate, valueTenths: obs.valueTenths, reportedAt, nonce, contractId: c,
  });
  const o = await call(near, ids.attestor.accountId, c, "report_observation", {
    city, obs_date: obsDate, value_tenths: obs.valueTenths, reported_at: reportedAt, nonce,
    signature,
  });
  return { entry: logTx(`report_observation:${city}`, o, { valueTenths: obs.valueTenths, reportedAt }), obs, reportedAt };
}

export async function challengeObservation(near, accountId, { city, obsDate, counterValueTenths, bondNear }) {
  const c = contractId();
  const o = await call(near, accountId, c, "challenge_observation",
    { city, obs_date: obsDate, counter_value_tenths: counterValueTenths }, toYocto(bondNear));
  return logTx(`challenge:${city}`, o);
}

export async function resolveDispute(near, { city, obsDate, uphold }) {
  const c = contractId();
  const o = await call(near, ownerId(), c, "resolve_dispute", { city, obs_date: obsDate, uphold });
  return logTx(`resolve_dispute:${city}:${uphold}`, o);
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
