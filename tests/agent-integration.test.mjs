// Independent integration test: a client that knows ONLY the public interface.
//
//   node --test tests/agent-integration.test.mjs
//
// Nothing here reads repository internals to decide what to do. The client
// (agent/sdk.mjs) starts from the published catalogue (ui/products.json), the
// published schema, and the documented agent HTTP API — exactly what an outside
// integrator has. It then walks the whole flow against the REAL service in
// dry-run: discover -> quote -> decide -> buy (dry) -> over-limit refusal ->
// replay. No funds move: the service is in dry-run, and every mutation route is
// either refused by policy before execution or short-circuited by dry-run.
//
// This is the check that the integration "actually works for an independent
// client", not merely that the pieces exist.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { AgentClient, AgentClientError } from "../agent/sdk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const AUDIT = path.join(os.tmpdir(), `overcover-integration-${Date.now()}.jsonl`);

const feed = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.schema.json"), "utf8"));

let child;

// ---------------------------------------------------------- minimal validator
// A tiny draft-2020-12 subset validator, so this client does not depend on the
// repository's own test helper. If an outside integrator can validate the feed
// with a few lines, the schema is genuinely usable.
function validate(node, data, defs, pathStr = "$", errs = []) {
  if (node.$ref) return validate(defs[node.$ref.replace("#/$defs/", "")], data, defs, pathStr, errs);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v);
  if (node.type) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    const got = typeOf(data);
    const ok = allowed.some((a) => (a === "integer" ? got === "number" && Number.isInteger(data) : a === got));
    if (!ok) { errs.push(`${pathStr}: expected ${allowed.join("|")}, got ${got}`); return errs; }
  }
  if (node.const !== undefined && JSON.stringify(data) !== JSON.stringify(node.const)) errs.push(`${pathStr}: expected const ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(data)) errs.push(`${pathStr}: not in enum`);
  if (node.pattern && typeof data === "string" && !new RegExp(node.pattern).test(data)) errs.push(`${pathStr}: fails pattern`);
  if (typeOf(data) === "object") {
    for (const req of node.required || []) if (!(req in data)) errs.push(`${pathStr}: missing required ${req}`);
    for (const [k, v] of Object.entries(data)) if (node.properties?.[k]) validate(node.properties[k], v, defs, `${pathStr}.${k}`, errs);
  }
  if (typeOf(data) === "array" && node.items) data.forEach((v, i) => validate(node.items, v, defs, `${pathStr}[${i}]`, errs));
  return errs;
}

before(async () => {
  const kp = KeyPair.fromRandom("ed25519");
  child = spawn(process.execPath, [path.join(root, "agent", "server.mjs")], {
    env: {
      ...process.env,
      OVERCOVER_AGENT_ACCOUNT: "integration-client.testnet",
      OVERCOVER_AGENT_SECRET_KEY: kp.toString(),
      OVERCOVER_AGENT_PORT: String(PORT),
      OVERCOVER_AGENT_HOST: "127.0.0.1",
      OVERCOVER_AGENT_DRY_RUN: "1",
      OVERCOVER_AGENT_LIMITS: JSON.stringify({ maxPremiumPerPolicy: "100000000000000000000000", maxPayoutPerPolicy: "2000000000000000000000000", dailyPremiumBudget: "1000000000000000000000000", dailyPolicyLimit: 3, cooldownSec: 0, allowedProducts: ["rain-lagos"] }),
      OVERCOVER_AGENT_AUDIT: AUDIT,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(BASE + "/api/v1/health")).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error("agent service did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => { if (child) child.kill("SIGTERM"); fs.rmSync(AUDIT, { force: true }); });

// ---------------------------------------------------------------- catalogue

test("an outside client can validate the published feed against the published schema", () => {
  const errs = validate(schema, feed, schema.$defs || {});
  assert.deepEqual(errs, [], errs.join("\n"));
});

test("the feed lets a client find a buyable product with no hidden knowledge", () => {
  const buyable = feed.products.filter((p) => p.sellable === true);
  assert.ok(buyable.length >= 1, "at least one product must be offered");
  assert.deepEqual([...feed.offerings].sort(), buyable.map((p) => p.id).sort());
  const p = buyable[0];
  assert.equal(feed.source.network, "testnet");
  assert.match(feed.source.contract, /\.testnet$/);
  assert.equal(p.trigger.direction, "at-or-above");
  assert.match(p.trigger.statement, /at or above/);
  // Every money field the client needs is an exact digit string.
  assert.match(p.payout.max_yocto, /^[0-9]+$/);
  assert.match(p.premium.example_at_max_payout.premium_yocto, /^[0-9]+$/);
  assert.equal(p.purchase.method, "buy_cover");
});

test("the feed's example premium equals ceil(payout * bp / 10000)", () => {
  for (const p of feed.products) {
    const ex = p.premium.example_at_max_payout;
    const expected = ((BigInt(ex.payout_yocto) * BigInt(p.premium.basis_points) + 9999n) / 10000n).toString();
    assert.equal(ex.premium_yocto, expected, `${p.id} example premium is wrong`);
  }
});

test("a non-offered entry is clearly labelled so a client does not buy it by accident", () => {
  for (const p of feed.products) {
    if (!p.sellable) assert.equal(p.status, "not-offered");
    else assert.equal(p.status, "available");
  }
});

// ---------------------------------------------------------------- agent API

test("the client walks discover -> quote -> decide -> buy (dry run) with no funds", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  const health = await c.health();
  assert.equal(health.ok, true);
  assert.equal(health.dryRun, true);
  assert.equal(health.accountId, "integration-client.testnet");

  const product = feed.products.find((p) => p.sellable);
  const payout = product.payout.max_yocto;
  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;

  const q = await c.quote(product.id, payout);
  assert.match(String(q.premiumYocto), /^[0-9]+$/);
  assert.equal(q.premiumYocto, product.premium.example_at_max_payout.premium_yocto, "the service must charge the catalogue's premium");

  const d = await c.decide({ productId: product.id, payoutYocto: payout, obsDateSec });
  assert.equal(d.allow, true, d.reasons.join("; "));

  const res = await c.buy({ productId: product.id, payoutYocto: payout, obsDateSec, idempotencyKey: `it-${Date.now()}` });
  assert.equal(res.dryRun, true, "dry run must not send a transaction");
  assert.equal(res.premiumYocto, q.premiumYocto);
});

test("an over-limit purchase is refused with 403 and explicit reasons, before execution", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  const product = feed.products.find((p) => p.sellable);
  const tooBig = (10n * 10n ** 24n).toString(); // 10 NEAR, far above the 2 NEAR payout cap
  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;

  await assert.rejects(
    () => c.buy({ productId: product.id, payoutYocto: tooBig, obsDateSec, idempotencyKey: `over-${Date.now()}` }),
    (e) => {
      assert.ok(e instanceof AgentClientError);
      assert.equal(e.status, 403);
      assert.equal(e.code, "denied");
      assert.ok(e.reasons.length >= 1, "the refusal must explain itself");
      return true;
    },
  );
});

test("a purchase for a product outside the allow-list is refused", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;
  await assert.rejects(
    () => c.buy({ productId: "rain-bergen-dry", payoutYocto: "1000000000000000000000000", obsDateSec, idempotencyKey: `list-${Date.now()}` }),
    (e) => { assert.equal(e.status, 403); assert.match(e.reasons.join(" "), /allowedProducts|not in/); return true; },
  );
});

test("replaying an idempotency key returns the original result and does not buy twice", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  const product = feed.products.find((p) => p.sellable);
  const payout = product.payout.max_yocto;
  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;
  const key = `replay-${Date.now()}`;

  const first = await c.buy({ productId: product.id, payoutYocto: payout, obsDateSec, idempotencyKey: key });
  const second = await c.buy({ productId: product.id, payoutYocto: payout, obsDateSec, idempotencyKey: key });
  assert.equal(second.idempotentReplay, true, "the retry must be flagged as a replay");
  assert.equal(second.premiumYocto, first.premiumYocto);
});

test("a malformed request is rejected with 400, not silently accepted", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  await assert.rejects(
    () => c.buy({ productId: "rain-lagos", payoutYocto: "not-a-number", obsDateSec: Math.floor(Date.now() / 1000) + 7200 }),
    (e) => { assert.equal(e.status, 400); return true; },
  );
});

test("the kill switch disables every purchase and re-enabling restores it", async () => {
  const c = new AgentClient({ baseUrl: BASE });
  const product = feed.products.find((p) => p.sellable);
  const payout = product.payout.max_yocto;
  const obsDateSec = Math.floor(Date.now() / 1000) + 7200;

  await c.setEnabled(false);
  await assert.rejects(
    () => c.buy({ productId: product.id, payoutYocto: payout, obsDateSec, idempotencyKey: `kill-${Date.now()}` }),
    (e) => { assert.equal(e.status, 403); assert.match(e.reasons.join(" "), /disabled/); return true; },
  );
  await c.setEnabled(true);
  const ok = await c.decide({ productId: product.id, payoutYocto: payout, obsDateSec });
  assert.equal(ok.allow, true);
});
