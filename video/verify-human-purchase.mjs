// Independently resolve the recorded human purchase and write the evidence the
// video cites. Nothing here is trusted from the repository: the transaction and
// the resulting policy are re-read from NEAR testnet RPC on every run.
//
//   node video/verify-human-purchase.mjs
//
// Output: video/evidence/human-purchase.json
//
// If the RPC cannot be reached the script fails loudly rather than emitting a
// stale or fabricated record. The video build reads this file, so a failing
// verification means the video will not silently show unverified numbers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "video", "evidence");

// The purchase to verify. Overridable so the same script can check any record.
const TX_HASH = process.env.HUMAN_TX || "87n1pdeAD4jv89hNDdWxQooQcWKdMpQfUiK5kRf8g14i";
const SENDER = process.env.HUMAN_SENDER || "human-demo-mwb9swu7.oc-agent-mwb87z4k.testnet";
const CONTRACT = process.env.HUMAN_CONTRACT || "contract.attestor-overcover.testnet";
const POLICY_ID = Number(process.env.HUMAN_POLICY || 15);
const RPCS = ["https://archival-rpc.testnet.near.org", "https://rpc.testnet.near.org"];

async function rpc(endpoint, method, params) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.cause?.name || json.error.message}`);
  return json.result;
}

async function view(method, args) {
  let lastErr;
  for (const endpoint of RPCS) {
    try {
      const r = await rpc(endpoint, "query", {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      return JSON.parse(Buffer.from(r.result).toString("utf8"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function resolveTx() {
  let lastErr;
  for (const endpoint of RPCS) {
    try {
      const r = await rpc(endpoint, "tx", {
        tx_hash: TX_HASH,
        sender_account_id: SENDER,
        wait_until: "EXECUTED_OPTIMISTIC",
      });
      const call = r.transaction.actions.find((a) => a.FunctionCall)?.FunctionCall;
      const statusKey = Object.keys(r.status)[0];
      return {
        hash: r.transaction.hash,
        signer: r.transaction.signer_id,
        receiver: r.transaction.receiver_id,
        method: call?.method_name,
        deposit: call?.deposit,
        gas: call?.gas,
        args: JSON.parse(Buffer.from(call?.args || "", "base64").toString("utf8")),
        status: statusKey,
        successValue: r.status.SuccessValue ? Buffer.from(r.status.SuccessValue, "base64").toString("utf8") : null,
        blockHash: r.transaction_outcome.block_hash,
        endpoint,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function main() {
  const tx = await resolveTx();
  const policy = await view("get_policy", { id: POLICY_ID });
  if (!policy) throw new Error(`policy ${POLICY_ID} not found on ${CONTRACT}`);
  if (policy.buyer !== tx.signer) {
    throw new Error(`policy ${POLICY_ID} buyer ${policy.buyer} != tx signer ${tx.signer}`);
  }
  const evidence = {
    verifiedAt: new Date().toISOString(),
    network: "testnet",
    contract: CONTRACT,
    tx,
    policy,
    checks: {
      txStatusSuccess: tx.status === "SuccessValue",
      policyIdMatchesSuccessValue: tx.successValue === String(POLICY_ID),
      buyerIsSigner: policy.buyer === tx.signer,
      depositCoversPremium: BigInt(tx.deposit) >= BigInt(policy.premium),
      receiverIsContract: tx.receiver === CONTRACT,
      methodIsBuyCover: tx.method === "buy_cover",
    },
  };
  const allPass = Object.values(evidence.checks).every(Boolean);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "human-purchase.json"), JSON.stringify(evidence, null, 2));
  console.log(`tx ${tx.hash}`);
  console.log(`  signer  ${tx.signer}`);
  console.log(`  contract ${tx.receiver} (${tx.method}, deposit ${tx.deposit})`);
  console.log(`  status  ${tx.status} → policy ${tx.successValue}`);
  console.log(`policy ${policy.id}: ${policy.product_id} · payout ${policy.payout} · premium ${policy.premium} · ${policy.status}`);
  console.log(`checks: ${Object.entries(evidence.checks).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (!allPass) {
    console.error("VERIFICATION FAILED");
    process.exit(1);
  }
  console.log(`\nwrote video/evidence/human-purchase.json`);
}

main().catch((e) => {
  console.error("human-purchase verification failed:", e.message);
  process.exit(1);
});
