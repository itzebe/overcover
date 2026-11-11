// Overcover — an independent oracle OPERATOR node.
//
//   node driver/operator.js <operatorKeyName> <metricId> <city> <YYYY-MM-DD>
//
// One operator: read a public index for a metric/city/date, sign the canonical
// reading message with its OWN ed25519 key, and submit it to the contract. The
// contract accepts the reading only if the caller is a registered operator, the
// signature verifies against that operator's registered key, and the nonce is
// the operator's current counter (so a reading can never be replayed).
//
// No single operator can finalize an observation: the contract only finalizes
// once `quorum` distinct operators agree within tolerance. Run this command from
// several operators to reach quorum.
//
// The private key never leaves keys/identities.json (gitignored). The operator
// account is a normal testnet account whose public key is registered on-chain.
import { connectNear, call, view, loadIdentities, txHash } from "./near.js";
import { KeyPair } from "near-api-js";
import { observe } from "./adapters.js";
import { readingMessageV3 } from "./attestor.js";

const CONTRACT = process.env.OVERCOVER_CONTRACT || "contract.attestor-overcover.testnet";
/// How long the operator asserts its reading stays valid (default 6 h). Must be
/// inside the contract's 7-day cap and past the challenge window at settle time.
const READING_VALIDITY_SEC = Number(process.env.OVERCOVER_READING_VALIDITY ?? 6 * 3600);

function parseDateSec(s) {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${s} (want YYYY-MM-DD)`);
  return Math.floor(ms / 1000);
}

async function main() {
  const [keyName, metricId, city, dateStr] = process.argv.slice(2);
  if (!keyName || !metricId || !city || !dateStr) {
    throw new Error("usage: node driver/operator.js <operatorKey> <metricId> <city> <YYYY-MM-DD>");
  }
  const obsDate = parseDateSec(dateStr);
  const ids = loadIdentities();
  const me = ids[keyName];
  if (!me?.accountId || !me?.secretKey) throw new Error(`no operator identity '${keyName}' in keys/identities.json`);

  const near = await connectNear();
  const operator = me.accountId;

  // Confirm the operator is registered and read its monotonic nonce.
  const onchain = await view(near, CONTRACT, "get_operator", { account: operator });
  if (!onchain) throw new Error(`${operator} is not a registered operator on ${CONTRACT}`);
  if (!onchain.active) throw new Error(`${operator} is revoked`);
  const nonce = onchain.readings;

  // Independent observation of a public index.
  const obs = await observe(metricId, city, obsDate);
  const reportedAt = Math.floor(Date.now() / 1000);
  const expiry = reportedAt + READING_VALIDITY_SEC;
  // Evidence reference: a hash of the source bundle the adapter observed. The
  // contract stores it and binds it into the signed message.
  const evidenceHash = obs.evidenceHash || [];

  // Canonical v3 message — MUST match Overcover::reading_message byte-for-byte.
  const msg = readingMessageV3({
    operator, metricId, city, obsDate, valueTenths: obs.valueTenths,
    reportedAt, expiry, evidenceHash, nonce, contractId: CONTRACT,
  });
  const kp = KeyPair.fromString(me.secretKey);
  const { signature } = kp.sign(msg);
  const sig = Array.from(signature);

  process.stdout.write(
    `operator ${operator}\n  metric=${metricId} city=${city} date=${dateStr}\n` +
      `  value=${obs.valueTenths} (${obs.unit}) via ${obs.source}\n  nonce=${nonce}\n` +
      `  expiry=${expiry} evidence=${evidenceHash.length} bytes\n`
  );

  const outcome = await call(near, operator, CONTRACT, "submit_reading", {
    metric_id: metricId,
    city,
    obs_date: obsDate,
    value_tenths: obs.valueTenths,
    reported_at: reportedAt,
    expiry,
    evidence_hash: evidenceHash,
    nonce,
    signature: sig,
  });
  const hash = txHash(outcome);
  process.stdout.write(`  submitted: ${hash}\n`);

  const finalized = await view(near, CONTRACT, "get_observation", { metric_id: metricId, city, obs_date: obsDate });
  if (finalized) {
    process.stdout.write(`  FINALIZED value=${finalized.value_tenths} quorum=${finalized.quorum}\n`);
  } else {
    process.stdout.write(`  waiting for quorum (more operators must report)\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`operator error: ${e.message}\n`);
  process.exit(1);
});
