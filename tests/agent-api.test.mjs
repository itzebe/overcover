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
