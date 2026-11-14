// Browser entry for the spending-policy engine.
//
// Bundled to ui/vendor/policy.js by scripts/build-wallet.mjs. It re-exports the
// SAME pure module the agent service runs (agent/limits.mjs), so a public
// visitor can evaluate a proposed purchase read-only, in the browser, with no
// server, no key and no transaction. The engine touches no network and holds no
// secret; only the operator's local service can sign a real purchase.
export { DEFAULT_LIMITS, normalizeLimits, evaluate, premiumSpentWithin, policiesWithin, lastBuyAtMs } from "../agent/limits.mjs";
