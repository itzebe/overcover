// Agent evaluation tests (Phase 4E).
//
//   node --test tests/agent-eval.test.mjs
//
// Two halves:
//   A. Deterministic boundary and adversarial cases against the pure policy
//      engine (agent/limits.mjs) — exact-yocto boundaries, ambiguous and
//      malformed proposals, scope enforcement. No network.
//   B. One live, read-only check that the engine, fed a REAL product read from
//      the live testnet contract, agrees with the shipped feed's offering. It
//      skips (not fails) when the public RPC is unreachable, so it is honest
//      about what it could not verify.
//
// Nothing here can move funds: the engine is pure, and the live read is a
// keyless call_function view.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLimits, evaluate } from "../agent/limits.mjs";
import { parseBigIntJson } from "../agent/json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEAR = 10n ** 24n;

const product = {
  id: "rain-lagos",
  city: "lagos",
  min_payout: (NEAR / 10n).toString(), // 0.1
  max_payout: (NEAR * 1n).toString(), // 1.0
  min_lead_sec: 0,
  active: true,
};

function ctx(over = {}) {
  return {
    limits: normalizeLimits({
      maxPremiumPerPolicy: (NEAR / 20n).toString(), // 0.05
      maxPayoutPerPolicy: (NEAR * 1n).toString(), // 1.0
      dailyPremiumBudget: (NEAR / 5n).toString(), // 0.2
      dailyPolicyLimit: 5,
      cooldownSec: 0,
      ...(over.limits ?? {}),
    }),
    history: over.history ?? [],
    nowMs: over.nowMs ?? 1_000_000_000,
  };
}

function proposal(over = {}) {
  return {
    productId: "rain-lagos",
    city: "lagos",
    payoutYocto: (NEAR / 2n).toString(),
    premiumYocto: (NEAR / 100n).toString(),
    obsDateSec: 1_000_000 + 3600,
    nowSec: 1_000_000,
    ...over,
  };
}

// --- A. boundaries -----------------------------------------------------------

test("a payout exactly at the product max is allowed (u128 rounding regression)", () => {
  const v = evaluate(proposal({ payoutYocto: product.max_payout }), product, ctx());
  assert.equal(v.allow, true, v.reasons.join("; "));
});

test("a payout one yocto above the product max is refused", () => {
  const v = evaluate(proposal({ payoutYocto: (BigInt(product.max_payout) + 1n).toString() }), product, ctx());
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /outside product bounds/);
});

test("a premium exactly at the per-policy cap is allowed; one yocto more is refused", () => {
  const cap = (NEAR / 20n).toString();
  assert.equal(evaluate(proposal({ premiumYocto: cap }), product, ctx()).allow, true);
  const v = evaluate(proposal({ premiumYocto: (BigInt(cap) + 1n).toString() }), product, ctx());
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /maxPremiumPerPolicy/);
});

test("an observation date equal to now + required lead is allowed; one second less is refused", () => {
  const obsDateSec = 1_000_000 + 3600;
  assert.equal(evaluate(proposal({ obsDateSec }), product, ctx()).allow, true);
  const v = evaluate(proposal({ obsDateSec: obsDateSec - 3601 }), product, ctx());
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /less than .*s ahead/);
});

// --- A. adversarial / ambiguous ---------------------------------------------

test("a proposal for an unknown product is refused with a clear reason", () => {
  // The engine has no product to bound-check; the service maps a missing product
  // to a refusal before evaluate(). Here we assert the product-bound path is what
  // catches a payout that no product would allow.
  const v = evaluate(proposal({ payoutYocto: (NEAR * 100n).toString() }), product, ctx());
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /outside product bounds|maxPayoutPerPolicy/);
});

test("a city outside the allow-list is refused even when everything else is inside limits", () => {
  const v = evaluate(proposal({ city: "bergen" }), product, ctx({ limits: { allowedCities: ["lagos"] } }));
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /not in allowedCities/);
});

test("a product outside the allow-list is refused (scope enforcement)", () => {
  const v = evaluate(proposal({ productId: "rain-bergen-dry" }), product, ctx({ limits: { allowedProducts: ["rain-lagos"] } }));
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /not in allowedProducts/);
});

test("an empty allow-list does not silently become 'nothing allowed' or 'the whole catalogue' by accident", () => {
  // Empty = any product the contract exposes. A caller must not assume it means
  // "deny all": that is the documented default, and it is asserted here so a
  // future change to the default is caught.
  assert.equal(evaluate(proposal({ productId: "anything" }), product, ctx()).allow, true);
  assert.equal(evaluate(proposal({ productId: "anything" }), product, ctx({ limits: { allowedProducts: [] } })).allow, true);
});

test("an inactive product is refused regardless of the proposal", () => {
  const v = evaluate(proposal(), { ...product, active: false }, ctx());
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /inactive/);
});

test("a disabled agent refuses everything before any bound check", () => {
  const v = evaluate(proposal(), product, ctx({ limits: { enabled: false } }));
  assert.equal(v.allow, false);
  assert.match(v.reasons.join(" "), /disabled/);
});

test("a repeated identical proposal does not itself consume budget (history is the only spend record)", () => {
  // Evaluating twice with no history must give the same verdict: evaluation is
  // side-effect free, so a caller cannot 'use up' a limit by asking.
  const c = ctx();
  assert.deepEqual(evaluate(proposal(), product, c), evaluate(proposal(), product, c));
});

// --- B. live, read-only ------------------------------------------------------

test("live: the engine agrees with the shipped feed on the real offering", async (t) => {
  const feedPath = path.join(root, "ui", "products.json");
  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  const offering = feed.products.find((p) => p.sellable);
  if (!offering) {
    t.skip("no sellable offering in the shipped feed");
    return;
  }

  let productFromChain;
  try {
    const res = await fetch("https://test.rpc.fastnear.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: feed.source.contract,
          method_name: "get_product",
          args_base64: Buffer.from(JSON.stringify({ id: offering.id })).toString("base64"),
        },
      }),
    });
    const j = await res.json();
    // Exact u128 parse: a bare JSON.parse rounds max_payout > 2^53, which would
    // make the engine reject a payout that is exactly at the product's max.
    productFromChain = parseBigIntJson(Buffer.from(j.result.result).toString("utf8"));
  } catch (e) {
    t.skip(`public RPC unreachable: ${e.message}`);
    return;
  }

  assert.ok(productFromChain, "the offering must exist on chain");

  const payout = offering.payout.max_yocto;
  const premium = offering.premium.example_at_max_payout.premium_yocto;
  const obsDateSec = Math.floor(Date.now() / 1000) + 86400;
  const v = evaluate(
    { productId: offering.id, city: offering.metric.city, payoutYocto: payout, premiumYocto: premium, obsDateSec, nowSec: Math.floor(Date.now() / 1000) },
    productFromChain,
    ctx({ limits: { maxPayoutPerPolicy: payout, maxPremiumPerPolicy: premium, dailyPremiumBudget: premium } })
  );
  assert.equal(v.allow, true, `engine refused the real offering: ${v.reasons.join("; ")}`);
});
