// Overcover agent service.
//
// A small, dependency-free HTTP API in front of the autonomous agent. It runs
// on the operator's own machine (or their own host) and holds the agent key in
// the environment — never in the browser, never in this repository, never in a
// public deployment.
//
//   OVERCOVER_AGENT_ACCOUNT=agent.example.testnet \
//   OVERCOVER_AGENT_SECRET_KEY=ed25519:... \
//   node agent/server.mjs
//
// Why a local service and not a public one: a public endpoint that signs with a
// funded key would let any anonymous visitor spend that key's balance. Keeping
// the key on the operator's machine is the only honest way to run the agent.
//
// Security properties enforced here:
//   * Request bodies are size-limited and strictly validated; unknown fields are
//     rejected. Oversized or malformed bodies get 4xx, never a partial execution.
//   * Every buy goes through agent/limits.mjs. A denied buy never touches the
//     network (see agent.mjs), so no funds move on a refusal.
//   * Idempotency keys make a retried buy return the original result instead of
//     buying twice.
//   * The key is never logged or returned.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, AgentError } from "./agent.mjs";
import { normalizeLimits } from "./limits.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.OVERCOVER_AGENT_PORT ?? 8787);
const HOST = process.env.OVERCOVER_AGENT_HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024;

// CORS: the public console may call a locally-run agent service. Only the
// methods and headers the API actually uses are allowed; credentials are not.
const ALLOWED_ORIGINS = (process.env.OVERCOVER_AGENT_ORIGINS ?? "https://itzebe.github.io,http://localhost:8787,http://127.0.0.1:8787")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  const h = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Idempotency-Key";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

function send(res, status, body, extra = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        // Do not destroy the socket: that would deny the client the 413. Stop
        // accumulating and let the request drain so the response can be sent.
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const INT_RE = /^[0-9]+$/;
function asYocto(v, name) {
  if (typeof v !== "string" && typeof v !== "number") throw Object.assign(new Error(`${name} must be a decimal string`), { status: 400 });
  const s = String(v);
  if (!INT_RE.test(s)) throw Object.assign(new Error(`${name} must be a non-negative integer string`), { status: 400 });
  return s;
}

function assertFields(obj, allowed, name) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw Object.assign(new Error(`unknown field "${k}" in ${name}`), { status: 400 });
  }
}

const AUDIT_PATH = process.env.OVERCOVER_AGENT_AUDIT ?? path.join(root, "agent", "audit.log.jsonl");

