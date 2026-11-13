//! Overcover observation adapter — an OutLayer WASI-P2 guest.
//!
//! Runs inside OutLayer's Intel TDX worker. It fetches a reading from an
//! explicitly named external source, preserves the original payload, and
//! normalizes it into Overcover's observation schema. OutLayer's per-execution
//! TDX attestation binds the adapter's WASM hash, the input hash and this
//! output hash, so a verifier can prove *this* binary produced *this* output.
//!
//! The attestation proves execution integrity, NOT that the external source is
//! truthful. Operators still sign the normalized reading (`readingMessageV3`)
//! and quorum/disputes still decide whether it settles.
//!
//! I/O contract (matches OutLayer's documented WASI guest interface):
//!   stdin  : one JSON object  (the call's `input`)
//!   stdout : exactly one JSON object, flushed

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wasi_http_client::Client;

const SCHEMA: &str = "overcover.observation.adapter.v1";
const ADAPTER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize)]
struct Input {
    /// Explicit external source URL (https).
    source_url: String,
    /// Human-readable source name, carried into provenance.
    #[serde(default)]
    source_name: String,
    /// RFC-6901 JSON pointer to the numeric reading inside the payload.
    value_pointer: String,
    /// Multiplier applied to the raw value to reach tenths (default 10).
    #[serde(default = "default_scale")]
    value_scale: f64,
    /// Optional JSON pointer to the source's own timestamp — either a unix
    /// integer or an ISO-8601 string (UTC).
    #[serde(default)]
    reported_at_pointer: Option<String>,
    /// Overcover observation fields.
    metric_id: String,
    city: String,
    obs_date: String,
    /// Seconds the reading stays valid after `reported_at` (default 1 day).
    #[serde(default = "default_ttl")]
    ttl_secs: u64,
}

fn default_scale() -> f64 {
    10.0
}
fn default_ttl() -> u64 {
    86_400
}

#[derive(Serialize)]
struct Source {
    url: String,
    name: String,
    http_status: u16,
    content_type: String,
    fetched_at: u64,
}

#[derive(Serialize)]
struct Normalized {
    metric_id: String,
    city: String,
    obs_date: String,
    value_tenths: i64,
    reported_at: u64,
    expiry: u64,
    /// SHA-256 of the exact source payload, hex — becomes Overcover's
    /// on-chain `evidence_hash`, binding the signed reading to these bytes.
    evidence_hash: String,
}

#[derive(Serialize)]
struct Provenance {
    adapter: &'static str,
    adapter_version: &'static str,
    value_pointer: String,
    value_scale: f64,
    source_reported_at: Option<u64>,
    raw_sha256: String,
    attestation_binds: &'static str,
}

#[derive(Serialize)]
struct Output {
    schema: &'static str,
    source: Source,
    /// Original source payload, preserved verbatim.
    raw: String,
    normalized: Normalized,
    provenance: Provenance,
}

#[derive(Serialize)]
struct ErrorOut {
    schema: &'static str,
    error: String,
    detail: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn fail(msg: &str, detail: String) -> ! {
    let out = ErrorOut {
        schema: SCHEMA,
        error: msg.to_string(),
        detail,
    };
    let _ = writeln!(io::stdout(), "{}", serde_json::to_string(&out).unwrap());
    let _ = io::stdout().flush();
    std::process::exit(2);
}

fn main() {
    let mut input_string = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input_string) {
        fail("input_read_failed", e.to_string());
    }
    let input: Input = match serde_json::from_str(&input_string) {
        Ok(v) => v,
        Err(e) => fail("input_invalid_json", e.to_string()),
    };

    if !input.source_url.starts_with("https://") {
        fail("source_url_must_be_https", input.source_url);
    }

    let response = match Client::new()
        .get(&input.source_url)
        .connect_timeout(Duration::from_secs(10))
        .send()
    {
        Ok(r) => r,
        Err(e) => fail("source_unavailable", e.to_string()),
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .cloned()
        .unwrap_or_default();
    let body = match response.body() {
        Ok(b) => b,
        Err(e) => fail("source_body_read_failed", e.to_string()),
    };
    if status != 200 {
        fail("source_http_error", format!("status {status}"));
    }

    let raw = String::from_utf8_lossy(&body).to_string();
    let payload: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => fail("source_malformed_json", e.to_string()),
    };

    let value = match payload.pointer(&input.value_pointer).and_then(|v| v.as_f64()) {
        Some(v) => v,
        None => fail(
            "value_pointer_missing",
            format!("no number at {}", input.value_pointer),
        ),
    };

    let source_reported_at = input
        .reported_at_pointer
        .as_ref()
        .and_then(|p| payload.pointer(p))
        .and_then(parse_timestamp);
    let reported_at = source_reported_at.unwrap_or_else(now);
    let expiry = reported_at.saturating_add(input.ttl_secs);

    let value_tenths = (value * input.value_scale).round() as i64;

    let mut hasher = Sha256::new();
    hasher.update(body.as_slice());
    let raw_sha256 = hex(&hasher.finalize());

    let output = Output {
        schema: SCHEMA,
        source: Source {
            url: input.source_url.clone(),
            name: input.source_name.clone(),
            http_status: status,
            content_type,
            fetched_at: now(),
        },
        raw,
        normalized: Normalized {
            metric_id: input.metric_id,
            city: input.city,
            obs_date: input.obs_date,
            value_tenths,
            reported_at,
            expiry,
            evidence_hash: raw_sha256.clone(),
        },
        provenance: Provenance {
            adapter: "overcover-observation-adapter",
            adapter_version: ADAPTER_VERSION,
            value_pointer: input.value_pointer,
            value_scale: input.value_scale,
            source_reported_at,
            raw_sha256,
            attestation_binds: "wasm_hash, input_hash, output_hash, worker_identity",
        },
    };

    let json = serde_json::to_string(&output).unwrap();
    print!("{json}");
    let _ = io::stdout().flush();
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Accept a unix integer or an ISO-8601 UTC string ("YYYY-MM-DDTHH:MM[:SS]").
fn parse_timestamp(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let s = v.as_str()?;
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da) = (
        d.next()?.parse::<i64>().ok()?,
        d.next()?.parse::<u32>().ok()?,
        d.next()?.parse::<u32>().ok()?,
    );
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let (hh, mm, ss) = (
        t.next()?.parse::<u64>().ok()?,
        t.next().unwrap_or("0").parse::<u64>().ok()?,
        t.next().unwrap_or("0").parse::<u64>().ok()?,
    );
    let days = days_from_civil(y, mo, da);
    let secs = days * 86_400 + (hh * 3600 + mm * 60 + ss) as i64;
    u64::try_from(secs).ok()
}

/// Howard Hinnant's days_from_civil.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as u64 + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}
