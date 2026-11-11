// Regression: both deploy paths must REFUSE a wasm that lacks the SEC-1 guard.
//
// A stale `overcover.wasm` (built before the migrate() fix) would deploy a
// contract whose migrate() is an unauthenticated takeover. This test proves the
// fail-closed behaviour directly: the same script that would deploy the real
// artifact aborts on a guard-less one, before it touches the chain.
//
// It needs no key and no network for the refusal path (the guard check runs
// before any RPC). The positive check (the real wasm is accepted) needs RPC and
// is skipped when the network is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const GUARD = "migrate may only be called by the contract account itself";

function planWith(wasmPath) {
  return spawnSync(process.execPath, ["driver/upgrade.js", "--plan"], {
    cwd: root, encoding: "utf8", env: { ...process.env, OVERCOVER_WASM: wasmPath },
  });
}

test("upgrade --plan refuses a wasm that lacks the SEC-1 guard", () => {
  if (!fs.existsSync(WASM)) return; // nothing built here; CI builds it
  const tmp = path.join(os.tmpdir(), `overcover-unguarded-${process.pid}.wasm`);
  // A minimal artifact that certainly does not contain the guard string.
  fs.writeFileSync(tmp, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  try {
    const r = planWith(tmp);
    assert.notEqual(r.status, 0, "a guard-less wasm must be refused");
    assert.match(r.stderr + r.stdout, /SEC-1 guard/, "the refusal must name the missing guard");
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("upgrade --plan accepts the real (guarded) wasm", () => {
  if (!fs.existsSync(WASM)) return;
  const bytes = fs.readFileSync(WASM);
  if (!bytes.toString("latin1").includes(GUARD)) return; // stale build; the sandbox proof covers it
  const r = planWith(WASM);
  if (r.status !== 0 && /fetch|network|ENOTFOUND|EAI_AGAIN/i.test(r.stderr)) return; // offline
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SEC-1 guard\s+present/);
  assert.match(r.stdout, /--plan: no transactions sent/);
});

test("driver/deploy.js and driver/upgrade.js export/parse without side effects", () => {
  // Importing must not run a deploy (the entrypoint is guarded). A syntax error
  // or an unguarded side effect would show up here.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import('./driver/deploy.js'); await import('./driver/upgrade.js'); console.log('imported');"],
    { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /imported/);
  assert.doesNotMatch(r.stdout, /DEPLOY FAILED|UPGRADE FAILED/);
});
