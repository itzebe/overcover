// The autonomous insurance agent.
//
// It is a normal NEAR account with its own key, driven by software. It can do
// exactly two things on-chain: read the contract, and call `buy_cover` with a
// deposit equal to the contract's own quote. It cannot call any owner-only
// method — it has no owner key and the contract would reject it if it tried.
//
// Safety model:
//   * The key is read from the environment (OVERCOVER_AGENT_SECRET_KEY) and is
//     never written to disk, logged, or returned by any method here.
//   * Every purchase passes through agent/limits.mjs first. A refusal never
//     touches the network, so no funds move on a denied proposal.
//   * `enabled` is a runtime kill switch: once false, every buy is refused.
//   * Every attempt is appended to an audit log (no key material in it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, KeyPair, keyStores, utils, transactions, providers } from "near-api-js";
import { normalizeLimits, evaluate } from "./limits.mjs";
import { parseBigIntJson } from "./json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_AUDIT = path.join(root, "agent", "audit.log.jsonl");

const RPC_ENDPOINTS = [
  process.env.OVERCOVER_RPC,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
].filter(Boolean);

export class AgentError extends Error {
  constructor(message, { code = "agent_error", reasons = [] } = {}) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.reasons = reasons;
  }
}

function connectAgent(accountId, secretKey) {
  const ks = new keyStores.InMemoryKeyStore();
  ks.setKey("testnet", accountId, KeyPair.fromString(secretKey));
  return connect({ networkId: "testnet", nodeUrl: RPC_ENDPOINTS[0], keyStore: ks, headers: {} }).then((near) => {
    near.connection.provider = new providers.FailoverRpcProvider(
      RPC_ENDPOINTS.map((url) => new providers.JsonRpcProvider({ url }))
    );
    return near;
  });
}

function decodeResult(r) {
  return parseBigIntJson(Buffer.from(r.result).toString("utf8"));
}

function failureMessage(failure) {
  try {
    const kind = failure.ActionError?.kind ?? failure.ActionError;
    const fc = kind?.FunctionCallError;
    const s = fc?.ExecutionError ?? fc?.CompilationError ?? JSON.stringify(failure);
    return String(s).replace(/^Smart contract panicked:\s*/, "");
  } catch {
    return JSON.stringify(failure);
  }
}

/**
 * Create an agent instance.
 * @param {object} opts
 * @param {string} opts.accountId           the agent's NEAR account
 * @param {string} opts.secretKey           ed25519 secret key (never logged)
 * @param {string} [opts.contractId]        defaults to the live testnet contract
 * @param {object} [opts.limits]            spending limits (see limits.mjs)
 * @param {string} [opts.auditPath]         where to append the audit log
 * @param {boolean}[opts.dryRun]            evaluate but do not send
 * @param {function}[opts.clock]            () => ms, injectable for tests
 */
