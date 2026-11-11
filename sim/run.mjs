// Overcover — the full-lifecycle + adversarial simulation harness.
//
//   node sim/run.mjs          (or: npm run simulate:full)
//
// It boots a deterministic, network-free instance of the reference model
// (sim/engine.mjs), runs the complete insurance lifecycle across several risk
// categories for both a human and an autonomous agent, then runs an adversarial
// matrix. Every scenario asserts REAL state (balances, reservations, policy
// status), not just "did not throw".
//
// EVERYTHING HERE IS SIMULATED. It never touches NEAR. The results are written
// to sim/evidence.json with `"mode": "SIMULATED"` and must never be presented as
// on-chain evidence.
//
// Exit code is non-zero if any required scenario or invariant fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "./engine.mjs";
import { runScenarios } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const results = [];
let failures = 0;

function check(id, group, desc, expected, actual, ok, note = "") {
  results.push({ id, group, desc, expected: String(expected), actual: String(actual), ok: !!ok, note });
  if (!ok) failures += 1;
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  ${tag}  ${id}  ${desc}`);
  if (!ok) console.log(`         expected ${expected} / actual ${actual}${note ? ` (${note})` : ""}`);
}

function expectThrow(id, group, desc, fn) {
  try {
    fn();
    check(id, group, desc, "rejected", "ACCEPTED", false);
  } catch (e) {
    if (e instanceof ContractError) check(id, group, desc, "rejected", `rejected: ${e.message}`, true);
    else check(id, group, desc, "rejected", `unexpected: ${e.message}`, false, e.stack);
  }
}

runScenarios({ check, expectThrow, log: (s = "") => console.log(s) });

const passed = results.filter((r) => r.ok).length;
const total = results.length;

const evidence = {
  mode: "SIMULATED",
  note: "Deterministic reference-model simulation. NOT on-chain. Do not present as a NEAR transaction.",
  generatedAt: new Date().toISOString(),
  engine: "sim/engine.mjs",
  scenarios_source: "sim/scenarios.mjs",
  totals: { scenarios: total, passed, failed: total - passed },
  scenarios: results,
};

fs.writeFileSync(path.join(here, "evidence.json"), JSON.stringify(evidence, null, 2));

console.log(`\n${passed}/${total} scenarios passed${failures ? ` — ${failures} FAILED` : ""}.`);
console.log(`Evidence written to sim/evidence.json (mode: SIMULATED).`);
process.exit(failures ? 1 : 0);
