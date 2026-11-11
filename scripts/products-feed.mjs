// Generate the machine-readable product feed from the live contract.
//
//   node scripts/products-feed.mjs            # writes ui/products.json
//
// The feed is derived ONLY from contract state (list_products, get_config,
// list_observations). Nothing here is hand-written: every field either comes
// straight from the contract or is computed by a rule the contract enforces
// (premium = ceil(payout * premium_bp / 10000), sellable = named AND not at the
// plausibility ceiling AND active). The same classification the console uses is
// reproduced here so a machine reader sees the same truth a human does.
//
// Money fields are emitted as exact decimal strings (yoctoNEAR) so a consumer
// cannot round them; a human-readable NEAR form is provided alongside.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBigIntJson } from "../agent/json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONTRACT = process.env.OVERCOVER_CONTRACT || "contract.attestor-overcover.testnet";
export const NETWORK = "testnet";
export const PLAUSIBLE_CEILING_TENTHS = 5000; // MAX_RAINFALL_TENTHS in the contract
const MACHINE_ID = /^p-\d+-\d+$/; // demo fixtures from the recorded cycle

const RPC = [
  process.env.OVERCOVER_RPC,
  "https://test.rpc.fastnear.com",
  "https://rpc.testnet.fastnear.com",
  "https://near-testnet.drpc.org",
].filter(Boolean);

async function rpc(method, params) {
  let last;
  for (const url of RPC) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function view(method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  // Exact u128 parsing: a bare JSON.parse rounds money above 2^53, which would
  // publish a wrong payout/premium in the feed.
  return parseBigIntJson(Buffer.from(r.result).toString("utf8"));
}

const near = (yocto) => (Number(BigInt(yocto)) / 1e24).toFixed(4);
const mm = (tenths) => (Number(tenths) / 10).toFixed(1);
const premiumFor = (payoutYocto, bp) => {
  const num = BigInt(payoutYocto) * BigInt(bp);
  return ((num + 9999n) / 10000n).toString(); // ceil(payout * bp / 10000)
};

export function classify(product) {
  const named = !MACHINE_ID.test(product.id);
  const atCeiling = Number(product.threshold_tenths) >= PLAUSIBLE_CEILING_TENTHS;
  const sellable = named && !atCeiling && product.active !== false;
  return { named, atCeiling, sellable };
}

export function shapeProduct(p, config) {
  const { named, atCeiling, sellable } = classify(p);
  // Force every money field to an exact decimal string. parseBigIntJson returns
  // a plain number for values <= 2^53 (e.g. reserved: 0), so without this the
  // feed would mix strings and numbers and a consumer could round or crash.
  const money = (v) => BigInt(v).toString();
  const maxPayout = money(p.max_payout);
  const capacityLeft = (BigInt(p.max_total_coverage) - BigInt(p.reserved)).toString();
  return {
    id: p.id,
    named,
    sellable,
    kind: sellable ? "offering" : atCeiling ? "broken-definition" : "demo-fixture",
    status: sellable ? "available" : "not-offered",
    metric: { name: "rainfall", unit: "mm", city: p.city },
    trigger: {
      direction: "at-or-above",
      threshold_tenths: p.threshold_tenths,
      threshold_mm: mm(p.threshold_tenths),
      at_plausibility_ceiling: atCeiling,
      statement: `Pays if ${p.city} rainfall is at or above ${mm(p.threshold_tenths)} mm on the observation date.`,
    },
    premium: {
      basis_points: p.premium_bp,
      rate_percent: (p.premium_bp / 100).toFixed(2),
      formula: "ceil(payout_yocto * premium_bp / 10000)",
      example_at_max_payout: {
        payout_yocto: maxPayout,
        premium_yocto: premiumFor(maxPayout, p.premium_bp),
        premium_near: near(premiumFor(maxPayout, p.premium_bp)),
      },
    },
    payout: {
      min_yocto: money(p.min_payout),
      max_yocto: maxPayout,
      min_near: near(p.min_payout),
      max_near: near(p.max_payout),
    },
    capacity: {
      max_total_coverage_yocto: money(p.max_total_coverage),
      reserved_yocto: money(p.reserved),
      capacity_left_yocto: capacityLeft,
      capacity_left_near: near(capacityLeft),
    },
    min_lead_sec: p.min_lead_sec,
    active: p.active,
    purchase: {
      contract: CONTRACT,
      network: NETWORK,
      method: "buy_cover",
      args: ["product_id", "payout", "obs_date", "beneficiary"],
      deposit_rule: "deposit must equal quote(product_id, payout) exactly",
      quote_method: "quote",
    },
    config: config
      ? { challenge_window_sec: config.challenge_window_sec, challenge_bond_yocto: money(config.challenge_bond) }
      : null,
  };
}

export async function buildFeed() {
  const [products, config, pool, observations] = await Promise.all([
    view("list_products"),
    view("get_config"),
    view("get_pool"),
    view("list_observations"),
  ]);
  const shaped = products.map((p) => shapeProduct(p, config));
  const money = (v) => BigInt(v).toString();
  return {
    schema: "https://overcover.vercel.app/products.schema.json",
    generated_at: new Date().toISOString(),
    source: {
      network: NETWORK,
      contract: CONTRACT,
      rpc: "public NEAR testnet JSON-RPC call_function views",
      explorer: `https://testnet.nearblocks.io/address/${CONTRACT}`,
      method: "list_products / get_config / get_pool / list_observations",
    },
    protocol: {
      paused: pool.paused,
      solvent: pool.solvent,
      capital_yocto: money(pool.capital),
      reserved_yocto: money(pool.reserved),
      available_yocto: money(pool.available),
      policy_count: pool.policy_count,
      challenge_window_sec: config.challenge_window_sec,
      challenge_bond_yocto: money(config.challenge_bond),
    },
    disclaimer:
      "Testnet prototype with test funds. Unaudited. Parametric (payout follows the index reading, not a loss assessment). Not an offer of real insurance.",
    products: shaped,
    offerings: shaped.filter((p) => p.sellable).map((p) => p.id),
    observation_count: observations.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const feed = await buildFeed();
  const out = path.join(root, "ui", "products.json");
  fs.writeFileSync(out, JSON.stringify(feed, null, 2) + "\n");
  console.log(`wrote ${path.relative(root, out)} — ${feed.products.length} products, ${feed.offerings.length} sellable`);
  console.log(`  offerings: ${feed.offerings.join(", ") || "(none)"}`);
  console.log(`  solvent: ${feed.protocol.solvent}  paused: ${feed.protocol.paused}`);
}
