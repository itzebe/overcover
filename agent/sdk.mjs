// Minimal client SDK for the Overcover agent service.
//
//   import { AgentClient } from "./agent/sdk.mjs";
//   const c = new AgentClient({ baseUrl: "http://127.0.0.1:8787" });
//   await c.health();
//   await c.quote("rain-lagos", "1000000000000000000000000");
//   await c.buy({ productId: "rain-lagos", payoutYocto: "...", obsDateSec: 1794000000, idempotencyKey: "order-42" });
//
// The client never holds a key: the service does. It only carries requests.

export class AgentClientError extends Error {
  constructor(message, { status, code, reasons } = {}) {
    super(message);
    this.name = "AgentClientError";
    this.status = status;
    this.code = code;
    this.reasons = reasons ?? [];
  }
}

export class AgentClient {
  constructor({ baseUrl = "http://127.0.0.1:8787", fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async #req(method, path, body, headers = {}) {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: body ? { "Content-Type": "application/json", ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      throw new AgentClientError(json.message ?? `HTTP ${res.status}`, { status: res.status, code: json.error, reasons: json.reasons });
    }
    return json;
  }

  health() { return this.#req("GET", "/api/v1/health"); }
  status() { return this.#req("GET", "/api/v1/agent"); }
  audit() { return this.#req("GET", "/api/v1/agent/audit"); }
  quote(productId, payoutYocto) { return this.#req("POST", "/api/v1/agent/quote", { productId, payoutYocto }); }
  decide({ productId, payoutYocto, obsDateSec }) { return this.#req("POST", "/api/v1/agent/decide", { productId, payoutYocto, obsDateSec }); }
  buy({ productId, payoutYocto, obsDateSec, beneficiary, idempotencyKey }) {
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
    return this.#req("POST", "/api/v1/agent/buy", { productId, payoutYocto, obsDateSec, beneficiary, idempotencyKey }, headers);
  }
  setEnabled(enabled) { return this.#req("POST", "/api/v1/agent/control", { enabled }); }
}
