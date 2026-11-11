// Regression: the canonical v3 oracle reading message must be byte-identical
// across every implementation that signs or verifies it.
//
//   driver/attestor.js  readingMessageV3(...)      (what the driver signs)
//   sim/engine.mjs      readingMessage(...)         (the reference model)
//   contract/src/lib.rs Overcover::reading_message  (what the chain verifies)
//
// A dropped field here is invisible to the sim (which signs and verifies with
// its own copy) but makes EVERY operator reading fail on-chain with
// "invalid operator signature". That is exactly the bug this pins: the JS and
// sim builders once omitted `city`, so no reading could ever be accepted.
//
// The expected hex below is the contract's own layout:
//   overcover:v3:observation | <contract_id> | <operator> | <metric> | <city> |
//     <obs_date> | <value> | <reported_at> | <expiry> | <nonce> |
//     <u32be len><evidence bytes>

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readingMessageV3 } from "../driver/attestor.js";
import { Decentralized } from "../sim/engine.mjs";

const FIELDS = {
  operator: "op1.testnet",
  metricId: "heat",
  city: "lagos",
  obsDate: 123,
  valueTenths: 450,
  reportedAt: 130,
  expiry: 140,
  evidenceHash: Array.from(Buffer.from("sandbox-evidence")),
  nonce: 0,
  contractId: "overcover.testnet",
};

const EXPECTED_UTF8 =
  "overcover:v3:observation|overcover.testnet|op1.testnet|heat|lagos|123|450|130|140|0|" +
  "\u0000\u0000\u0000\u0010sandbox-evidence";
const EXPECTED_HEX =
  "6f766572636f7665723a76333a6f62736572766174696f6e7c6f766572636f7665722e746573746e6574" +
  "7c6f70312e746573746e65747c686561747c6c61676f737c3132337c3435307c3133307c3134307c30" +
  "7c0000001073616e64626f782d65766964656e6365";

test("v3 message: driver builder matches the pinned contract layout", () => {
  const msg = readingMessageV3(FIELDS);
  assert.equal(msg.toString("utf8"), EXPECTED_UTF8);
  assert.equal(Buffer.from(msg).toString("hex"), EXPECTED_HEX);
});

test("v3 message: every signed field changes the bytes (no field is dropped)", () => {
  const base = Buffer.from(readingMessageV3(FIELDS)).toString("hex");
  const mutations = {
    operator: "op2.testnet",
    metricId: "rain",
    city: "nairobi",
    obsDate: 124,
    valueTenths: 451,
    reportedAt: 131,
    expiry: 141,
    nonce: 1,
    contractId: "other.testnet",
  };
  for (const [key, value] of Object.entries(mutations)) {
    const mutated = Buffer.from(readingMessageV3({ ...FIELDS, [key]: value })).toString("hex");
    assert.notEqual(mutated, base, `changing ${key} must change the signed message`);
  }
});

test("v3 message: evidence length is bound (no concatenation ambiguity)", () => {
  // Appending a byte to the evidence must change the length prefix AND the tail,
  // so "AB" + "C" can never be confused with "A" + "BC".
  const a = Buffer.from(
    readingMessageV3({ ...FIELDS, evidenceHash: Array.from(Buffer.from("AB")) }),
  ).toString("hex");
  const b = Buffer.from(
    readingMessageV3({ ...FIELDS, evidenceHash: Array.from(Buffer.from("A")) }),
  ).toString("hex");
  assert.notEqual(a, b);
  const aTail = a.slice(-12); // "00000002" + "4142"
  assert.equal(aTail, "000000024142");
});

test("v3 message: the sim engine's builder is byte-identical to the driver", () => {
  const engine = new Decentralized({ owner: "owner.testnet", contractId: FIELDS.contractId });
  const simMsg = engine.readingMessage(
    FIELDS.operator,
    FIELDS.metricId,
    FIELDS.city,
    FIELDS.obsDate,
    FIELDS.valueTenths,
    FIELDS.reportedAt,
    FIELDS.expiry,
    Buffer.from(FIELDS.evidenceHash),
    FIELDS.nonce,
  );
  assert.equal(Buffer.from(simMsg).toString("hex"), EXPECTED_HEX);
  assert.equal(
    createHash("sha256").update(simMsg).digest("hex"),
    createHash("sha256").update(readingMessageV3(FIELDS)).digest("hex"),
  );
});