async function main() {
  const accountId = process.env.OVERCOVER_AGENT_ACCOUNT;
  const secretKey = process.env.OVERCOVER_AGENT_SECRET_KEY;
  const contractId = process.env.OVERCOVER_AGENT_CONTRACT ?? "contract.attestor-overcover.testnet";
  const dryRun = process.env.OVERCOVER_AGENT_DRY_RUN === "1";

  let limits = {};
  if (process.env.OVERCOVER_AGENT_LIMITS) {
    try { limits = JSON.parse(process.env.OVERCOVER_AGENT_LIMITS); }
    catch { console.error("OVERCOVER_AGENT_LIMITS is not valid JSON"); process.exit(1); }
  }
  limits = normalizeLimits(limits);

  if (!accountId || !secretKey) {
    console.error("set OVERCOVER_AGENT_ACCOUNT and OVERCOVER_AGENT_SECRET_KEY (the key is read from the environment only).");
    process.exit(1);
  }

  const agent = await createAgent({ accountId, secretKey, contractId, limits, auditPath: AUDIT_PATH, dryRun });
  const idempotency = new Map(); // key -> settled result

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin);
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /api/v1/health") {
        return send(res, 200, { ok: true, service: "overcover-agent", accountId, contractId, dryRun, enabled: agent.status().enabled }, cors);
      }

      if (route === "GET /api/v1/agent") {
        let balanceYocto = null;
        try { balanceYocto = await agent.balanceYocto(); } catch { /* uninitialised account is fine */ }
        return send(res, 200, { ...agent.status(), balanceYocto }, cors);
      }

      if (route === "GET /api/v1/agent/audit") {
        let lines = [];
        try { lines = fs.readFileSync(AUDIT_PATH, "utf8").trim().split("\n").slice(-50).map((l) => JSON.parse(l)); } catch {}
        return send(res, 200, { entries: lines }, cors);
      }

      if (route === "POST /api/v1/agent/quote") {
        const body = await readBody(req);
        assertFields(body, ["productId", "payoutYocto"], "quote");
        const payout = asYocto(body.payoutYocto, "payoutYocto");
        if (typeof body.productId !== "string") throw Object.assign(new Error("productId must be a string"), { status: 400 });
        const premiumYocto = await agent.quote(body.productId, payout);
        return send(res, 200, { productId: body.productId, payoutYocto: payout, premiumYocto }, cors);
      }

      if (route === "POST /api/v1/agent/decide") {
        const body = await readBody(req);
        assertFields(body, ["productId", "payoutYocto", "obsDateSec"], "decide");
        const payout = asYocto(body.payoutYocto, "payoutYocto");
        const obsDateSec = Number(body.obsDateSec);
        if (!Number.isInteger(obsDateSec) || obsDateSec < 0) throw Object.assign(new Error("obsDateSec must be a unix-seconds integer"), { status: 400 });
        if (typeof body.productId !== "string") throw Object.assign(new Error("productId must be a string"), { status: 400 });
        const d = await agent.decide({ productId: body.productId, payoutYocto: payout, obsDateSec });
        return send(res, 200, { allow: d.allow, reasons: d.reasons, premiumYocto: d.premiumYocto }, cors);
      }

      if (route === "POST /api/v1/agent/buy") {
        const body = await readBody(req);
        assertFields(body, ["productId", "payoutYocto", "obsDateSec", "beneficiary", "idempotencyKey"], "buy");
        const payout = asYocto(body.payoutYocto, "payoutYocto");
        const obsDateSec = Number(body.obsDateSec);
        if (!Number.isInteger(obsDateSec) || obsDateSec < 0) throw Object.assign(new Error("obsDateSec must be a unix-seconds integer"), { status: 400 });
        if (typeof body.productId !== "string") throw Object.assign(new Error("productId must be a string"), { status: 400 });
        const idem = body.idempotencyKey ?? req.headers["idempotency-key"];
        if (idem !== undefined && (typeof idem !== "string" || idem.length > 200)) throw Object.assign(new Error("idempotencyKey must be a string <= 200 chars"), { status: 400 });
        if (idem && idempotency.has(idem)) return send(res, 200, { ...idempotency.get(idem), idempotentReplay: true }, cors);

        const result = await agent.buy({ productId: body.productId, payoutYocto: payout, obsDateSec, beneficiary: body.beneficiary ?? null, idempotencyKey: idem ?? null });
        if (idem) idempotency.set(idem, result);
        return send(res, 200, result, cors);
      }

      if (route === "POST /api/v1/agent/control") {
        const body = await readBody(req);
        assertFields(body, ["enabled"], "control");
        if (typeof body.enabled !== "boolean") throw Object.assign(new Error("enabled must be a boolean"), { status: 400 });
        const enabled = agent.setEnabled(body.enabled);
        return send(res, 200, { enabled }, cors);
      }

      return send(res, 404, { error: "not_found", route }, cors);
    } catch (e) {
      if (e instanceof AgentError) {
        const status = e.code === "denied" ? 403 : e.code === "config" ? 500 : 502;
        return send(res, status, { error: e.code, message: e.message, reasons: e.reasons }, cors);
      }
      const status = e.status ?? 500;
      return send(res, status, { error: "bad_request", message: e.message }, cors);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Overcover agent service on http://${HOST}:${PORT}`);
    console.log(`  agent:    ${accountId}`);
    console.log(`  contract: ${contractId}`);
    console.log(`  dry run:  ${dryRun}`);
    console.log(`  limits:   ${JSON.stringify(agent.status().limits)}`);
  });
}

main().catch((e) => { console.error("agent service failed to start:", e.message); process.exit(1); });
