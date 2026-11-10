// Regression tests for the u128 money-precision bug.
//
// The contract returns u128 money as bare JSON numbers. JSON.parse rounds any
// integer above 2^53, so a product's max_payout of 1 NEAR came back as
// 999999999999999983222784 and the agent's exact bounds check rejected a payout
// equal to the true maximum — the agent could not buy at the top of the range.
// parseBigIntJson keeps an oversized literal as a string so BigInt() is exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBigIntJson } from "../agent/json.mjs";

test("an integer above 2^53 is preserved exactly as a string", () => {
  const v = parseBigIntJson("1000000000000000000000000");
  assert.equal(typeof v, "string");
  assert.equal(v, "1000000000000000000000000");
  assert.equal(BigInt(v).toString(), "1000000000000000000000000");
});

test("an integer at or below 2^53 stays a number", () => {
  assert.equal(parseBigIntJson("9007199254740991"), 9007199254740991);
  assert.equal(parseBigIntJson("2"), 2);
  assert.equal(parseBigIntJson("0"), 0);
});

test("the regression: a product's exact bounds survive parsing", () => {
  // Exactly the shape get_product returns on-chain.
  const raw = '{"id":"rain-lagos","min_payout":100000000000000000000000,"max_payout":1000000000000000000000000,"premium_bp":500,"active":true}';
  const p = parseBigIntJson(raw);
  assert.equal(BigInt(p.min_payout), 100000000000000000000000n);
  assert.equal(BigInt(p.max_payout), 1000000000000000000000000n);
  // A payout equal to the true max must be inside the bounds.
  const payout = 1000000000000000000000000n;
  assert.ok(payout >= BigInt(p.min_payout) && payout <= BigInt(p.max_payout));
});

test("JSON.parse would have rounded it — the bug this guards against", () => {
  const raw = '{"max_payout":1000000000000000000000000}';
  const lossy = JSON.parse(raw).max_payout;
  assert.notEqual(BigInt(lossy), 1000000000000000000000000n);
  assert.equal(BigInt(parseBigIntJson(raw).max_payout), 1000000000000000000000000n);
});

test("floats, exponents and negatives are parsed as numbers", () => {
  assert.equal(parseBigIntJson("-5"), -5);
  assert.equal(parseBigIntJson("1.5"), 1.5);
  assert.equal(parseBigIntJson("1e3"), 1000);
});

test("nested objects, arrays, strings with escapes, booleans and null", () => {
  const raw = '{"a":[1,{"b":"x\\"y","c":1000000000000000000000000},true,null]}';
  const v = parseBigIntJson(raw);
  assert.equal(v.a[0], 1);
  assert.equal(v.a[1].b, 'x"y');
  assert.equal(v.a[1].c, "1000000000000000000000000");
  assert.equal(v.a[2], true);
  assert.equal(v.a[3], null);
});

test("malformed input throws rather than returning a partial value", () => {
  assert.throws(() => parseBigIntJson('{"a":1'));
  assert.throws(() => parseBigIntJson("[1,]"));
  assert.throws(() => parseBigIntJson("nope"));
});
