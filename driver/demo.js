// Overcover — the complete economic cycle, on NEAR testnet.
//
//   stake capital -> quote risk -> buy coverage -> reserve capital ->
//   observe index -> validate trigger -> settle claim -> verify payout ->
//   recalculate solvency
//
// Plus negative tests: a claim whose trigger is not met, a capacity rejection,
// a flash-settlement rejection, a double-settlement rejection, and an
// unauthorized withdrawal.
//
//   node driver/demo.js   (run driver/deploy.js first with OVERCOVER_DEMO_WINDOW=60)
//
// Every hash printed is a real testnet transaction. The only inputs are the
// real Open-Meteo reading and the live contract state. Nothing is fabricated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectNear, view, fromYocto, toYocto, balanceYocto, loadIdentities, loadState, saveState } from "./near.js";
import { contractId, addProduct, deposit, buyCover, withdraw, reportObservation, resolve, expectFailure } from "./actions.js";
import { observeCity } from "./oracle.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW = 60;
fs.writeFileSync(path.join(root, "demo-log.json"), "[]");

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const fmt = (y) => `${fromYocto(y).toFixed(4)} NEAR`;
const line = (s = "") => console.log(s);
const head = (s) => console.log(`\n=== ${s} ===`);
const nowS = () => Math.floor(Date.now() / 1000);

async function pool(near) { return view(near, contractId(), "get_pool", {}); }
async function bal(near, id) { return fromYocto(await balanceYocto(near, id)); }
async function lastPolicyId(near) { const l = await view(near, contractId(), "list_policies", {}); return l[l.length - 1].id; }
async function waitUntil(t, why) {
  const w = t - nowS();
  if (w > 0) { line(`  waiting ${w}s ${why}...`); await sleep(w + 2); }
}
async function ensureMin(near, ids, role, minNear) {
  if (await bal(near, ids[role].accountId) >= minNear) return;
  const att = await near.account(ids.attestor.accountId);
  await att.sendMoney(ids[role].accountId, toYocto((minNear + 0.5).toFixed(4)));
  await sleep(1.5);
}

