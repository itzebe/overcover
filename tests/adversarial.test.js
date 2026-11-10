// Adversarial tests against the LIVE testnet contract.
//
// Each test attempts an attack and asserts the contract REFUSES it with the
// expected reason. Run after `node driver/deploy.js`:
//
//   node --test tests/*.test.js
//
// These are real testnet transactions. A failing assertion means the contract
// accepted something it should not have. Contract rules the tests rely on:
//   * a policy's obs_date must be in the FUTURE (>= now + min_lead_sec);
//   * an observation's obs_date must be in the PAST/PRESENT (<= now) and be
//     reported within REPORT_MAX_DELAY_SEC of that date.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { connectNear, view, toYocto, call, loadIdentities, loadState, balanceYocto } from "../driver/near.js";
import { signObservation } from "../driver/attestor.js";

const ids = loadIdentities();
const C = loadState().contractId;
let near;

const owner = () => ids.owner.accountId;
const biz = () => ids.biz_grower.accountId;
const att = () => ids.attestor.accountId;
const now = () => Math.floor(Date.now() / 1000);
let seq = 0;
const uniq = (p) => `${p}-${Date.now()}-${seq++}`;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function ensureMin(role, minNear) {
  if (Number(BigInt(await balanceYocto(near, ids[role].accountId))) / 1e24 >= minNear) return;
  const a = await near.account(ids.attestor.accountId);
  await a.sendMoney(ids[role].accountId, toYocto((minNear + 0.5).toFixed(4)));
  await sleep(1.5);
}

/** Send a call and return the on-chain error string, or null if it succeeded. */
async function rejection(signer, method, args, deposit = "0") {
  try { await call(near, signer, C, method, args, toYocto(deposit)); return null; }
  catch (e) { return e.message; }
}

function signedObs({ city, obsDate, valueTenths, reportedAt, nonce, signerKey }) {
  const kp = signerKey ?? KeyPair.fromString(ids.attestor.secretKey);
  const { signature } = signObservation(kp, { city, obsDate, valueTenths, reportedAt, nonce, contractId: C });
  return { city, obs_date: obsDate, value_tenths: valueTenths, reported_at: reportedAt, nonce, signature };
}

async function addProduct(overrides = {}) {
  const p = {
    id: uniq("p"), city: "lagos", threshold_tenths: 1, premium_bp: 500,
    min_payout: toYocto("0.05"), max_payout: toYocto("1"), min_lead_sec: 0,
    max_total_coverage: toYocto("10"), ...overrides,
  };
  const err = await rejection(owner(), "add_product", p);
  assert.equal(err, null, `add_product failed: ${err}`);
  return p;
}

before(async () => {
  near = await connectNear();
  // make lp_alice and lp_bob providers so withdrawal tests are meaningful
  await ensureMin("lp_alice", 3);
  await ensureMin("lp_bob", 3);
  await ensureMin("biz_grower", 8);
  await call(near, ids.lp_alice.accountId, C, "deposit", {}, toYocto("2"));
  await call(near, ids.lp_bob.accountId, C, "deposit", {}, toYocto("2"));
});

// --- product / capacity attacks -------------------------------------------

test("non-owner cannot publish a product", async () => {
  const err = await rejection(biz(), "add_product", {
    id: uniq("attack"), city: "lagos", threshold_tenths: 1, premium_bp: 500,
    min_payout: toYocto("0.05"), max_payout: toYocto("0.5"), min_lead_sec: 0, max_total_coverage: toYocto("1"),
  });
  assert.match(err ?? "", /owner/i);
});

test("capacity below max payout is rejected", async () => {
  const err = await rejection(owner(), "add_product", {
    id: uniq("cap"), city: "lagos", threshold_tenths: 1, premium_bp: 500,
    min_payout: toYocto("0.05"), max_payout: toYocto("5"), min_lead_sec: 0, max_total_coverage: toYocto("1"),
  });
  assert.match(err ?? "", /capacity/i);
});

test("premium above 100% is rejected", async () => {
  const err = await rejection(owner(), "add_product", {
    id: uniq("prem"), city: "lagos", threshold_tenths: 1, premium_bp: 20_000,
    min_payout: toYocto("0.05"), max_payout: toYocto("1"), min_lead_sec: 0, max_total_coverage: toYocto("10"),
  });
  assert.match(err ?? "", /premium/i);
});

// --- buying attacks --------------------------------------------------------

test("buying beyond product capacity is rejected", async () => {
  const p = await addProduct({ max_payout: toYocto("1"), max_total_coverage: toYocto("1") });
  const obsDate = now() + 30;
  await call(near, biz(), C, "buy_cover", { product_id: p.id, payout: toYocto("1"), obs_date: obsDate, beneficiary: null }, toYocto("0.05"));
  const err = await rejection(biz(), "buy_cover", { product_id: p.id, payout: toYocto("1"), obs_date: obsDate, beneficiary: null }, "0.05");
  assert.match(err ?? "", /capacity/i);
});

