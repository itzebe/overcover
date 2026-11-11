// Oracle signing helpers.
//
// The contract has two generations of reading message, and both live here so a
// single checkout can talk to whichever contract is deployed:
//
//   v1 (single attestor):  overcover:v1|<city>|<obs_date>|<value_tenths>|<reported_at>|<nonce>|<contract_id>
//   v2 (operator quorum):  overcover:v2|<operator>|<metric_id>|<city>|<obs_date>|<value_tenths>|<reported_at>|<nonce>|<contract_id>
//
// In v2 the operator account is part of the message, so a reading signed by one
// operator can never be attributed to another; the metric id and contract id are
// part of it, so a reading cannot be replayed on another product or contract; the
// nonce makes each reading single-use.
import { KeyPair } from "near-api-js";

export function obsMessage({ city, obsDate, valueTenths, reportedAt, nonce, contractId }) {
  return `overcover:v1|${city}|${obsDate}|${valueTenths}|${reportedAt}|${nonce}|${contractId}`;
}

/** Sign a v1 observation with an ed25519 KeyPair. Returns a number[] of 64 bytes. */
export function signObservation(keyPair, fields) {
  const msg = obsMessage(fields);
  const sig = keyPair.sign(Buffer.from(msg, "utf8"));
  return { message: msg, signature: Array.from(sig.signature) };
}

export function readingMessage({ operator, metricId, city, obsDate, valueTenths, reportedAt, nonce, contractId }) {
  return `overcover:v2|${operator}|${metricId}|${city}|${obsDate}|${valueTenths}|${reportedAt}|${nonce}|${contractId}`;
}

/** Sign a v2 reading with an ed25519 KeyPair. Returns the message and a number[]
 *  (the contract expects a Vec<u8> of 64 bytes in JSON). */
export function signReading(keyPair, fields) {
  const msg = readingMessage(fields);
  const sig = keyPair.sign(Buffer.from(msg, "utf8"));
  return { message: msg, signature: Array.from(sig.signature) };
}

// --- v3 (domain-separated threshold oracle) --------------------------------
//
//   overcover:v3:observation|<contract_id>|<operator>|<metric>|<city>|<date>|
//     <value>|<reported_at>|<expiry>|<nonce>|<u32be len><evidence bytes>
//
// The domain tag and the contract id lead the message, so a signature can never
// be replayed as another kind of message or against another contract. The
// evidence reference is length-prefixed so it cannot be confused with a trailing
// field (the classic concatenation ambiguity). This MUST match
// `Overcover::reading_message` in contract/src/lib.rs byte-for-byte.
const READING_DOMAIN_V3 = "overcover:v3:observation";

export function readingMessageV3({ operator, metricId, city, obsDate, valueTenths, reportedAt, expiry, evidenceHash, nonce, contractId }) {
  const evidence = Buffer.isBuffer(evidenceHash) ? evidenceHash : Buffer.from(evidenceHash || []);
  const head = [
    READING_DOMAIN_V3,
    contractId,
    operator,
    metricId,
    city,
    obsDate,
    valueTenths,
    reportedAt,
    expiry,
    nonce,
  ].join("|");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(evidence.length, 0);
  return Buffer.concat([Buffer.from(head, "utf8"), Buffer.from("|", "utf8"), len, evidence]);
}

/** Sign a v3 reading. Returns the raw message Buffer and the 64-byte signature. */
export function signReadingV3(keyPair, fields) {
  const msg = readingMessageV3(fields);
  const sig = keyPair.sign(msg);
  return { message: msg, signature: Array.from(sig.signature) };
}

export { KeyPair };
