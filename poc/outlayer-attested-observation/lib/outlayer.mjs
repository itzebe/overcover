// OutLayer HTTPS API client — the documented, unauthenticated-onboarding path.
//
// Endpoints and shapes are taken from the official OpenAPI document
// (https://api.outlayer.ai/openapi.json) and the docs at
// https://app.outlayer.ai/docs/{getting-started,https-api,tee-attestation}.
// Nothing here is invented: each route is one the service publishes.
//
// Access model (verified 2026-11-13):
//   * POST /register          → creates an anonymous wallet, returns an api_key
//   * POST /trial-key         → claims 50 free connector calls (7 days)
//   * POST /call/{owner}/{proj} → runs a project/connector; needs X-Payment-Key
//   * GET  /attestations/by-call/{call_id} → the execution's TDX attestation
//
// A key created here is a real credential: keep it in the environment or a
// file, never in the repository.

export const OUTLAYER = {
  testnet: "https://testnet-api.outlayer.ai",
  mainnet: "https://api.outlayer.ai",
};

async function jfetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, ok: r.ok, body };
}

/** Create an anonymous wallet. Returns { wallet_id, api_key, near_account_id, trial }. */
export async function registerWallet(base = OUTLAYER.testnet) {
  return jfetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

/** Claim the wallet's free trial. Returns { payment_key, owner, nonce, calls, expires_at }. */
export async function claimTrial(base, apiKey) {
  return jfetch(`${base}/trial-key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

/**
 * Run a project or connector. `operation` is mandatory and is the unit of
 * price. Returns the sync response incl. `call_id` and `attestation_url`.
 */
export async function callConnector(base, { paymentKey, owner, project, input, walletId }) {
  const headers = {
    "X-Payment-Key": paymentKey,
    "Content-Type": "application/json",
  };
  if (walletId) headers["X-Wallet-Id"] = walletId;
  return jfetch(`${base}/call/${owner}/${project}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ input }),
  });
}

/** Fetch an execution's TEE attestation record. 404 until the worker uploads the quote. */
export async function fetchAttestation(base, callId) {
  return jfetch(`${base}/attestations/by-call/${callId}`);
}

/**
 * Map an attestation record onto the canonical OutLayer task-hash fields, in
 * the exact order and with the exact types the worker uses. Only fields the
 * record carries are present; absent optional fields are omitted (the hasher
 * skips them). `attached_usd` is a decimal STRING on the wire.
 */
export function attestationTaskFields(att) {
  const f = {};
  const put = (k, v) => {
    if (v !== undefined && v !== null) f[k] = v;
  };
  put("task_type", att.task_type);
  put("task_id", att.task_id);
  put("build_target", att.build_target);
  put("wasm_hash", att.wasm_hash ?? att.executed_wasm_sha256);
  put("input_hash", att.input_hash);
  put("output_hash", att.output_hash);
  put("project_id", att.project_id);
  put("caller_account_id", att.caller_account_id);
  put("timestamp", att.timestamp);
  put("attached_usd", att.attached_usd);
  return f;
}
