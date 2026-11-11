// Regression tests for the machine-readable product feed (Phase 4A).
//
//   node --test tests/products-feed.test.mjs
//
// These run offline against the SHIPPED artifact `ui/products.json` and the
// generator's pure functions. They assert the feed is (a) schema-valid, (b)
// consistent with the classification and premium rules the contract enforces,
// and (c) free of the u128 rounding trap that would publish a wrong payout.
// No network, no mocks: the artifact under test is the one that is served.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, shapeProduct, CONTRACT } from "../scripts/products-feed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const feed = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "ui", "products.schema.json"), "utf8"));

// --- a small JSON Schema validator (draft 2020-12 subset used by our schema) ---
function validate(node, data, defs, pathStr = "$", errs = []) {
  if (node.$ref) {
    const key = node.$ref.replace("#/$defs/", "");
    return validate(defs[key], data, defs, pathStr, errs);
  }
  const t = node.type;
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
  if (t) {
    const allowed = Array.isArray(t) ? t : [t];
    const got = typeOf(data);
    // JSON Schema distinguishes "integer" from "number"; typeof does not.
    const ok = allowed.some((a) => (a === "integer" ? got === "number" && Number.isInteger(data) : a === got));
    if (!ok) {
      errs.push(`${pathStr}: expected ${allowed.join("|")}, got ${got}`);
      return errs;
    }
  }
  if (node.const !== undefined) {
    if (JSON.stringify(data) !== JSON.stringify(node.const)) errs.push(`${pathStr}: expected const ${JSON.stringify(node.const)}`);
  }
  if (node.enum && !node.enum.includes(data)) errs.push(`${pathStr}: ${JSON.stringify(data)} not in enum`);
  if (node.pattern && typeof data === "string" && !new RegExp(node.pattern).test(data)) errs.push(`${pathStr}: ${data} fails pattern ${node.pattern}`);
  if (node.minimum !== undefined && typeof data === "number" && data < node.minimum) errs.push(`${pathStr}: ${data} < minimum`);
  if (typeOf(data) === "object") {
    for (const req of node.required || []) if (!(req in data)) errs.push(`${pathStr}: missing required ${req}`);
    for (const [k, v] of Object.entries(data)) if (node.properties?.[k]) validate(node.properties[k], v, defs, `${pathStr}.${k}`, errs);
  }
  if (typeOf(data) === "array" && node.items) data.forEach((v, i) => validate(node.items, v, defs, `${pathStr}[${i}]`, errs));
  return errs;
}

const ceilPremium = (payoutYocto, bp) => (((BigInt(payoutYocto) * BigInt(bp)) + 9999n) / 10000n).toString();

test("the shipped feed validates against the published schema", () => {
  const errs = validate(schema, feed, schema.$defs);
  assert.deepEqual(errs, [], errs.join("\n"));
});

test("the feed points at the live testnet contract and declares its source", () => {
  assert.equal(feed.source.network, "testnet");
  assert.equal(feed.source.contract, CONTRACT);
  assert.match(feed.source.contract, /\.testnet$/);
  assert.ok(feed.disclaimer.length > 40, "the feed must carry the testnet/unaudited disclaimer");
});

test("offerings == exactly the products that are sellable", () => {
  const sellable = feed.products.filter((p) => p.sellable).map((p) => p.id).sort();
  assert.deepEqual([...feed.offerings].sort(), sellable);
  for (const p of feed.products) {
    if (!p.sellable) assert.equal(p.status, "not-offered", `${p.id} must not be marked available`);
    else assert.equal(p.status, "available");
  }
});

test("every money field is an exact digit string, never a float", () => {
  const money = [
    ["payout", "min_yocto"], ["payout", "max_yocto"],
    ["capacity", "max_total_coverage_yocto"], ["capacity", "reserved_yocto"], ["capacity", "capacity_left_yocto"],
  ];
  for (const p of feed.products) {
    for (const [a, b] of money) {
      assert.equal(typeof p[a][b], "string", `${p.id}.${a}.${b} must be a string`);
      assert.match(p[a][b], /^[0-9]+$/, `${p.id}.${a}.${b} must be digits`);
    }
    assert.equal(typeof feed.protocol.capital_yocto, "string");
  }
});

test("the published premium equals the contract's ceil(payout * bp / 10000)", () => {
  for (const p of feed.products) {
    const ex = p.premium.example_at_max_payout;
    assert.equal(ex.premium_yocto, ceilPremium(p.payout.max_yocto, p.premium.basis_points), `${p.id} premium mismatch`);
  }
});

test("capacity_left is max_total_coverage minus reserved, never negative", () => {
  for (const p of feed.products) {
    const expected = (BigInt(p.capacity.max_total_coverage_yocto) - BigInt(p.capacity.reserved_yocto)).toString();
    assert.equal(p.capacity.capacity_left_yocto, expected);
    assert.ok(BigInt(p.capacity.capacity_left_yocto) >= 0n);
  }
});

test("every product's trigger statement states the contract's at-or-above rule", () => {
  for (const p of feed.products) {
    assert.equal(p.trigger.direction, "at-or-above");
    assert.match(p.trigger.statement, /at or above/);
    assert.equal(p.trigger.threshold_mm, (Number(p.trigger.threshold_tenths) / 10).toFixed(1));
  }
});

test("classification: a machine id is a demo fixture, a ceiling trigger is a broken definition, neither is sellable", () => {
  const fixture = { id: "p-1794315395272-3", city: "lagos", threshold_tenths: 1, premium_bp: 500, min_payout: "1", max_payout: "2", max_total_coverage: "3", reserved: "0", min_lead_sec: 0, active: true };
  const ceiling = { ...fixture, id: "rain-bergen-dry", threshold_tenths: 5000 };
  const real = { ...fixture, id: "rain-lagos", threshold_tenths: 2 };

  assert.deepEqual(classify(fixture), { named: false, atCeiling: false, sellable: false });
  assert.deepEqual(classify(ceiling), { named: true, atCeiling: true, sellable: false });
  assert.deepEqual(classify(real), { named: true, atCeiling: false, sellable: true });

  assert.equal(shapeProduct(fixture).kind, "demo-fixture");
  assert.equal(shapeProduct(ceiling).kind, "broken-definition");
  assert.equal(shapeProduct(real).kind, "offering");
  assert.equal(shapeProduct(ceiling).trigger.at_plausibility_ceiling, true);
});

test("the shipped feed marks exactly the ceiling-trigger product as a broken definition", () => {
  const broken = feed.products.filter((p) => p.kind === "broken-definition");
  for (const p of broken) assert.ok(p.trigger.at_plausibility_ceiling, `${p.id} marked broken without a ceiling trigger`);
  assert.ok(broken.every((p) => !p.sellable));
});

test("a legacy product without a metric still shapes without throwing or emitting undefined", () => {
  const legacy = { id: "rain-lagos", city: "lagos", threshold_tenths: 1, premium_bp: 500, min_payout: "50000000000000000000000", max_payout: "1000000000000000000000000", max_total_coverage: "1000000000000000000000000", reserved: "0", min_lead_sec: 0, active: true };
  const s = shapeProduct(legacy);
  assert.ok(!JSON.stringify(s).includes("undefined"), "no undefined may leak into the feed");
  assert.equal(s.purchase.method, "buy_cover");
  assert.equal(s.purchase.deposit_rule, "deposit must equal quote(product_id, payout) exactly");
});
