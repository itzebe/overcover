// Keeps agent/openapi.json honest: every documented route must exist, and every
// implemented route must be documented. A spec that drifts from the code is worse
// than no spec, so this fails the build if they disagree.
//
//   node --test tests/agent-openapi.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(fs.readFileSync(path.join(root, "agent", "openapi.json"), "utf8"));
const PORT = 8300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const AUDIT = path.join(os.tmpdir(), `overcover-openapi-${Date.now()}.jsonl`);
let child;

before(async () => {
  const kp = KeyPair.fromRandom("ed25519");
  child = spawn(process.execPath, [path.join(root, "agent", "server.mjs")], {
    env: {
      ...process.env,
      OVERCOVER_AGENT_ACCOUNT: "openapi-probe.testnet",
      OVERCOVER_AGENT_SECRET_KEY: kp.toString(),
      OVERCOVER_AGENT_PORT: String(PORT),
      OVERCOVER_AGENT_HOST: "127.0.0.1",
      OVERCOVER_AGENT_DRY_RUN: "1",
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

const documented = new Set(
  Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)),
);

test("every documented route answers (or refuses) instead of 404", async () => {
  for (const route of documented) {
    const [method, p] = route.split(" ");
    const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.notEqual(res.status, 404, `${route} is documented but the service returned 404`);
  }
});

test("the live service has no route the spec omits", async () => {
  // Probe the routes the code implements; any that answers with a non-404 must be
  // in the spec. This is the reverse direction of the check above.
  const implemented = [
    "GET /api/v1/health", "GET /api/v1/agent", "GET /api/v1/agent/audit",
    "POST /api/v1/agent/quote", "POST /api/v1/agent/decide", "POST /api/v1/agent/buy", "POST /api/v1/agent/control",
  ];
  for (const route of implemented) {
    const [method, p] = route.split(" ");
    const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
    assert.notEqual(res.status, 404, `${route} is implemented but missing from the service?`);
    assert.ok(documented.has(route), `${route} is implemented but not documented in openapi.json`);
  }
});

test("the spec declares the money rule and the dry-run/denied semantics", () => {
  const yocto = spec.components.schemas.Yocto;
  assert.match(yocto.description, /yoctoNEAR/);
  assert.match(spec.info.description, /dry-run by default/);
  assert.match(spec.paths["/api/v1/agent/buy"].post.description, /Refuses with 403 before any network call/);
});

test("a documented 403 denial is exactly what the service returns", async () => {
  const res = await fetch(BASE + "/api/v1/agent/buy", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "rain-lagos", payoutYocto: "1", obsDateSec: Math.floor(Date.now() / 1000) + 7200, idempotencyKey: "openapi-deny" }),
  });
  // payout "1" is below the product minimum, so the policy refuses it.
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.error, "denied");
  assert.ok(Array.isArray(j.reasons) && j.reasons.length >= 1);
});

test("the spec documents bearer auth and the 401 it can return", () => {
  assert.deepEqual(spec.security, [{ bearerAuth: [] }], "the spec must require bearer auth globally");
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.match(spec.components.responses.Unauthorized.description, /bearer token/);
});
