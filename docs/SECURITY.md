# Security model and threat model

Overcover holds capital and pays it out from rules. This document states what it defends, what it
does not, and the residual risk a reviewer should weigh.

## Assets

1. **Pool capital** — providers' NEAR. Must never be paid to a party not entitled to it.
2. **Solvency** — the pool must never promise more than it holds.
3. **Oracle integrity** — a wrong index reading must not settle a policy silently.

## Controls

| Threat | Control |
| --- | --- |
| Pool promises more than it holds | `reserved ≤ capital` re-checked after every state change (`check_invariant_or_panic`); the transaction is rejected otherwise. |
| A provider withdraws capital that backs a live policy | `withdraw` refuses unless `capital − amount ≥ reserved`. |
| A buyer re-prices cover after the fact | Products are immutable. `buy_cover` reads the threshold and premium from the product, never from the caller. |
| A buyer underpays the premium | The attached deposit must **equal** `quote(product, payout)`. |
| Capacity is exceeded | Per-product `reserved + payout ≤ max_total_coverage` and pool `available ≥ payout`. |
| A forged observation | The reading must carry a valid ed25519 signature from the registered attestor. |
| A replayed or cross-contract signature | The signed message binds city, date, value, `reported_at`, a single-use `nonce`, **and the contract id**. |
| A stale observation | An observation must be reported within 24 h of its date. |
| A policy is paid twice | `resolve` settles a policy exactly once; the status transitions to a terminal state. |
| The oracle lies | Anyone may `challenge_observation` with a bond. A disputed reading cannot settle. `resolve_dispute` forfeits the loser's bond to the pool. |
| An implausible reading | Values above 5000 tenths (500 mm) are rejected at the boundary. |
| An unauthorised admin action | `add_product`, `set_attestor`, `set_paused` and `resolve_dispute` are owner-only. |
| Silent failure | Every refusal aborts with a human-readable `panic_utf8` reason, never a bare trap. |
| Front-end trust | The console holds no key and signs nothing on its own; a read failure is shown as stale or "no data", never as live. The only write it can create is a single `buy_cover` call the user approves in their own wallet. |

## Browser wallet model

- **The page never holds a key.** `ui/wallet.js` asks the user's wallet to sign one
  `buy_cover` call; the key stays inside the wallet. There is no key, seed phrase or
  signing secret in the bundle, the page, or this repository.
- **Least privilege.** The function-call access key the wallet grants is scoped to
  `methodNames: ["buy_cover"]` alone, and the console has no other write path.
- **No owner-only method is reachable from the UI.** `deposit`, `reset`, `add_shock`,
  `owner_withdraw`, `set_lifeline_enabled` and `seed_merchant` are never referenced by
  the page or the wallet module; a regression test asserts this.
- **Retired integration removed.** MyNearWallet no longer accepts new application
  connections, so it is removed from the picker, the bundle and the dependency tree
  rather than shown as a working option.
- **No embedded MPC wallet.** A frontend MPC provider that supports NEAR (evaluated:
  MetaMask Embedded Wallets, formerly Web3Auth) requires a project `clientId` **and**
  returns the user's **private key to the page** (`eth_private_key`/`private_key` JSON-RPC
  methods). Both conflict with the guarantee above, so it was not adopted. Email-based
  onboarding is provided by **HERE Wallet**, which authenticates the user with email or a
  social account inside its own app and never exposes a key to this page. No email
  address is ever turned into a key by this site, and no fake MPC is implemented.
- **No funded anonymous signer.** The site is read-only plus a user-signed `buy_cover`;
  it holds no balance and no operator key. The public agent panel is **read-only**: it evaluates a
  purchase in the browser with the same spending-limits engine the agent service runs
  (`agent/limits.mjs`, bundled to `ui/vendor/policy.js`), using the engine's default limits and the
  live contract quote, and it signs nothing. The autonomous agent service itself runs on localhost by
  default, is dry-run by default, and is not hosted publicly; only a service the operator runs can
  send a purchase.

## Trust boundary and honest residual risk

- **The oracle is a single attestor.** It is not decentralised. The mitigation is the **bonded
  dispute path**, which is implemented, unit-tested, and has been exercised on the live testnet demo
  in **both** directions (a reading upheld with the bond forfeited; a reading rejected and
  nullified). It still depends on the **owner** to resolve a dispute, which is a centralisation
  point and the most important thing to decentralise next.
- **The owner is trusted for policy, not for funds.** The owner can publish products, rotate the
  attestor, pause purchases, and resolve disputes. The owner has **no method to move pool capital**;
  the only payout path is `resolve`, which follows the signed reading and the immutable product.
- **The index source is Open-Meteo**, a free public API, read and cross-checked by the driver before
  signing. Its honesty is enforced downstream by the challenge mechanism, not by trusting the API.
- **Testnet only, no audit.** The contract has not been professionally audited. It is deployed to
  testnet and is not for real funds.
- **The demo pins the reading.** The recorded demo reports the same genuine Open-Meteo reading the
  threshold was derived from, so the outcome is deterministic. The value is real and signed; it is
  pinned, not fabricated.
- **No reentrancy surface.** Payouts use `Promise` transfers after all state is written; there is no
  callback into contract logic.

## What has been verified

- A 31-attack reference model (`npm run test:model`): **31 attacks, 31 defended, 0 exploitable.**
- 21 Rust unit tests (`npm run test:contract`).
- 17 adversarial tests against the **live** contract (`npm run test:onchain`): each attack is refused
  with the expected reason.
- The console: 66 regression + live-RPC tests, and `npm run axe` (axe-core, WCAG 2.2 AA) with 0
  violations at 320/360/390/768/1024/1280/1440 px, for the page **and** the wallet dialog.

## Reporting

This is a hackathon project on testnet. If you find an issue, open a GitHub issue with the
transaction hash or the exact call that reproduces it.
