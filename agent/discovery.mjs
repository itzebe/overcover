// Overcover discovery agent — a PROPOSER, not a financial authority.
//
//   node agent/discovery.mjs --metric rain --city lagos
//   node agent/discovery.mjs --metric rain --city lagos --json
//
// What it does
// ------------
// 1. Reads a real public forecast (Open-Meteo) for a supported city/metric.
// 2. Decides, by a deterministic rule, whether that forecast is an *emerging
//    risk* worth covering (forecast total above the metric's threshold).
// 3. Preserves the exact source evidence and a sha256 of it.
// 4. Emits a structured proposal the permissionless `propose_product` path
//    accepts — a *prospective* product: the coverage start is in the future.
//
// What it must NOT do (and does not)
// ----------------------------------
// * It never invents an observation. A FORECAST is labelled `forecast` and is
//   used only to motivate a product whose coverage is in the future. It is never
//   presented as proof an event has already happened (that is the oracle's job,
//   via signed observations the contract verifies).
// * It never invents a premium or payout. The premium is the contract's own
//   formula `ceil(payout * premium_bp / 10000)`; the payouts are chosen from a
//   small, declared band and then re-validated by the contract.
// * It never spends funds unless the operator explicitly supplies a signer and a
//   contract id. By default it only *prepares* a proposal.
import { createHash } from "node:crypto";
import { CITIES } from "../driver/cities.js";

const UA = { "User-Agent": "overcover-discovery/1.0" };

// The forecast adapter: same cities/units as the oracle adapters, but the
// forecast endpoint. Kept separate from driver/adapters.js (which reads the
// historical *archive*) so a forecast is never confused with an observation.
const FORECAST_FIELD = {
  rain: { daily: "precipitation_sum", unit: "mm/10", scale: 10, direction: "Above", note: "excess rainfall" },
  drought: { daily: "precipitation_sum", unit: "mm/10", scale: 10, direction: "Below", note: "rainfall deficit" },
  heat: { daily: "temperature_2m_max", unit: "degC/10", scale: 10, direction: "Above", note: "extreme heat" },
  wind: { daily: "wind_speed_10m_max", unit: "m/s/10", scale: 10, direction: "Above", note: "severe wind", kmh: true },
};

function coords(cityKey) {
  const c = CITIES[cityKey];
  if (!c) throw new Error(`unknown city: ${cityKey}`);
  return c;
}

function ymd(dateSec) {
  return new Date(dateSec * 1000).toISOString().slice(0, 10);
}

/// Fetch the forecast bundle for (metric, city, date). Returns the raw provider
/// payload plus the tenths-scaled value, clearly labelled as a forecast.
export async function fetchForecast(metricId, cityKey, dateSec, { fetchImpl = fetch } = {}) {
  const spec = FORECAST_FIELD[metricId];
  if (!spec) throw new Error(`no forecast adapter for metric ${metricId}`);
  const c = coords(cityKey);
  const day = ymd(dateSec);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    `&daily=${spec.daily}&timezone=UTC&start_date=${day}&end_date=${day}`;
  const res = await fetchImpl(url, { headers: UA });
  if (!res.ok) throw new Error(`open-meteo forecast ${res.status}`);
  const j = await res.json();
  const raw = j?.daily?.[spec.daily]?.[0];
  if (raw === undefined || raw === null) throw new Error(`no ${spec.daily} for ${cityKey} ${day}`);
  const physical = spec.kmh ? Number(raw) / 3.6 : Number(raw);
  const valueTenths = Math.round(physical * spec.scale);
  return {
    kind: "forecast",
    metricId,
    city: cityKey,
    date: day,
    valueTenths,
    unit: spec.unit,
    direction: spec.direction,
    source: `open-meteo:forecast:${spec.daily}`,
    sourceUrl: url,
    raw,
    note: spec.note,
  };
}

/// Human-readable physical value, e.g. 615 tenths of mm -> "61.5 mm". The stored
/// `valueTenths` and `unit` ("mm/10") stay exact; this is only for prose.
export function physicalLabel(valueTenths, unit) {
  const name = String(unit).replace(/\/\s*10$/, "");
  return (valueTenths / 10).toFixed(1) + " " + name;
}

