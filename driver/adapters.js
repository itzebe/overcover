// Overcover — metric adapters.
//
// A single place that turns a (metric, city, date) into a signed-ready reading.
// Each adapter is an independent observation of a public, keyless source
// (Open-Meteo), so adding a risk category is a new adapter entry, not a change
// to the contract or the operator node.
//
// Every adapter returns tenths-scaled integers matching the metric's `scale`,
// so the value can be compared to the product threshold without floating point.
//
// Common-mode dependency (disclosed, not hidden): Open-Meteo is one upstream
// provider. Operators that all read Open-Meteo share that dependency, so
// independent *signing* does not by itself make the *data* independent. A
// production deployment should point different operators at different upstreams
// (see docs/ORACLE_OPERATIONS.md).

import { CITIES } from "./cities.js";
import { createHash } from "node:crypto";

const UA = { "User-Agent": "overcover-oracle/1.0" };

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`open-meteo ${res.status} ${url}`);
  return res.json();
}

function coords(cityKey) {
  const c = CITIES[cityKey];
  if (!c) throw new Error(`unknown city: ${cityKey}`);
  return c;
}

function ymd(dateSec) {
  const d = new Date(dateSec * 1000);
  return d.toISOString().slice(0, 10);
}

const tenths = (v) => Math.round(Number(v) * 10);

/** Daily total precipitation (mm) -> tenths of mm. Trigger: excess rainfall. */
export async function precipDaily(cityKey, dateSec) {
  const c = coords(cityKey);
  const day = ymd(dateSec);
  const j = await fetchJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}` +
      `&start_date=${day}&end_date=${day}&daily=precipitation_sum&timezone=UTC`
  );
  const v = j?.daily?.precipitation_sum?.[0];
  if (v === undefined || v === null) throw new Error(`no precipitation for ${cityKey} ${day}`);
  return { valueTenths: tenths(v), unit: "mm/10", source: "open-meteo:archive:daily_precipitation_sum", raw: v };
}

/** Daily total precipitation (mm) -> tenths of mm. Trigger: deficit (below). */
export async function droughtDaily(cityKey, dateSec) {
  const r = await precipDaily(cityKey, dateSec);
  return { ...r, source: "open-meteo:archive:daily_precipitation_sum (deficit)" };
}

/** Daily maximum temperature (degC) -> tenths of degC. Trigger: extreme heat. */
export async function tempMaxDaily(cityKey, dateSec) {
  const c = coords(cityKey);
  const day = ymd(dateSec);
  const j = await fetchJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}` +
      `&start_date=${day}&end_date=${day}&daily=temperature_2m_max&timezone=UTC`
  );
  const v = j?.daily?.temperature_2m_max?.[0];
  if (v === undefined || v === null) throw new Error(`no temperature for ${cityKey} ${day}`);
  return { valueTenths: tenths(v), unit: "degC/10", source: "open-meteo:archive:daily_temperature_2m_max", raw: v };
}

/** Daily maximum wind speed (m/s) -> tenths of m/s. Trigger: severe wind. */
export async function windMaxDaily(cityKey, dateSec) {
  const c = coords(cityKey);
  const day = ymd(dateSec);
  const j = await fetchJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${c.lat}&longitude=${c.lon}` +
      `&start_date=${day}&end_date=${day}&daily=wind_speed_10m_max&timezone=UTC`
  );
  const v = j?.daily?.wind_speed_10m_max?.[0];
  if (v === undefined || v === null) throw new Error(`no wind speed for ${cityKey} ${day}`);
  // Open-Meteo returns km/h for wind_speed_10m_max; convert to m/s.
  const mps = Number(v) / 3.6;
  return { valueTenths: tenths(mps), unit: "m/s/10", source: "open-meteo:archive:daily_wind_speed_10m_max", raw: v };
}

/** metric id -> adapter. Matches the metrics published on-chain. */
export const ADAPTERS = {
  rain: precipDaily,
  drought: droughtDaily,
  heat: tempMaxDaily,
  wind: windMaxDaily,
};

export async function observe(metricId, cityKey, dateSec) {
  const fn = ADAPTERS[metricId];
  if (!fn) throw new Error(`no adapter for metric ${metricId}`);
  const r = await fn(cityKey, dateSec);
  // Bind the observation to a hash of its source bundle, so the on-chain reading
  // commits to the exact evidence the operator saw. The hash is part of the
  // signed payload (see driver/attestor.js `readingMessageV3`).
  if (!r.evidenceHash) {
    const bundle = `${metricId}|${cityKey}|${dateSec}|${r.valueTenths}|${r.source}|${r.raw}`;
    r.evidenceHash = Array.from(createHash("sha256").update(bundle).digest().subarray(0, 16));
  }
  return r;
}
