// node --test wrapper for the shared v2 scenario suite.
//
// The scenarios live in sim/scenarios.mjs (one source of truth, also run by
// sim/run.mjs and research/model/attacks.mjs). This wrapper exposes each
// scenario as an individual `node --test` subtest so a failure is attributed to
// exactly one scenario id.
//
// Nothing here touches the chain — these are simulated outcomes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractError } from "../sim/engine.mjs";
import { runScenarios } from "../sim/scenarios.mjs";

const collected = [];
let failures = 0;

function check(id, group, desc, expected, actual, ok, note = "") {
  collected.push({ id, group, desc, expected: String(expected), actual: String(actual), ok: !!ok, note });
  if (!ok) failures += 1;
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

test("reference model: every lifecycle + adversarial scenario holds", () => {
  assert.ok(collected.length >= 60, `expected at least 60 scenarios, collected ${collected.length}`);
  const failed = collected.filter((c) => !c.ok);
  const detail = failed.map((c) => `${c.id} ${c.desc}: expected ${c.expected}, got ${c.actual}`).join("\n");
  assert.equal(failed.length, 0, `${failed.length} scenario(s) failed:\n${detail}`);
});

for (const c of collected) {
  test(`model ${c.id}: ${c.desc}`, () => {
    assert.ok(c.ok, `expected ${c.expected}, got ${c.actual}${c.note ? ` — ${c.note}` : ""}`);
  });
}