test("buying with an underpaid premium is rejected", async () => {
  const p = await addProduct({ premium_bp: 1000 });
  const err = await rejection(biz(), "buy_cover", { product_id: p.id, payout: toYocto("1"), obs_date: now() + 30, beneficiary: null }, "0.0001");
  assert.match(err ?? "", /premium/i);
});

test("buying past the observation date is rejected", async () => {
  const p = await addProduct();
  const err = await rejection(biz(), "buy_cover", { product_id: p.id, payout: toYocto("1"), obs_date: now() - 10, beneficiary: null }, "0.05");
  assert.match(err ?? "", /lead|past|date/i);
});

test("coverage beyond available capital is rejected (solvency gate)", async () => {
  const p = await addProduct({ premium_bp: 100, max_payout: toYocto("1000"), max_total_coverage: toYocto("100000") });
  // premium 1% of 100 NEAR = 1 NEAR (affordable); reservation 100 >> pool capital
  const err = await rejection(biz(), "buy_cover", { product_id: p.id, payout: toYocto("100"), obs_date: now() + 30, beneficiary: null }, "1");
  assert.match(err ?? "", /capital|solvency|available/i);
});

// --- oracle attacks --------------------------------------------------------

test("an observation signed by the wrong key is rejected", async () => {
  const rogue = KeyPair.fromRandom("ed25519");
  const args = signedObs({ city: "lagos", obsDate: now() - 5, valueTenths: 1, reportedAt: now(), nonce: Date.now(), signerKey: rogue });
  const err = await rejection(att(), "report_observation", args);
  assert.match(err ?? "", /signature/i);
});

test("a tampered observation value is rejected (signature binds the value)", async () => {
  const obsDate = now() - 5, nonce = Date.now();
  const good = signedObs({ city: "lagos", obsDate, valueTenths: 1, reportedAt: now(), nonce });
  const err = await rejection(att(), "report_observation", { ...good, value_tenths: 1_000_000 });
  assert.match(err ?? "", /signature/i);
});

test("a replayed observation nonce is rejected", async () => {
  const obsDate = now() - 5, nonce = Date.now();
  const args = signedObs({ city: "lagos", obsDate, valueTenths: 1, reportedAt: now(), nonce });
  assert.equal(await rejection(att(), "report_observation", args), null);
  const err = await rejection(att(), "report_observation", args);
  assert.match(err ?? "", /nonce|replay|already/i);
});

test("a stale observation is rejected", async () => {
  const args = signedObs({ city: "lagos", obsDate: now() - 200000, valueTenths: 1, reportedAt: now() - 100000, nonce: Date.now() });
  const err = await rejection(att(), "report_observation", args);
  assert.match(err ?? "", /stale|late/i);
});

test("an observation for a future date is rejected", async () => {
  const args = signedObs({ city: "lagos", obsDate: now() + 500, valueTenths: 1, reportedAt: now() + 500, nonce: Date.now() });
  const err = await rejection(att(), "report_observation", args);
  assert.match(err ?? "", /future/i);
});

// --- dispute attacks -------------------------------------------------------

test("challenging with an insufficient bond is rejected", async () => {
  const obsDate = now() - 5, nonce = Date.now();
  const args = signedObs({ city: "lagos", obsDate, valueTenths: 1, reportedAt: now(), nonce });
  await call(near, att(), C, "report_observation", args, "0");
  const err = await rejection(ids.watchdog.accountId, "challenge_observation",
    { city: "lagos", obs_date: obsDate, counter_value_tenths: 999 }, "0.0001");
  assert.match(err ?? "", /bond/i);
});

// --- settlement / withdrawal attacks --------------------------------------

test("settling before the challenge window is rejected", async () => {
  const p = await addProduct({ max_payout: toYocto("0.5"), max_total_coverage: toYocto("10") });
  const obsDate = now() + 6;
  const payout = toYocto("0.5");
  const premium = BigInt((await view(near, C, "quote", { product_id: p.id, payout })).toString());
  await call(near, biz(), C, "buy_cover", { product_id: p.id, payout, obs_date: obsDate, beneficiary: null }, premium.toString());
  const list = await view(near, C, "list_policies", {});
  const pid = list[list.length - 1].id;
  await sleep(9); // obs date passes
  const obs = signedObs({ city: "lagos", obsDate, valueTenths: 1, reportedAt: now(), nonce: Date.now() });
  await call(near, att(), C, "report_observation", obs, "0");
  const err = await rejection(owner(), "resolve", { policy_id: pid });
  assert.match(err ?? "", /window/i);
});

test("withdrawing more than your own capital is rejected", async () => {
  const err = await rejection(ids.lp_bob.accountId, "withdraw", { amount: toYocto("99999") });
  assert.match(err ?? "", /own|capital/i);
});

test("a non-provider cannot withdraw", async () => {
  const err = await rejection(ids.watchdog.accountId, "withdraw", { amount: toYocto("0.0001") });
  assert.match(err ?? "", /provider/i);
});

test("a non-owner cannot resolve a dispute", async () => {
  const err = await rejection(biz(), "resolve_dispute", { city: "lagos", obs_date: now(), uphold: true });
  assert.match(err ?? "", /owner/i);
});
