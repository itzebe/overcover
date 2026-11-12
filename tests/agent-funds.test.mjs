// Live funds-preflight test for the agent's real (non-dry-run) buy path.
//
//   node --test tests/agent-funds.test.mjs
//
// It constructs the REAL agent (agent/agent.mjs) against the live testnet RPC
// with an account that is deliberately unfunded, and asks it to buy. The policy
// allows the purchase, so the only thing that can stop it is the balance check —
// which must refuse BEFORE anything is signed. No transaction is ever sent: the
// account has no funds, and the guard fires first. This is a read-only test of
// the guard, not a purchase.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPair } from "near-api-js";
import { createAgent } from "../agent/agent.mjs";

const ONE_NEAR = 10n ** 24n;

test("an unfunded agent refuses a buy before signing, with a balance reason", async (t) => {
  const auditPath = path.join(os.tmpdir(), `overcover-funds-${Date.now()}.jsonl`);
  const kp = KeyPair.fromRandom("ed25519");
  // A plausible but almost certainly unfunded testnet account id.
  const accountId = `overcover-unfunded-${Date.now()}.testnet`;

  let agent;
  try {
    agent = await createAgent({
      accountId,
      secretKey: kp.toString(),
      dryRun: false,
      auditPath,
      // Limits wide enough that the purchase is allowed by policy — so the only
      // possible refusal is the balance guard.
      limits: { maxPremiumPerPolicy: ONE_NEAR.toString(), maxPayoutPerPolicy: (2n * ONE_NEAR).toString(), dailyPremiumBudget: (10n * ONE_NEAR).toString(), dailyPolicyLimit: 5, cooldownSec: 0 },
    });
  } catch (e) {
    // Offline environment: the guard itself is covered by the pure tests.
    t.skip(`network unavailable: ${e.message}`);
    return;
  }

  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;
  // 0.1 NEAR is inside the product's own payout bounds, so policy allows it and
  // the balance guard is the only thing that can refuse — which it must.
  await assert.rejects(
    () => agent.buy({ productId: "heat-lagos", payoutYocto: (ONE_NEAR / 10n).toString(), obsDateSec }),
    (e) => {
      assert.equal(e.code, "denied", "an unfunded buy must be a policy denial, not a chain error");
      assert.match(e.reasons.join(" "), /balance/i, "the reason must name the balance");
      return true;
    },
  );

  // The audit log must record the denial and never a buy.
  const lines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.ok(lines.some((l) => l.kind === "denied"), "the denial must be audited");
  assert.ok(!lines.some((l) => l.kind === "buy"), "no buy may be recorded when funds are insufficient");

  fs.rmSync(auditPath, { force: true });
});

test("balanceYocto() reads a missing account as null, without throwing", async (t) => {
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = `overcover-missing-${Date.now()}.testnet`;

  let agent;
  try {
    agent = await createAgent({ accountId, secretKey: kp.toString(), dryRun: true, auditPath: path.join(os.tmpdir(), `overcover-bal-${Date.now()}.jsonl`) });
  } catch (e) {
    t.skip(`network unavailable: ${e.message}`);
    return;
  }

  // The exported balance read is the funds guard's input. A missing account must
  // resolve to null ("no balance"), never throw — otherwise the buy path turns a
  // not-funded account into a chain error instead of a policy denial.
  const balance = await agent.balanceYocto();
  assert.equal(balance, null, "an unfunded/absent account must read as a null balance");
});

test("balanceYocto() reads a funded account's total (amount + locked) as a digit string", async (t) => {
  const kp = KeyPair.fromRandom("ed25519");
  // A live contract account is certainly funded, so this exercises the success path.
  let agent;
  try {
    agent = await createAgent({ accountId: "contract.ovc-v3-ctl-2f6c4c.testnet", secretKey: kp.toString(), dryRun: true, auditPath: path.join(os.tmpdir(), `overcover-bal2-${Date.now()}.jsonl`) });
  } catch (e) {
    t.skip(`network unavailable: ${e.message}`);
    return;
  }

  const balance = await agent.balanceYocto();
  assert.equal(typeof balance, "string", "a funded account reads as a digit string");
  assert.ok(/^\d+$/.test(balance), "the balance is a plain digit string, not a float");
  assert.ok(BigInt(balance) > 0n, "a live contract account has a positive balance");
});
