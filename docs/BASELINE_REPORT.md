# OVERCOVER — baseline report (start of the decentralization mission)

**Captured:** 2026-11-11 · before any change on branch `feat/decentralized-insurance-lifecycle`.

## Live state (independently verified, not assumed)

| Item | Value | How verified |
| --- | --- | --- |
| Repository | `itzebe/overcover` (public) | `git remote -v` |
| Default branch | `main` | GitHub API `repos/itzebe/overcover` |
| Starting commit | `18ec7f0883d42e8a47129c6cd9b692b895d34724` | `git rev-parse HEAD` |
| Working tree | clean | `git status --short` |
| Open PRs | none (PRs #1–#8 all closed/merged) | GitHub API |
| Production deployment | `dpl_3ZMTMp5uVQWUDv6Ye4T7dS1PHzy2` (READY) | Vercel API |
| Deployed SHA | `18ec7f0` | Vercel `meta.githubCommitSha` |
| Contract account | `contract.attestor-overcover.testnet` | RPC `view_account` |
| Contract code_hash | `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R` | RPC |
| Contract balance | 18.547 NEAR | RPC |
| Owner | `owner.attestor-overcover.testnet` | `get_config` |
| Attestor (single key) | `4dhxyFrsS8y8HhS2CCFYHRbpjTGRudSqPWoHYCRECTxC` | `get_config` |
| Challenge bond / window | 0.1 NEAR / 60 s | `get_config` |
| Pool | capital 14.05, reserved 10.50, available 3.55, solvent true | `get_pool` |
| Products | 22 (2 canonical `rain-lagos`,`rain-bergen-dry` + 20 machine `p-*` demo rows) | `list_products` |
| Policies | 15 | `list_policies` |

## What genuinely works (on-chain)

- Capital deposit / withdraw with the `reserved <= capital` solvency gate.
- Immutable products; contract-owned premium (`quote`), contract-owned threshold.
- `buy_cover` reserves the payout and enforces capacity + available capital.
- Single-attestor ed25519 observation, freshness/range/replay checks.
- Bonded challenge + owner resolution; fail-closed on an unresolved dispute.
- Settlement exactly once, releasing the reservation; `reconcile()` accounting identity.

## Architectural limitations this mission must address

1. **Single trusted attestor.** `attestor: Vec<u8>` — one key. `report_observation` accepts one
   signature. There is no operator registry and no quorum. A single compromised key forges any
   reading. → *Decentralize into a registry + configurable quorum.*
2. **Owner resolves disputes unilaterally.** `resolve_dispute` is `assert_owner()`. The owner is a
   single trusted party who can silently override a contested result. → *Independent resolver set +
   quorum; the reporter may not decide its own dispute.*
3. **Rainfall is hardcoded.** `MAX_RAINFALL_TENTHS`, `city`, `threshold_tenths`, `value_tenths`, and
   the `obs_message` bind "city". No risk category, index id, unit, or per-index plausibility. →
   *Generalize the product/index model.*
4. **No deterministic full-lifecycle simulation** that runs discovery → quote → purchase →
   reservation → observation → quorum → dispute → settlement → payout → reconciliation as one
   reproducible harness with virtual time and an adversarial matrix.
5. **No second/third risk category** with a real, free data source.

## Reported-vs-actual reconciliation

- Reported SHA `18ec7f0…` — **matches** the current `main`.
- Reported deployment `dpl_3ZMTMp5uVQWUDv6Ye4T7dS1PHzy2` — **matches** the latest production deploy.
- Reported contract — **matches**; note the code_hash corresponds to the **currently deployed v1**
  contract, which this mission does **not** replace (no deploy/migration without approval).

## Trust assumptions present at baseline (to be reduced, not hidden)

| Assumption | Status at baseline |
| --- | --- |
| One attestor key is honest | Absolute trust in a single key |
| Owner resolves disputes fairly | Absolute trust in one account |
| Owner publishes products fairly | Owner-gated; documented |
| Data source truth | Single upstream, unattested |

Everything above is the "before". The branch records the "after".
