// Attestor signing helper: build the exact message the contract verifies and
// sign it with the attestor's ed25519 key.
//
// Message format (must match contract/src/lib.rs::obs_message):
//   overcover:v1|<city>|<obs_date>|<value_tenths>|<reported_at>|<nonce>|<contract_id>
import { KeyPair, utils } from "near-api-js";

export function obsMessage({ city, obsDate, valueTenths, reportedAt, nonce, contractId }) {
  return `overcover:v1|${city}|${obsDate}|${valueTenths}|${reportedAt}|${nonce}|${contractId}`;
}

/** Sign an observation with an ed25519 KeyPair. Returns a number[] (the
 *  contract expects a Vec<u8> of 64 bytes in JSON). */
export function signObservation(keyPair, fields) {
  const msg = obsMessage(fields);
  const sig = keyPair.sign(Buffer.from(msg, "utf8"));
  return { message: msg, signature: Array.from(sig.signature) };
}

export { KeyPair };
