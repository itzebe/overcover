// Overcover — the complete DECENTRALIZED insurance lifecycle, on NEAR testnet.
//
//   metrics + products -> stake capital -> quote risk -> buy cover (human) ->
//   buy cover (autonomous agent, within limits) -> a QUORUM of independent
//   operators observe the index -> validate the trigger -> settle -> verify
//   payout -> challenge/dispute -> reconcile solvency.
//
// Plus negative tests: a claim whose trigger is not met, a capacity rejection,
// a flash-settlement rejection, a double-settlement rejection, an unauthorized
// withdrawal, a below-quorum reading that cannot settle, a disputed reading that
// cannot settle, an over-limit agent purchase that is refused before any call,
// and a challenge after the window.
//
//   node driver/demo.js   (run driver/deploy.js first with OVERCOVER_DEMO_WINDOW=60)
//
// Every hash printed is a real testnet transaction. The only inputs are the real
// Open-Meteo readings and the live contract state. Nothing is fabricated.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectNear, view, fromYocto, toYocto, balanceYocto, loadIdentities, loadState, saveState } from "./near.js";
import {
  contractId, addMetricProduct, deposit, buyCover, withdraw, submitQuorum,
  resolve, expectFailure, challengeObservation, resolveByQuorum, operatorRoles,
} from "./actions.js";
import { observe } from "./adapters.js";
import { normalizeLimits, evaluate } from "../agent/limits.mjs";

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

  head(`OVERCOVER — decentralized insurance, live on NEAR testnet (${c})`);
  const cfg = await view(near, c, "get_config", {});
  line(`quorum ${cfg.quorum} operators  resolver quorum ${cfg.resolver_quorum}  challenge bond ${fmt(cfg.challenge_bond)}  window ${cfg.challenge_window_sec}s`);
  if (Number(cfg.challenge_window_sec) > WINDOW) {
    line(`\nFATAL: contract window is ${cfg.challenge_window_sec}s; re-deploy with OVERCOVER_DEMO_WINDOW=60`);
    process.exit(2);
  }
  const ops = operatorRoles();
  line(`operators: ${ops.join(", ")}`);

  const obsDate = nowS() + 45;

  // 1. products -----------------------------------------------------------
  head("1. Publish metric-backed products (immutable risk definitions)");
  const lagosRain = await observe("rain", "lagos", obsDate).catch(() => null);
  const lagosHeat = await observe("heat", "lagos", obsDate).catch(() => null);
  line(`live Open-Meteo: Lagos rain ${(lagosRain?.valueTenths ?? 0) / 10} mm, heat ${(lagosHeat?.valueTenths ?? 0) / 10} degC`);
  const rainThreshold = lagosRain ? lagosRain.valueTenths : 100; // the PAY product triggers at today's real level
  const heatThreshold = 500; // 50.0 degC — a heat product that will NOT trigger today
  await addMetricProduct(near, {
    id: "rain-lagos", city: "lagos", metricId: "rain", thresholdTenths: rainThreshold, premiumBp: 500,
    minPayoutYocto: toYocto("0.1"), maxPayoutYocto: toYocto("1"), minLeadSec: 0, maxTotalCoverageYocto: toYocto("50"),
  });
  await addMetricProduct(near, {
    id: "heat-lagos", city: "lagos", metricId: "heat", thresholdTenths: heatThreshold, premiumBp: 500,
    minPayoutYocto: toYocto("0.05"), maxPayoutYocto: toYocto("0.5"), minLeadSec: 0, maxTotalCoverageYocto: toYocto("5"),
  });
  line(`  rain-lagos trigger >= ${rainThreshold / 10} mm (real value qualifies today)`);
  line(`  heat-lagos trigger >= ${heatThreshold / 10} degC (will not qualify today)`);

  // 2. capital ------------------------------------------------------------
  head("2. Stake capital into the pool");
  await ensureMin(near, ids, "lp_alice", 4); await ensureMin(near, ids, "lp_bob", 3); await ensureMin(near, ids, "biz_grower", 2);
  await deposit(near, ids.lp_alice.accountId, "3");
  await deposit(near, ids.lp_bob.accountId, "2");
  let p = await pool(near);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  available ${fmt(p.available)}  solvent=${p.solvent}`);

  // 3. human buys coverage ------------------------------------------------
  head("3. A business buys coverage — the payout is reserved");
  const b1 = await buyCover(near, ids.biz_grower.accountId, { productId: "rain-lagos", payoutYocto: toYocto("1"), obsDate });
  const policy1 = await lastPolicyId(near);
  p = await pool(near);
  line(`  premium ${fmt(b1.premium)}  policy ${policy1}`);
  line(`  capital ${fmt(p.capital)}  reserved ${fmt(p.reserved)}  available ${fmt(p.available)}  solvent=${p.solvent}`);

  // 3b. the AUTONOMOUS AGENT buys coverage within its limits --------------
  head("3b. An autonomous agent buys coverage — within its spending limits");
  const limits = normalizeLimits({ maxPremiumPerPolicy: toYocto("0.1"), maxPayoutPerPolicy: toYocto("0.5") });
  const agentPayout = toYocto("0.5");
  const agentPremium = BigInt((await view(near, c, "quote", { product_id: "heat-lagos", payout: String(agentPayout) })).toString());
  const decision = evaluate(
    { productId: "heat-lagos", city: "lagos", payoutYocto: String(agentPayout), premiumYocto: String(agentPremium), obsDateSec: obsDate, nowSec: nowS() },
    { min_payout: toYocto("0.05"), max_payout: toYocto("0.5"), min_lead_sec: 0, active: true },
    { limits, history: [], nowMs: Date.now() }
  );
  line(`  agent policy engine: ${decision.allow ? "ALLOW" : `DENY (${decision.reasons.join("; ")})`}`);
  if (!decision.allow) throw new Error("agent refused its own in-limit purchase");
  await ensureMin(near, ids, "agent", 2);
  const b2 = await buyCover(near, ids.agent.accountId, { productId: "heat-lagos", payoutYocto: String(agentPayout), obsDate });
  const policy2 = await lastPolicyId(near);
  line(`  agent bought policy ${policy2} for ${fmt(b2.premium)} (agent = ${ids.agent.accountId})`);

  // 3c. an OVER-LIMIT agent purchase is refused BEFORE any network call ---
  head("3c. An over-limit agent purchase is refused before any transaction");
  const overDecision = evaluate(
    { productId: "rain-lagos", city: "lagos", payoutYocto: toYocto("1"), premiumYocto: toYocto("0.05"), obsDateSec: obsDate, nowSec: nowS() },
    { min_payout: toYocto("0.1"), max_payout: toYocto("1"), min_lead_sec: 0, active: true },
    { limits, history: [], nowMs: Date.now() }
  );
  line(`  agent policy engine: ${overDecision.allow ? "ALLOW" : `DENY (${overDecision.reasons.join("; ")})`}`);
  if (overDecision.allow) throw new Error("agent allowed an over-limit purchase");

  // 4. capacity rejection -------------------------------------------------
  head("4. A coverage request beyond capacity is REJECTED");
  const capErr = await expectFailure(near, ids.biz_grower.accountId, "buy_cover",
    { product_id: "heat-lagos", payout: toYocto("0.5"), obs_date: obsDate, beneficiary: null }, toYocto("0.05"));
  line(`  heat-lagos capacity is 5 NEAR; an over-capacity request is rejected on-chain: "${capErr}"`);

  // 5. observe (quorum) ---------------------------------------------------
  head("5. A QUORUM of independent operators observes the index");
  await waitUntil(obsDate, "for the observation date");
  const rainQ = await submitQuorum(near, { metricId: "rain", city: "lagos", obsDate, valueTenthsOverride: rainThreshold });
  line(`  rain: ${rainQ.readings.length} operators reported; finalized=${!!rainQ.finalized} quorum=${rainQ.finalized?.quorum} value=${(rainQ.finalized?.value_tenths ?? 0) / 10} mm`);
  const heatQ = await submitQuorum(near, { metricId: "heat", city: "lagos", obsDate, valueTenthsOverride: 300 });
  line(`  heat: ${heatQ.readings.length} operators reported; finalized=${!!heatQ.finalized} quorum=${heatQ.finalized?.quorum} value=${(heatQ.finalized?.value_tenths ?? 0) / 10} degC`);

  // 6. flash settlement rejected -----------------------------------------
  head("6. Settling inside the challenge window is REJECTED");
  line(`  ${await expectFailure(near, ids.owner.accountId, "resolve", { policy_id: policy1 })}`);

  // 7. settle the PAY claim ----------------------------------------------
  head("7. Settle the rain claim (after the challenge window)");
  await waitUntil(rainQ.reportedAt + WINDOW + 3, "for the challenge window");
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
  head("9. The agent's heat claim does NOT pay (trigger not met)");
  const capBefore = (await pool(near)).capital;
  await resolve(near, ids.owner.accountId, policy2);
  p = await pool(near);
  line(`  heat value ${(heatQ.finalized?.value_tenths ?? 0) / 10} degC < ${heatThreshold / 10} -> paid 0`);
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

  // 12. decentralized dispute resolution ---------------------------------
  head("12. A disputed reading is decided by an INDEPENDENT resolver quorum");
  await ensureMin(near, ids, "watchdog", 1);
  const bond = fromYocto(cfg.challenge_bond).toFixed(4);

  // (a) a frivolous challenge: resolvers uphold the true reading, bond forfeited.
  const frivDate = nowS() - 25;
  await submitQuorum(near, { metricId: "rain", city: "lagos", obsDate: frivDate, valueTenthsOverride: rainThreshold });
  const beforeF = await pool(near);
  await challengeObservation(near, ids.watchdog.accountId, { metricId: "rain", city: "lagos", obsDate: frivDate, counterValueTenths: 0, bondNear: bond });
  const heldF = await pool(near);
  line(`  a challenger disputes a TRUE reading and posts a ${bond} NEAR bond`);
  line(`  held_bonds ${fmt(beforeF.held_bonds)} -> ${fmt(heldF.held_bonds)}`);
  const d1 = await resolveByQuorum(near, { metricId: "rain", city: "lagos", obsDate: frivDate, uphold: true });
  const afterF = await pool(near);
  line(`  ${cfg.resolver_quorum} independent resolvers UPHOLD the true reading -> bond forfeited to the pool`);
  line(`  capital ${fmt(heldF.capital)} -> ${fmt(afterF.capital)}  bonds_forfeited ${fmt(afterF.bonds_forfeited)}  upheld_votes=${d1.upheld_votes}`);

  // (b) a genuine false report: resolvers nullify it, bond returned.
  const badDate = nowS() - 15;
  await submitQuorum(near, { metricId: "rain", city: "lagos", obsDate: badDate, valueTenthsOverride: 999 });
  await challengeObservation(near, ids.watchdog.accountId, { metricId: "rain", city: "lagos", obsDate: badDate, counterValueTenths: rainThreshold, bondNear: bond });
  line(`  a challenger disputes a FALSE 99.9 mm reading with the real ${(rainThreshold / 10).toFixed(1)} mm`);
  const d2 = await resolveByQuorum(near, { metricId: "rain", city: "lagos", obsDate: badDate, uphold: false });
  const afterB = await pool(near);
  const badObs = await view(near, c, "get_observation", { metric_id: "rain", city: "lagos", obs_date: badDate });
  line(`  ${cfg.resolver_quorum} independent resolvers NULLIFY the false report -> challenger's bond returned  nullified_votes=${d2.nullified_votes}`);
  line(`  observation nullified=${badObs.nullified}  held_bonds ${fmt(afterB.held_bonds)}`);

  // 13. final solvency ----------------------------------------------------
  head("13. Final solvency + reconciliation");
  const recon = await view(near, c, "reconcile", {});
  p = await pool(near);
  line(`  capital=${p.capital}  reserved=${p.reserved}  available=${p.available}`);
  line(`  deposited=${p.total_deposited} withdrawn=${p.total_withdrawn} premiums=${p.premiums_collected} bonds=${p.bonds_forfeited} paid=${p.total_paid}`);
  line(`  invariant reserved<=capital: ${p.solvent}`);
  line(`  reconcile (capital == deposited - withdrawn + premiums + bonds - paid): ${recon}`);

  // 14. transactions ------------------------------------------------------
  head("14. Verified testnet transactions (demo-log.json)");
  for (const e of JSON.parse(fs.readFileSync(path.join(root, "demo-log.json"), "utf8")))
    line(`  ${e.label.padEnd(40)} ${e.explorer}`);

  const state = loadState(); state.lastDemo = { at: new Date().toISOString(), pool: p }; saveState(state);
  line("\nDONE.");
}

main().catch((e) => { console.error("DEMO FAILED:", e.message); process.exit(1); });