export async function createAgent(opts) {
  if (!opts?.accountId) throw new AgentError("accountId is required", { code: "config" });
  if (!opts?.secretKey) throw new AgentError("secretKey is required", { code: "config" });
  const contractId = opts.contractId ?? "contract.attestor-overcover.testnet";
  const limits = normalizeLimits(opts.limits ?? {});
  const auditPath = opts.auditPath ?? DEFAULT_AUDIT;
  const dryRun = opts.dryRun === true;
  const clock = opts.clock ?? (() => Date.now());

  const near = await connectAgent(opts.accountId, opts.secretKey);

  // Spend history is held in memory for this process and mirrored to the audit
  // log. It is per-process by design; a deployment that runs several copies must
  // centralise this (the API layer documents that it does not).
  const history = [];

  function appendAudit(entry) {
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n");
    } catch (e) {
      // Auditing must not silently drop: surface it on stderr.
      process.stderr.write(`agent audit write failed: ${e.message}\n`);
    }
  }

  async function view(method, args = {}) {
    const r = await near.connection.provider.query({
      request_type: "call_function",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: "final",
    });
    return decodeResult(r);
  }

  async function balanceYocto() {
    try {
      const a = await near.account(opts.accountId);
      return (await a.getAccountBalance()).total;
    } catch {
      // An account that has not been funded yet has no balance record; that is
      // not an error, it is "no balance".
      return null;
    }
  }

  async function quote(productId, payoutYocto) {
    const q = await view("quote", { product_id: productId, payout: String(payoutYocto) });
    return BigInt(Array.isArray(q) ? q[0] : q).toString();
  }

  async function product(productId) {
    const p = await view("get_product", { id: productId });
    return p;
  }

  /** Evaluate a proposal against the limits WITHOUT touching the network beyond
   *  reading the product. Used by the API for a "dry" decision and by tests. */
  async function decide({ productId, payoutYocto, obsDateSec, idempotencyKey }) {
    const p = await product(productId);
    if (!p) return { allow: false, reasons: [`no such product: ${productId}`] };
    const premiumYocto = await quote(productId, payoutYocto);
    const proposal = { productId, city: p.city, payoutYocto: String(payoutYocto), premiumYocto, obsDateSec, nowSec: Math.floor(clock() / 1000), idempotencyKey };
    const verdict = evaluate(proposal, p, { limits, history, nowMs: clock() });
    return { ...verdict, premiumYocto, product: p };
  }

  /**
   * Buy cover. Returns { hash, premiumYocto, explorer } on success, or throws an
   * AgentError with code "denied" (limits) or "chain" (contract refused).
   */
  async function buy({ productId, payoutYocto, obsDateSec, beneficiary, idempotencyKey }) {
    const started = clock();
    const decision = await decide({ productId, payoutYocto, obsDateSec, idempotencyKey });
    if (!decision.allow) {
      appendAudit({ at: new Date(started).toISOString(), kind: "denied", productId, payoutYocto: String(payoutYocto), reasons: decision.reasons });
      throw new AgentError("purchase denied by policy", { code: "denied", reasons: decision.reasons });
    }
    if (dryRun) {
      appendAudit({ at: new Date(started).toISOString(), kind: "dry_run", productId, payoutYocto: String(payoutYocto), premiumYocto: decision.premiumYocto });
      return { dryRun: true, premiumYocto: decision.premiumYocto, explorer: null, hash: null };
    }

    const account = await near.account(opts.accountId);
    const args = { product_id: productId, payout: String(payoutYocto), obs_date: obsDateSec, beneficiary: beneficiary ?? null };
    const action = transactions.functionCall(
      "buy_cover",
      Buffer.from(JSON.stringify(args)),
      BigInt("300000000000000"),
      BigInt(decision.premiumYocto)
    );
    const [hashBytes, signedTx] = await account.signTransaction(contractId, [action]);
    const hash = utils.serialize.base_encode(hashBytes);
    let outcome;
    try {
      outcome = await near.connection.provider.sendTransactionUntil(signedTx, "EXECUTED_OPTIMISTIC");
    } catch (e) {
      appendAudit({ at: new Date(started).toISOString(), kind: "error", productId, payoutYocto: String(payoutYocto), error: String(e.message || e) });
      throw new AgentError(`chain call failed: ${e.message || e}`, { code: "chain" });
    }
    const failure = outcome?.status?.Failure;
    if (failure) {
      const msg = failureMessage(failure);
      appendAudit({ at: new Date(started).toISOString(), kind: "refused", productId, payoutYocto: String(payoutYocto), error: msg, hash });
      throw new AgentError(`contract refused: ${msg}`, { code: "chain" });
    }

    history.push({ kind: "buy", atMs: started, premiumYocto: decision.premiumYocto, productId, idempotencyKey: idempotencyKey ?? null });
    appendAudit({ at: new Date(started).toISOString(), kind: "buy", productId, payoutYocto: String(payoutYocto), premiumYocto: decision.premiumYocto, hash, idempotencyKey: idempotencyKey ?? null });
    return { hash, premiumYocto: decision.premiumYocto, explorer: `https://testnet.nearblocks.io/txns/${hash}` };
  }

  function status() {
    return {
      accountId: opts.accountId,
      contractId,
      enabled: limits.enabled,
      dryRun,
      limits,
      history: history.map((h) => ({ ...h })),
    };
  }

  function setEnabled(v) {
    limits.enabled = v === true;
    appendAudit({ at: new Date(clock()).toISOString(), kind: "control", enabled: limits.enabled });
    return limits.enabled;
  }

  return { accountId: opts.accountId, contractId, status, decide, quote, product, buy, balanceYocto, setEnabled, view, _history: history };
}