/// Deterministic risk rule. A forecast "emerges" as a coverable risk when the
/// forecast value crosses the threshold in the metric's direction. Pure and
/// reproducible: the same inputs always yield the same verdict.
export function classifyRisk(forecast, thresholdTenths) {
  const above = forecast.direction === "Above";
  const emerging = above ? forecast.valueTenths >= thresholdTenths : forecast.valueTenths <= thresholdTenths;
  const margin = above ? forecast.valueTenths - thresholdTenths : thresholdTenths - forecast.valueTenths;
  const seen = physicalLabel(forecast.valueTenths, forecast.unit);
  const trigger = physicalLabel(thresholdTenths, forecast.unit);
  return {
    emerging,
    direction: forecast.direction,
    thresholdTenths,
    valueTenths: forecast.valueTenths,
    marginTenths: margin,
    rationale: emerging
      ? `${forecast.note}: forecast ${seen} crosses trigger ${trigger} (${forecast.direction})`
      : `${forecast.note}: forecast ${seen} does not cross trigger ${trigger} (${forecast.direction})`,
  };
}

/// sha256 of the evidence bundle. This is the reference recorded with the
/// proposal and, later, in the operator's signed observation payload, so the
/// on-chain reading commits to exactly the evidence the agent saw.
export function evidenceHash(forecast) {
  const bundle = `${forecast.kind}|${forecast.metricId}|${forecast.city}|${forecast.date}|${forecast.valueTenths}|${forecast.source}|${forecast.raw}`;
  return "sha256:" + createHash("sha256").update(bundle).digest("hex");
}

/// Assemble the structured proposal the contract will judge. `coverageStartSec`
/// must be prospective; the caller supplies the network time.
export function buildProposal({ forecast, thresholdTenths, coverageStartSec, minPayoutYocto, maxPayoutYocto, premiumBp = 500 }) {
  const risk = classifyRisk(forecast, thresholdTenths);
  return {
    status: risk.emerging ? "PROPOSED" : "DISCOVERED",
    metricId: forecast.metricId,
    city: forecast.city,
    direction: forecast.direction,
    thresholdTenths,
    premiumBp,
    minPayoutYocto: String(minPayoutYocto),
    maxPayoutYocto: String(maxPayoutYocto),
    coverageStartSec: coverageStartSec,
    evidence: {
      kind: forecast.kind,
      source: forecast.source,
      sourceUrl: forecast.sourceUrl,
      observedAt: forecast.date,
      valueTenths: forecast.valueTenths,
      unit: forecast.unit,
      raw: forecast.raw,
      hash: evidenceHash(forecast),
    },
    risk,
    // The proposal id is deterministic from the evidence, so a re-run cannot
    // mint a duplicate product for the same event.
    id: `factory-${forecast.metricId}-${forecast.city}-${forecast.date}`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function cli() {
  const metricId = arg("metric", "rain");
  const cityKey = arg("city", "lagos");
  const thresholdTenths = Number(arg("threshold", metricId === "heat" ? "350" : "300"));
  const leadSec = Number(arg("lead", "7200"));
  const minPayout = arg("min-payout", "1000000000000000000000000"); // 1 NEAR
  const maxPayout = arg("max-payout", "10000000000000000000000"); // 10 NEAR
  const dateSec = Number(arg("date", String(Math.floor(Date.now() / 1000) + 86400)));
  const forecast = await fetchForecast(metricId, cityKey, dateSec);
  const proposal = buildProposal({
    forecast,
    thresholdTenths,
    coverageStartSec: Math.floor(Date.now() / 1000) + leadSec,
    minPayoutYocto: minPayout,
    maxPayoutYocto: maxPayout,
  });
  console.log(JSON.stringify(proposal, null, 2));
  if (!proposal.risk.emerging) process.exitCode = 2; // "no emerging risk" is not an error, but a distinct signal
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => { console.error("discovery failed:", e.message); process.exit(1); });
}
