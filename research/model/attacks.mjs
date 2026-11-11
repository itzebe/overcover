// Overcover — adversarial + lifecycle suite (reference model).
//
//   node research/model/attacks.mjs   (npm run test:model)
//
// This runs the SHARED scenario suite (sim/scenarios.mjs) against the
// deterministic reference model (sim/engine.mjs). The suite is the single
// source of truth for the v2 design; it is also run by sim/run.mjs (which writes
// sim/evidence.json) and by tests/model.test.mjs (node --test).
//
// Every scenario asserts real state (balances, reservations, policy status,
// signatures), not just "did not throw". An EXPLOITABLE outcome fails the run,
// so this doubles as a regression gate mirrored by the Rust unit tests.
//
// NOTHING HERE TOUCHES THE CHAIN. These are simulated outcomes.

import { ContractError } from "../../sim/engine.mjs";
import { runScenarios } from "../../sim/scenarios.mjs";

const results = [];
let failures = 0;

function check(id, group, desc, expected, actual, ok, note = "") {
  results.push({ id, group, desc, ok: !!ok });
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${id}  ${desc}  (expected ${expected} / actual ${actual}${note ? ` — ${note}` : ""})`);
  }
}

function expectThrow(id, group, desc, fn) {
  try {
    fn();
    check(id, group, desc, "rejected", "ACCEPTED", false);
  } catch (e) {
    if (e instanceof ContractError) check(id, group, desc, "rejected", "rejected", true);
    else check(id, group, desc, "rejected", `unexpected: ${e.message}`, false, e.stack);
  }
}

runScenarios({ check, expectThrow, log: () => {} });

const passed = results.filter((r) => r.ok).length;
console.log(`\nOvercover reference model: ${passed}/${results.length} scenarios defended, ${failures} exploitable.`);
if (failures) {
  console.error(`\n${failures} scenario(s) FAILED — see above.`);
  process.exit(1);
}
console.log("All scenarios defended. 0 exploitable.");
