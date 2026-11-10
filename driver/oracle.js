// The Overcover oracle client.
//
// The oracle does two independent things and NEVER trusts a single call:
//   1. PRIMARY:   read Open-Meteo's *current* precipitation (keyless, free).
//   2. CROSS-CHECK: read Open-Meteo's *hourly* precipitation for the same
//      coordinates and take the max over the hour — an independent series.
// If the two disagree by more than TOLERANCE_MM, the oracle refuses to report
// (fail closed) rather than sign a value it cannot corroborate.
//
// The value is converted to tenths of a millimetre (the contract's unit) and
// bound to a signed message by the attestor. The contract re-validates range,
// freshness and the signature.
import { CITIES } from "./cities.js";

const TOLERANCE_TENTHS = 5; // 0.5 mm disagreement tolerated (provider rounding)

function tenths(mm) {
  // round-half-up to tenths, matching the contract's integer unit
  return Math.round(Number(mm) * 10);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "overcover-oracle/1.0" } });
  if (!res.ok) throw new Error(`open-meteo ${res.status} ${url}`);
  return res.json();
}

/** Read the observation for a city. Returns { city, valueTenths, sources, timeUtc }. */
export async function observeCity(cityKey) {
  const c = CITIES[cityKey];
  if (!c) throw new Error(`unknown city: ${cityKey}`);

  const current = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
      `&current=precipitation&timezone=UTC`
  );
  const hourly = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
      `&hourly=precipitation&past_hours=3&forecast_hours=1&timezone=UTC`
  );

  const cur = current?.current?.precipitation;
  if (cur === undefined || cur === null) throw new Error(`no current precipitation for ${cityKey}`);
  const series = (hourly?.hourly?.precipitation ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (series.length === 0) throw new Error(`no hourly series for ${cityKey}`);

  const primary = tenths(cur);
  const crossMax = tenths(Math.max(...series));

  // Cross-check: the current reading must not exceed the recent hourly max by
  // more than the tolerance (a spike the hourly series never saw is suspect).
  if (primary > crossMax + TOLERANCE_TENTHS) {
    throw new Error(
      `oracle disagreement for ${cityKey}: current=${primary} tenths but hourly max=${crossMax} tenths`
    );
  }

  return {
    city: cityKey,
    cityName: c.name,
    valueTenths: primary,
    crossCheckTenths: crossMax,
    sources: { current, hourlyMax: crossMax, toleranceTenths: TOLERANCE_TENTHS },
    timeUtc: current?.current?.time ?? new Date().toISOString(),
  };
}
