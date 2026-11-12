// Regression test for the controlled-v3 testnet funding defect.
//
// The harness attaches GAS (100 Tgas) to every call, and a NEAR signer must hold
// `attached_deposit + gas_limit * gas_price`. On testnet (gas price 1e9) that is a
// 0.1 NEAR float per call; the original identity graph funded operators/resolvers
// with 0.1 NEAR and the buyer/attacker with 0.3 — exactly the deposit, no float —
// so the lifecycle aborted at buy_cover with "does not have enough balance ... for
// operation costing ...". The sandbox masked it because its gas price is ~0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredBalanceYocto, largestDepositYocto, underfundedRoles, YOCTO_PER_NEAR } from "../proof/gas-budget.mjs";

const TESTNET_GAS_PRICE = 10n ** 9n; // yocto per Gas on NEAR testnet
const NEW_GAS = 100n * 10n ** 12n; // 100 Tgas, the harness's per-call limit after the fix
const ORIGINAL_GAS = 300n * 10n ** 12n; // 300 Tgas, the limit that produced the bug
const BOND = 10n ** 23n; // 0.1 NEAR challenge bond

test("a signer must hold the deposit PLUS the worst-case gas cost", () => {
  assert.equal(requiredBalanceYocto({ depositYocto: 0n, gasLimit: NEW_GAS, gasPriceYocto: TESTNET_GAS_PRICE }), 10n ** 23n);
  assert.equal(requiredBalanceYocto({ depositYocto: 5n * 10n ** 23n, gasLimit: NEW_GAS, gasPriceYocto: TESTNET_GAS_PRICE }), 6n * 10n ** 23n);
});

test("the deposit-free roles (operators, resolvers) still need the gas float", () => {
  assert.equal(largestDepositYocto("op1", { challengeBondYocto: BOND }), 0n);
  assert.equal(largestDepositYocto("res3", { challengeBondYocto: BOND }), 0n);
});

test("the shipped testnet funding map clears the preflight at the real gas price", () => {
  // Mirrors the `funding` object in proof/controlled-v3-deploy.mjs.
  const funding = { contract: 6, owner: 0.8, buyer: 0.3, attacker: 0.35 };
  for (let i = 1; i <= 5; i++) { funding[`op${i}`] = 0.15; funding[`res${i}`] = 0.15; }
  const short = underfundedRoles(funding, { gasLimit: NEW_GAS, gasPriceYocto: TESTNET_GAS_PRICE, challengeBondYocto: BOND });
  assert.deepEqual(short, [], `unexpected shortfalls: ${JSON.stringify(short)}`);
});

test("the ORIGINAL config (300 Tgas, 0.1 op/res, 0.3 buyer) is rejected — the bug is caught", () => {
  const original = { contract: 6, owner: 1, buyer: 0.3, attacker: 0.3 };
  for (let i = 1; i <= 5; i++) { original[`op${i}`] = 0.1; original[`res${i}`] = 0.1; }
  const short = underfundedRoles(original, { gasLimit: ORIGINAL_GAS, gasPriceYocto: TESTNET_GAS_PRICE, challengeBondYocto: BOND });
  const roles = short.map((s) => s.role);
  assert.ok(roles.includes("op1") && roles.includes("res5"), "every 0.1-funded signer must be flagged");
  assert.ok(roles.includes("buyer"), "the buyer (0.3) must be flagged: it needs 0.015 premium + 0.3 float");
  assert.ok(roles.includes("attacker"), "the attacker (0.3) must be flagged: it needs 0.1 bond + 0.3 float");
  assert.ok(!roles.includes("contract"), "the contract account is not a signer and must not be flagged");
});

test("the sandbox funding map (gas price ~0) passes even at the legacy amounts", () => {
  const legacy = { contract: 30, owner: 5, buyer: 1.5, attacker: 1.5 };
  for (let i = 1; i <= 5; i++) { legacy[`op${i}`] = 0.5; legacy[`res${i}`] = 0.5; }
  const short = underfundedRoles(legacy, { gasLimit: ORIGINAL_GAS, gasPriceYocto: 0n, challengeBondYocto: BOND });
  assert.deepEqual(short, []);
});

test("YOCTO_PER_NEAR is exact", () => {
  assert.equal(YOCTO_PER_NEAR, 10n ** 24n);
});
