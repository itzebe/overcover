// Resolve a NEAR sandbox (neard) binary for the local end-to-end proof.
//
// The contract wasm is produced by a recent rustc, and the old near-sandbox
// (neard 2.6.2) cannot execute it — it traps with a wasmtime deserialization
// error. neard 2.14 runs it. This helper returns the path to a usable binary:
//
//   1. $NEAR_SANDBOX_BIN, if set (the caller supplies its own);
//   2. a cached copy under ~/.cache/overcover-near-sandbox/<version>/;
//   3. otherwise it downloads the official sandbox tarball, verifies its sha256
//      against the pin below, extracts it, and returns the path.
//
// On a platform without a matching binary, or when the download fails, it
// returns null unless REQUIRE_SANDBOX=1 is set, in which case it throws so a
// caller (CI) fails loudly instead of silently skipping the proof.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const VERSION = "2.14.0";
const PLATFORM = "Linux-x86_64";
const URL = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${PLATFORM}/${VERSION}/near-sandbox.tar.gz`;
// sha256 of the official near-sandbox.tar.gz for the version above.
const SHA256 = "a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691";
const CACHE = path.join(os.homedir(), ".cache", "overcover-near-sandbox", VERSION);

export async function ensureSandboxBin() {
  if (process.env.NEAR_SANDBOX_BIN) return process.env.NEAR_SANDBOX_BIN;
  const bin = path.join(CACHE, PLATFORM, "near-sandbox");
  if (fs.existsSync(bin)) return bin;
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== SHA256) throw new Error(`sha256 mismatch (got ${sha})`);
    const tar = path.join(CACHE, "near-sandbox.tar.gz");
    fs.writeFileSync(tar, buf);
    const r = spawnSync("tar", ["xzf", tar, "-C", CACHE], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar extraction failed");
    fs.chmodSync(bin, 0o755);
    return bin;
  } catch (e) {
    if (process.env.REQUIRE_SANDBOX === "1") throw e;
    console.error(`sandbox unavailable (${e.message}); skipping the local proof`);
    return null;
  }
}
