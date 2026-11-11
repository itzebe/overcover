// Bundle the browser assets into single IIFEs the console can load with a plain
// <script>. Kept deliberately small and reproducible.
//
//   node scripts/build-wallet.mjs
//
// Two bundles are produced:
//   * ui/vendor/wallet-bundle.js — the wallet integration (the only code that
//     touches a wallet extension).
//   * ui/vendor/policy.js        — the SAME spending-policy engine the agent
//     service runs (agent/limits.mjs), so the public console can evaluate a
//     purchase read-only, in the browser, with no server and no key. It bundles
//     pure logic only: no key, no network, no transaction signing.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// @here-wallet/core (pulled in by @near-wallet-selector/here-wallet) imports Node
// built-ins. They are shimmed to their browser equivalents so the bundle runs in
// a page; nothing here changes wallet behaviour, it only supplies the modules.
const shims = {
  crypto: path.join(root, "ui", "shims", "crypto.js"),
  stream: "stream-browserify",
  buffer: "buffer",
  util: "util",
  process: path.join(root, "node_modules", "process", "browser.js"),
  events: "events",
  vm: "vm-browserify",
  path: "path-browserify",
};

const result = await build({
  entryPoints: [path.join(root, "ui", "wallet.js")],
  outfile: path.join(root, "ui", "vendor", "wallet-bundle.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  alias: shims,
  inject: [path.join(root, "ui", "shims", "inject.js")],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "info",
});

if (result.errors.length) {
  console.error("wallet bundle failed:", result.errors);
  process.exit(1);
}
console.log("built ui/vendor/wallet-bundle.js");

// The policy bundle is pure logic, so it needs no shims. It exposes the exact
// engine the agent service runs, for a read-only, keyless browser evaluation.
const policy = await build({
  entryPoints: [path.join(root, "ui", "policy.js")],
  outfile: path.join(root, "ui", "vendor", "policy.js"),
  bundle: true,
  format: "iife",
  globalName: "OvercoverPolicy",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

if (policy.errors.length) {
  console.error("policy bundle failed:", policy.errors);
  process.exit(1);
}
console.log("built ui/vendor/policy.js");
