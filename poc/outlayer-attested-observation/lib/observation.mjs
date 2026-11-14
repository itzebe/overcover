// Overcover observation model for the OutLayer attested-observation POC.
//
// Reuses the production message format (`readingMessageV3` from
// driver/attestor.js) so an operator signs exactly what the live contract
// verifies. This module adds the adapter-output normalisation and a pre-flight
// that mirrors the contract's `report_reading` rules, so an attestation that is
// cryptographically valid but whose reading is out of bounds is rejected before
// an operator ever signs it.

import { readingMessageV3, signReadingV3, KeyPair } from "../../../driver/attestor.js";

// Mirrors contract/src/lib.rs constants.
export const CONTRACT_BOUNDS = {
  REPORT_MAX_DELAY_SEC: 24 * 3600,
  READING_MAX_VALIDITY_SEC: 7 * 24 * 3600,
  MAX_LEAD_SEC: 365 * 24 * 3600,
  MAX_EVIDENCE_BYTES: 128,
};

export const ADAPTER_SCHEMA = "overcover.observation.adapter.v1";

/**
 * Extract Overcover's observation fields from the adapter's attested output.
 * The adapter is untrusted until its attestation is verified; this only shapes
 * the bytes for the checks that follow.
 */
export function normalizeToObservation(adapterOutput) {
  if (!adapterOutput || adapterOutput.schema !== ADAPTER_SCHEMA) {
    throw new Error(`unexpected adapter schema: ${adapterOutput?.schema}`);
  }
  const n = adapterOutput.normalized;
  if (!n) throw new Error("adapter output has no normalized reading");
  return {
    metric_id: n.metric_id,
    city: n.city,
    obs_date: n.obs_date,
    value_tenths: n.value_tenths,
    reported_at: n.reported_at,
    expiry: n.expiry,
    // evidence_hash binds the signed reading to the exact source payload bytes.
    evidence_hash: n.evidence_hash,
    provenance: adapterOutput.provenance,
    source: adapterOutput.source,
    raw: adapterOutput.raw,
  };
}

/**
 * Mirror the contract's `report_reading` guards so out-of-bounds readings are
 * refused before signing. Returns { ok, reasons }.
 * `valueMax` comes from the product's metric spec (contract `metric_spec`).
 */
export function preflight(obs, { nowSec, valueMax = null } = {}) {
  const reasons = [];
  if (typeof nowSec !== "number") throw new Error("nowSec is required");

  const obsDate = toSec(obs.obs_date);
  if (obsDate === null) reasons.push("obs_date is not a valid date");
  else if (obsDate > nowSec) reasons.push("cannot observe a future date");
  else if (obsDate - nowSec > CONTRACT_BOUNDS.MAX_LEAD_SEC) reasons.push("obs_date beyond max lead");

  if (obsDate !== null && obs.reported_at < obsDate) reasons.push("observation predates its date");
  if (obsDate !== null && obs.reported_at - obsDate > CONTRACT_BOUNDS.REPORT_MAX_DELAY_SEC) {
    reasons.push("observation reported too late (stale)");
  }
  if (obs.reported_at > nowSec) reasons.push("observation reported in the future");
  if (!(obs.expiry > nowSec)) reasons.push("observation already expired");
  if (obs.expiry > obs.reported_at + CONTRACT_BOUNDS.READING_MAX_VALIDITY_SEC) {
    reasons.push("expiry too far in the future");
  }
  if (typeof obs.value_tenths !== "number" || !Number.isInteger(obs.value_tenths)) {
    reasons.push("value_tenths is not an integer");
  }
  if (valueMax !== null && obs.value_tenths > valueMax) {
    reasons.push("value above metric plausibility bound");
  }
  const evLen = typeof obs.evidence_hash === "string" ? obs.evidence_hash.length / 2 : Infinity;
  if (evLen > CONTRACT_BOUNDS.MAX_EVIDENCE_BYTES) reasons.push("evidence reference too large");

  return { ok: reasons.length === 0, reasons };
}

/** Build the exact v3 reading message the live contract verifies. */
export function buildReadingMessage(obs, { operator, nonce, contractId }) {
  return readingMessageV3({
    operator,
    metricId: obs.metric_id,
    city: obs.city,
    obsDate: obs.obs_date,
    valueTenths: obs.value_tenths,
    reportedAt: obs.reported_at,
    expiry: obs.expiry,
    evidenceHash: Buffer.from(obs.evidence_hash, "hex"),
    nonce,
    contractId,
  });
}

/** An operator independently signs the normalized reading (v3 message). */
export function operatorSign(obs, { keyPair, operator, nonce, contractId }) {
  const { message, signature } = signReadingV3(keyPair, {
    operator,
    metricId: obs.metric_id,
    city: obs.city,
    obsDate: obs.obs_date,
    valueTenths: obs.value_tenths,
    reportedAt: obs.reported_at,
    expiry: obs.expiry,
    evidenceHash: Buffer.from(obs.evidence_hash, "hex"),
    nonce,
    contractId,
  });
  return { message, signature };
}

export { KeyPair };

function toSec(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
