// Tests for the agent HTTP service boundary.
//
// These start the REAL server (agent/server.mjs) as a child process with a
// dry-run agent and a throwaway key, then exercise the request boundary over
// HTTP. Nothing here can move funds: the agent is in dry-run mode and every
// mutation route is either rejected before execution or short-circuited by a
// policy refusal. Public testnet RPC is read-only and keyless.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function startServer() {
  return new Promise((resolve, reject) => {
    const kp = KeyPair.fromRandom("ed25519");
    child = spawn(process.execPath, [path.join(root, "agent", "server.mjs")], {
      env: {
        ...process.env,
        OVERCOVER_AGENT_ACCOUNT: "agent-probe.testnet",
        OVERCOVER_AGENT_SECRET_KEY: kp.toString(),
        OVERCOVER_AGENT_PORT: String(PORT),
        OVERCOVER_AGENT_HOST: "127.0.0.1",
        OVERCOVER_AGENT_DRY_RUN: "1",
        OVERCOVER_AGENT_LIMITS: JSON.stringify({ maxPremiumPerPolicy: "10000000000000000000000", maxPayoutPerPolicy: "100000000000000000000000", dailyPremiumBudget: "100000000000000000000000", dailyPolicyLimit: 3, cooldownSec: 0 }),
        OVERCOVER_AGENT_AUDIT: path.join(root, "agent", "audit.test.log.jsonl"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    const deadline = Date.now() + 15000;
    (async function poll() {
      try {
        const r = await fetch(BASE + "/api/v1/health");
        if (r.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server did not start"));
      setTimeout(poll, 250);
    })();
  });
}

before(startServer);
after(() => { if (child) child.kill("SIGTERM"); });

test("health reports the service identity without any secret", async () => {
  const r = await fetch(BASE + "/api/v1/health");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.service, "overcover-agent");
  assert.equal(j.accountId, "agent-probe.testnet");
  assert.equal(j.dryRun, true);
  assert.ok(!JSON.stringify(j).match(/ed25519/), "no key material may appear in health output");
});

test("an oversized request body is rejected with 413 and no execution", async () => {
  const big = "x".repeat(20 * 1024);
  const r = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: big }) });
  assert.equal(r.status, 413);
});

test("a malformed JSON body is rejected with 400", async () => {
  const r = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /JSON/);
});

test("an unknown field is rejected with 400 (no silent acceptance)", async () => {
  const r = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "1", obsDateSec: 1, evil: true }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /unknown field/);
});

test("a non-integer payout is rejected with 400", async () => {
  const r = await fetch(BASE + "/api/v1/agent/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "1e5" }) });
  assert.equal(r.status, 400);
});

test("a non-integer observation date is rejected with 400", async () => {
  const r = await fetch(BASE + "/api/v1/agent/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "1", obsDateSec: "soon" }) });
  assert.equal(r.status, 400);
});

test("a disabled agent refuses a buy with 403 and reasons, before the network", async () => {
  await fetch(BASE + "/api/v1/agent/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  const r = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "100000000000000000000000", obsDateSec: Math.floor(Date.now() / 1000) + 7200 }) });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.equal(j.error, "denied");
  assert.match(j.reasons.join(" "), /disabled/);
});

test("re-enabling the agent restores evaluation", async () => {
  const r = await fetch(BASE + "/api/v1/agent/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).enabled, true);
});

test("control rejects a non-boolean enabled flag", async () => {
  const r = await fetch(BASE + "/api/v1/agent/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "yes" }) });
  assert.equal(r.status, 400);
});

test("an unknown route is a 404", async () => {
  const r = await fetch(BASE + "/api/v1/nope");
  assert.equal(r.status, 404);
});

test("decide on an unknown product returns allow:false with a reason", async () => {
  const r = await fetch(BASE + "/api/v1/agent/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId: "does-not-exist", payoutYocto: "100000000000000000000000", obsDateSec: Math.floor(Date.now() / 1000) + 7200 }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.allow, false);
  assert.match(j.reasons.join(" "), /no such product/);
});

// Idempotency: a retried buy with the same key returns the original result and
// must NOT execute a second time. The audit log is the proof: a replayed request
// must not append a second dry_run entry.
const AUDIT = path.join(root, "agent", "audit.test.log.jsonl");
function countKind(kind) {
  try {
    return fs.readFileSync(AUDIT, "utf8").trim().split("\n")
      .map((l) => JSON.parse(l)).filter((e) => e.kind === kind).length;
  } catch { return 0; }
}
const buyBody = (idempotencyKey) => JSON.stringify({
  productId: "rain-lagos",
  payoutYocto: "100000000000000000000000",
  obsDateSec: Math.floor(Date.now() / 1000) + 7200,
  idempotencyKey,
});

test("a replayed idempotency key returns the original result without re-executing", async () => {
  const key = `idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const before = countKind("dry_run");
  const r1 = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody(key) });
  assert.equal(r1.status, 200);
  const first = await r1.json();
  assert.equal(first.dryRun, true, "the dry-run agent must not send a transaction");
  assert.ok(!first.idempotentReplay, "the first call is not a replay");
  const afterFirst = countKind("dry_run");
  assert.equal(afterFirst, before + 1, "the first buy must be evaluated once");

  const r2 = await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody(key) });
  assert.equal(r2.status, 200);
  const second = await r2.json();
  assert.equal(second.idempotentReplay, true, "the retry must be flagged as a replay");
  assert.equal(second.premiumYocto, first.premiumYocto, "the replay must return the original premium");
  assert.equal(countKind("dry_run"), afterFirst, "a replayed key must not execute again");
});

test("a different idempotency key is a fresh evaluation", async () => {
  const before = countKind("dry_run");
  await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody(`idem-a-${Date.now()}`) });
  await fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody(`idem-b-${Date.now()}`) });
  assert.equal(countKind("dry_run"), before + 2, "distinct keys must each be evaluated");
});

test("concurrent buys with the same idempotency key execute exactly once", async () => {
  // The check-then-act pattern is unsafe under concurrency: two requests that
  // arrive together both see "key unknown" and both execute. The server must
  // reserve the key before the first await. The audit log is the proof — a
  // single dry_run entry means a single execution.
  const key = `idem-concurrent-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const before = countKind("dry_run");
  const fire = () => fetch(BASE + "/api/v1/agent/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: buyBody(key) });
  const [r1, r2] = await Promise.all([fire(), fire()]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const [a, b] = await Promise.all([r1.json(), r2.json()]);
  assert.equal(countKind("dry_run"), before + 1, "two concurrent identical keys must execute once, not twice");
  const replays = [a, b].filter((x) => x.idempotentReplay);
  assert.equal(replays.length, 1, "exactly one of the two concurrent responses is a replay");
  assert.equal(replays[0].premiumYocto, (a.idempotentReplay ? b : a).premiumYocto, "the replay returns the original premium");
});