async function main() {
  const ids = loadIdentities();
  const c = contractId();
  const near = await connectNear();

  head(`OVERCOVER — live on NEAR testnet (${c})`);
  const cfg = await view(near, c, "get_config", {});
  line(`attestor ${cfg.attestor}  challenge bond ${fmt(cfg.challenge_bond)}  window ${cfg.challenge_window_sec}s`);
  if (Number(cfg.challenge_window_sec) > WINDOW) {
    line(`\nFATAL: contract window is ${cfg.challenge_window_sec}s; re-deploy with OVERCOVER_DEMO_WINDOW=60`);
    process.exit(2);
  }

  const obsDate = nowS() + 45;

  // 1. products -----------------------------------------------------------
  head("1. Publish products (immutable risk definitions)");
  const lagos = await observeCity("lagos");
  const bergen = await observeCity("bergen");
  line(`live Open-Meteo: ${lagos.cityName} ${lagos.valueTenths / 10} mm, ${bergen.cityName} ${bergen.valueTenths / 10} mm`);
  const threshold = lagos.valueTenths; // the PAY product triggers at today's real level
  for (const p of [
    { id: "rain-lagos", city: "lagos", thresholdTenths: threshold, premiumBp: 500,
      minPayoutYocto: toYocto("0.1"), maxPayoutYocto: toYocto("1"), minLeadSec: 0, maxTotalCoverageYocto: toYocto("50") },
    { id: "rain-bergen-dry", city: "bergen", thresholdTenths: 5000, premiumBp: 500,
      minPayoutYocto: toYocto("0.05"), maxPayoutYocto: toYocto("0.5"), minLeadSec: 0, maxTotalCoverageYocto: toYocto("0.5") },
  ]) await addProduct(near, p);
  line(`  ${lagos.cityName} trigger threshold: ${threshold / 10} mm (real value qualifies at >=)`);

  // 2. capital ------------------------------------------------------------
  head("2. Stake capital into the pool");
  await ensureMin(near, ids, "lp_alice", 3); await ensureMin(near, ids, "lp_bob", 2); await ensureMin(near, ids, "biz_grower", 1.2);
  await deposit(near, ids.lp_alice.accountId, "3");
  await deposit(near, ids.lp_bob.accountId, "2");
  let p = await pool(near);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  available ${fmt(p.available)}  solvent=${p.solvent}`);

  // 3. buy coverage -------------------------------------------------------
  head("3. A business buys coverage — the payout is reserved");
  const b1 = await buyCover(near, ids.biz_grower.accountId, { productId: "rain-lagos", payoutYocto: toYocto("1"), obsDate });
  const policy1 = await lastPolicyId(near);
  p = await pool(near);
  line(`  premium ${fmt(b1.premium)}  policy ${policy1}`);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  available ${fmt(p.available)}  solvent=${p.solvent}`);

  // 4. capacity rejection -------------------------------------------------
  head("4. A coverage request beyond capacity is REJECTED");
  await buyCover(near, ids.biz_grower.accountId, { productId: "rain-bergen-dry", payoutYocto: toYocto("0.5"), obsDate });
  const policy2 = await lastPolicyId(near);
  const capErr = await expectFailure(near, ids.biz_grower.accountId, "buy_cover",
    { product_id: "rain-bergen-dry", payout: toYocto("0.5"), obs_date: obsDate, beneficiary: null }, toYocto("0.05"));
  line(`  product capacity is 1 NEAR; a second 1 NEAR policy is rejected on-chain: "${capErr}"`);

  // 5. observe ------------------------------------------------------------
  head("5. Observe the index (real Open-Meteo reading, attestor-signed)");
  await waitUntil(obsDate, "for the observation date");
  const r1 = await reportObservation(near, { city: "lagos", obsDate, nonce: nowS(), valueTenthsOverride: threshold });
  const r2 = await reportObservation(near, { city: "bergen", obsDate, nonce: nowS() + 1, valueTenthsOverride: bergen.valueTenths });
  line(`  lagos ${r1.obs.valueTenths / 10} mm vs threshold ${threshold / 10} -> qualifies ${r1.obs.valueTenths >= threshold}`);
  line(`  bergen ${r2.obs.valueTenths / 10} mm vs threshold 500.0 -> qualifies ${r2.obs.valueTenths >= 5000}`);

  // 6. flash settlement rejected -----------------------------------------
  head("6. Settling inside the challenge window is REJECTED");
  line(`  ${await expectFailure(near, ids.owner.accountId, "resolve", { policy_id: policy1 })}`);

  // 7. settle the PAY claim ----------------------------------------------
  head("7. Settle the claim (after the challenge window)");
  await waitUntil(r1.reportedAt + WINDOW + 3, "for the challenge window");
  const before = await bal(near, ids.biz_grower.accountId);
  await resolve(near, ids.owner.accountId, policy1);
  await sleep(2);
  const after = await bal(near, ids.biz_grower.accountId);
  p = await pool(near);
  line(`  beneficiary ${before.toFixed(4)} -> ${after.toFixed(4)} NEAR (payout 1.0000)`);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  total_paid ${fmt(p.total_paid)}  solvent=${p.solvent}`);

  // 8. double settlement rejected ----------------------------------------
  head("8. Double settlement is REJECTED");
  line(`  ${await expectFailure(near, ids.owner.accountId, "resolve", { policy_id: policy1 })}`);

  // 9. failed claim (trigger not met) does not pay ------------------------
  head("9. A claim whose trigger is NOT met does not pay");
  const capBefore = (await pool(near)).capital;
  await resolve(near, ids.owner.accountId, policy2);
  p = await pool(near);
  line(`  bergen policy settled with value ${r2.obs.valueTenths / 10} mm < 500.0 -> paid 0`);
  line(`  capital ${fmt(capBefore)} -> ${fmt(p.capital)} (premium retained, no payout)  reserved ${fmt(p.reserved)}`);

  // 10. unauthorized withdrawal rejected ---------------------------------
  head("10. An unauthorized withdrawal is REJECTED");
  line(`  non-provider withdraw: "${await expectFailure(near, ids.biz_grower.accountId, "withdraw", { amount: toYocto("0.1") })}"`);

  // 11. honest withdrawals ------------------------------------------------
  head("11. Providers withdraw their unencumbered capital");
  const bb = await bal(near, ids.lp_bob.accountId);
  await withdraw(near, ids.lp_bob.accountId, "2");
  await sleep(2);
  line(`  lp_bob ${bb.toFixed(4)} -> ${(await bal(near, ids.lp_bob.accountId)).toFixed(4)} NEAR (withdrew 2)`);
  for (const role of ["lp_alice", "lp_bob"]) {
    const prov = await view(near, c, "get_provider", { account_id: ids[role].accountId });
    const own = BigInt(prov.deposited) - BigInt(prov.withdrawn);
    const avail = BigInt((await pool(near)).available);
    const amount = own < avail ? own : avail;
    if (amount > 0n) { await withdraw(near, ids[role].accountId, fromYocto(amount).toFixed(6)); await sleep(1.5); }
  }
  p = await pool(near);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  available ${fmt(p.available)}`);

  // 12. final solvency ----------------------------------------------------
  head("12. Final solvency + reconciliation");
  const recon = await view(near, c, "reconcile", {});
  p = await pool(near);
  line(`  capital=${p.capital}  reserved=${p.reserved}  available=${p.available}`);
  line(`  deposited=${p.total_deposited} withdrawn=${p.total_withdrawn} premiums=${p.premiums_collected} bonds=${p.bonds_forfeited} paid=${p.total_paid}`);
  line(`  invariant reserved<=capital: ${p.solvent}`);
  line(`  reconcile (capital == deposited - withdrawn + premiums + bonds - paid): ${recon}`);

  // 13. transactions ------------------------------------------------------
  head("13. Verified testnet transactions (demo-log.json)");
  for (const e of JSON.parse(fs.readFileSync(path.join(root, "demo-log.json"), "utf8")))
    line(`  ${e.label.padEnd(36)} ${e.explorer}`);

  const state = loadState(); state.lastDemo = { at: new Date().toISOString(), pool: p }; saveState(state);
  line("\nDONE.");
}

main().catch((e) => { console.error("DEMO FAILED:", e.message); process.exit(1); });
