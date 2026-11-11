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

export { KeyPair };
