// Generate the discovery feed the console's "Insurance factory" panel reads.
//
//   node scripts/factory-feed.mjs            # writes ui/factory.json
//
// The feed is the DISCOVERY AGENT's current, real proposal(s): a forecast read
// from Open-Meteo, run through the deterministic risk rule, with the exact
// source URL and a sha256 of the evidence. It is NOT contract state — the
// console reads the *activated* products straight from the contract itself.
//
// Nothing here is hand-written: every value comes from the live provider or from
// the agent's pure functions. A forecast is labelled `forecast` and its coverage
// start is in the future, so it is never presented as an event that happened.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchForecast, classifyRisk, evidenceHash } from "../agent/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Cities the console already knows (driver/cities.js). Kept here as plain keys so
// the feed stays a data file; the coordinates live in the agent.
const SCAN = [
  { city: "miami", metric: "rain", threshold: 300 },
  { city: "singapore", metric: "rain", threshold: 300 },
  { city: "mumbai", metric: "rain", threshold: 300 },
  { city: "manila", metric: "rain", threshold: 300 },
  { city: "jakarta", metric: "rain", threshold: 300 },
  { city: "kolkata", metric: "rain", threshold: 300 },
  { city: "lagos", metric: "rain", threshold: 300 },
  { city: "bogota", metric: "rain", threshold: 300 },
  { city: "bergen", metric: "rain", threshold: 300 },
  { city: "london", metric: "rain", threshold: 300 },
];
const HORIZON_DAYS = [1, 2, 3, 4, 5, 6, 7];

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const proposals = [];
  for (const s of SCAN) {
    let best = null;
    for (const d of HORIZON_DAYS) {
      let f;
      try { f = await fetchForecast(s.metric, s.city, now + d * 86400); } catch { continue; }
      const risk = classifyRisk(f, s.threshold);
      if (risk.emerging && (!best || f.valueTenths > best.forecast.valueTenths)) best = { forecast: f, risk };
    }
    if (!best) continue;
    proposals.push({
      id: `factory-${s.metric}-${s.city}-${best.forecast.date}`,
      status: "PROPOSED",
      metric: s.metric,
      city: s.city,
      direction: best.risk.direction,
      thresholdTenths: s.threshold,
      premiumBp: 500,
      coverageStartSec: now + 2 * 3600,
      evidence: {
        kind: best.forecast.kind,
        source: best.forecast.source,
        sourceUrl: best.forecast.sourceUrl,
        observedAt: best.forecast.date,
        valueTenths: best.forecast.valueTenths,
        unit: best.forecast.unit,
        raw: best.forecast.raw,
        hash: evidenceHash(best.forecast),
      },
      risk: best.risk,
    });
  }
  proposals.sort((a, b) => b.risk.marginTenths - a.risk.marginTenths);
  const feed = {
    generatedAt: new Date(now * 1000).toISOString(),
    provider: "open-meteo",
    kind: "forecast",
    note: "Prepared proposals from the discovery agent. A forecast motivates a prospective product; it is not an observation of an event that occurred. Products the protocol has ACTIVATED are read from the contract itself, not from this file.",
    proposals,
  };
  const out = path.join(root, "ui", "factory.json");
  fs.writeFileSync(out, JSON.stringify(feed, null, 2) + "\n");
  console.log(`wrote ${path.relative(root, out)} — ${proposals.length} emerging-risk proposal(s)`);
  for (const p of proposals) console.log(`  ${p.city} ${p.evidence.valueTenths}${p.evidence.unit} by ${p.evidence.observedAt} (${p.evidence.hash.slice(0, 20)}…)`);
}

main().catch((e) => { console.error("factory feed failed:", e.message); process.exit(1); });
