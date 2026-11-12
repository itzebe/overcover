// Regression: the controlled-v3 deployment harness must PROVE the permissionless
// factory, not merely deploy a wasm that contains it.
//
// The harness cannot "report success without a genuine non-owner proposal and a
// successful factory-product purchase": its summary is derived from the same
// `results` array every check pushes to, and `process.exitCode` is set when any
// check fails. This test pins the structure that makes that true, and exercises
// the two fail-closed behaviours that need no funds and no network.
//
// Structural assertions (the harness runs on import, so it is read as source, not
// imported):
//   * an independent `proposer` sub-account exists, distinct from the owner;
//   * `propose_product` is signed ONLY by the proposer, never the owner;
//   * activation, proposer-recording, evidence-hash, stake and listing are checked;
//   * at least one bad proposal must be refused;
//   * a buyer purchases cover on the factory-created product and the payout is
//     reserved, the pool stays solvent and reconciles;
//   * the factory block runs AFTER the lifecycle settles (reserved back to 0), so
//     it cannot be satisfied by the owner's own product purchase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(root, "proof", "controlled-v3-deploy.mjs");
const WASM = path.join(root, "contract/target/wasm32-unknown-unknown/release/overcover.wasm");
const SRC = fs.readFileSync(HARNESS, "utf8");

test("the harness creates an independent proposer, distinct from the owner", () => {
  assert.match(SRC, /const proposer = await sub\("proposer"/, "a proposer sub-account must be created");
  assert.match(SRC, /check\("the proposer is a distinct account from the owner"/, "proposer != owner must be asserted");
});

test("propose_product is signed ONLY by the proposer, never the owner", () => {
  assert.match(SRC, /call\(proposer, "propose_product"/, "the proposer must sign the proposal");
  assert.doesNotMatch(SRC, /call\(owner, "propose_product"/, "the owner must never stand in for the proposer");
});

test("the harness asserts activation, proposer, evidence hash, stake and listing", () => {
  assert.match(SRC, /a NON-OWNER proposal activates a product with no owner transaction/);
  assert.match(SRC, /records the proposer \(not the owner\)/);
  assert.match(SRC, /proposed_by === proposer\.id && fprod\.proposed_by !== owner\.id/, "the proposer AND non-owner must be asserted");
  assert.match(SRC, /carries the immutable evidence hash/);
  assert.match(SRC, /the proposal stake entered the pool/);
  assert.match(SRC, /appears in the public product list/);
});

test("at least one adversarial factory proposal must be refused", () => {
  assert.match(SRC, /the factory refuses a proposal on an unregistered metric/);
});

test("a buyer purchases cover on the factory-created product; reserve, solvency, reconcile are checked", () => {
  assert.match(SRC, /callRet\(buyer, "buy_cover", \{ product_id: factoryId/, "buy_cover must target the factory product");
  assert.match(SRC, /a buyer purchases cover on the factory-created product/);
  assert.match(SRC, /fPol\.buyer === buyer\.id && fPol\.product_id === factoryId/, "the policy must belong to the buyer on the factory product");
  assert.match(SRC, /the factory product's payout is reserved and the pool stays solvent/);
  assert.match(SRC, /the pool reconciles after the factory purchase/);
  assert.match(SRC, /rawView\("reconcile"\)\) === true/);
});

test("the factory proof runs AFTER the lifecycle settles (reserved back to 0)", () => {
  const settleAt = SRC.indexOf("the pool released the reservation and stayed solvent");
  const factoryAt = SRC.indexOf("a NON-OWNER proposal activates a product");
  assert.ok(settleAt > 0 && factoryAt > 0, "both anchors must exist");
  assert.ok(factoryAt > settleAt, "the factory block must follow the settled lifecycle");
});

test("the summary is derived from every check, so a failed factory check fails the run", () => {
  assert.match(SRC, /const passed = results\.filter\(\(r\) => r\.ok\)\.length/);
  assert.match(SRC, /if \(passed !== results\.length\) process\.exitCode = 1/);
});

test("testnet mode never silently falls back to the faucet and never prints a key", () => {
  assert.match(SRC, /const USE_FAUCET = process\.env\.OVERCOVER_USE_FAUCET === "1"/, "the faucet must be opt-in");
  assert.match(SRC, /No funded root account supplied/, "a missing root must be reported");
  // The secret is only ever written to the gitignored file, never logged: no log
  // line may interpolate the key material or the key map.
  const logged = SRC.match(/console\.log\([^\n]*\)/g) || [];
  for (const line of logged) {
    assert.doesNotMatch(line, /keyMaterial|\$\{[^}]*secretKey|\$\{[^}]*\.toString\(\)/, `a log line must not print key material: ${line}`);
  }
});

test("testnet mode FAILS LOUDLY when no funded root is supplied (REQUIRE_TESTNET=1)", () => {
  if (!fs.existsSync(WASM)) return; // CI builds the wasm; nothing to run without it
  const r = spawnSync(process.execPath, [HARNESS], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, REQUIRE_TESTNET: "1", OVERCOVER_USE_FAUCET: "", OVERCOVER_ROOT_ACCOUNT_ID: "", OVERCOVER_ROOT_SECRET_KEY: "", OVERCOVER_ROOT_FILE: path.join(os.tmpdir(), "overcover-no-such-root.json") },
  });
  assert.notEqual(r.status, 0, "a missing root must fail, not pass");
  assert.match(r.stdout + r.stderr, /no funded root account supplied/i);
});

test("testnet mode SKIPs cleanly (exit 0) when no root is supplied and not required", () => {
  if (!fs.existsSync(WASM)) return;
  const r = spawnSync(process.execPath, [HARNESS], {
    cwd: root, encoding: "utf8", timeout: 60000,
    env: { ...process.env, REQUIRE_TESTNET: "", OVERCOVER_USE_FAUCET: "", OVERCOVER_ROOT_ACCOUNT_ID: "", OVERCOVER_ROOT_SECRET_KEY: "", OVERCOVER_ROOT_FILE: path.join(os.tmpdir(), "overcover-no-such-root.json") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIP/);
  assert.match(r.stdout, /No funded root account supplied/);
});

test("--plan sends nothing and advertises the proposer step", () => {
  const r = spawnSync(process.execPath, [HARNESS, "--plan"], { cwd: root, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--plan: nothing sent/);
  assert.match(r.stdout, /propose_product \(NON-OWNER -> activates\)/);
});
