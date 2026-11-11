# Authority recovery and the controlled v3 deployment

**As of:** 2026-11-11 · **Live contract:** `contract.attestor-overcover.testnet` (NEAR testnet)
**Repository HEAD:** `6d28aeaef5fe1c2be0a442bed282227744728e40`

This document records what was investigated about control of the legacy contract account, what the
evidence shows, and the exact path that closes finding **SEC-1** on a fresh, operator-controlled
account. It contains no secret material — only public on-chain facts and public key identifiers.

---

## 1. The finding (restated)

The live contract `contract.attestor-overcover.testnet` runs **v1**, whose `migrate()` is
`#[init(ignore_state)]`. That attribute runs *before* any state is read, so v1's `migrate` cannot
consult the stored owner: **any** account can call it and overwrite owner + attestor, then forge an
observation and drain the pool. This is finding **SEC-1**. It is **open on the live address** because
the v3 source that fixes it (a self-call guard) is merged but has never been deployed there.

Live proof it is v1 (read over public RPC, `finality: final`):

- `code_hash` `36koHoSdqrYiBNkaNaLEanPAspLMioyZYT9qUcELoY2R`;
- `get_config` has **no** `quorum`, `resolver_quorum` or `operators` fields;
- `list_metrics`, `list_operators`, `list_resolvers` **do not exist** (the RPC returns an error).

## 2. Who can upgrade it

An in-place upgrade of a NEAR contract requires signing a `DeployContract` action **as the contract
account itself**. That signature needs a **FullAccess** key on
`contract.attestor-overcover.testnet`. The account currently holds exactly one key:

| Account | Access key (public, abbreviated) | Permission | Balance |
| --- | --- | --- | --- |
| `contract.attestor-overcover.testnet` | `ed25519:CwZBmKyV…eiRre` | FullAccess | 18.547 NEAR |
| `owner.attestor-overcover.testnet` | `ed25519:3RJTRuyp…dyfGD` | FullAccess | 1.963 NEAR |
| `attestor-overcover.testnet` | `ed25519:4dhxyFrs…ECTxC` | FullAccess | 13.312 NEAR |

The full keys are public (query `view_access_key_list` on the account). They are abbreviated here
so the repository keeps the CI rule that no `ed25519:`-prefixed key material is ever committed — the
scan cannot tell a public key from a private one.

The **private** half of `ed25519:CwZBmKyV…` is the only thing that can authorise the upgrade. It is
not recoverable from the chain, and it is not present in this environment.

## 3. What was searched (and what was found)

Every location that could hold a NEAR private key was checked. Nothing was found, and no secret
material was printed or copied during the search.

| Location | Result |
| --- | --- |
| `keys/` (the project's gitignored identity store, `driver/near.js` `KEYS_FILE`) | directory exists, **empty**; never committed (`.gitignore` line 2 is `keys/`) |
| `~/.near-credentials/` | absent |
| `~/.near/` | absent |
| `~/.openhands/profiles/`, `~/.openhands/provider-connections/` | empty |
| Filesystem sweep for `"private_key"` | only the `near-crypto` crate's own source |
| GitHub Actions secrets / variables | `403` (not readable from here) |
| Tracked repository files | no `ed25519:` secret; the only hits are documentation and CI patterns (see §7) |

**Conclusion: the legacy contract's FullAccess private key is not available in this environment.**
This is a **BLOCKED BY HUMAN ACTION** item: only the operator who holds that key can upgrade the
live address. Nothing in this environment signed anything for the legacy account.

## 4. Why the keys are unrecoverable

The three legacy accounts were created from the free testnet faucet and their keys were generated
**locally only** — they were never exported, and `keys/` was never committed:

- `attestor-overcover.testnet` created at block 277197243 by signer `testnet`
  (tx `5zUMXnnzeXR7bmSweZA6zj5kso6BoctNF92LUADzRgqT`, `CREATE_ACCOUNT`/`TRANSFER`/`ADD_KEY`);
- `contract.attestor-overcover.testnet` created by signer `attestor-overcover.testnet`
  (tx `A8g8H29W5NctyjSwdMXk7FUn7ibXEd5gYppCGiF7Awbp`, `CREATE_ACCOUNT`/`TRANSFER`/`ADD_KEY`), later
  configured by `owner.attestor-overcover.testnet`
  (tx `4EtUSwCMhSmjNEzS4ds2gshp2tqdZXXBZfDVEvhW21fp`).

The `ADD_KEY` actions registered the public keys; the private halves lived only on the operator's
machine. There is no on-chain route to recover them.

## 5. The controlled v3 deployment (the path that works)

Because the legacy address cannot be upgraded from here, the decentralised **v3** design is deployed
to a **fresh, independent** account whose keys we generate and hold. This does not touch the legacy
contract's address, capital or policies, and it does not require the legacy key.

`proof/controlled-v3-deploy.mjs` performs that deployment and then proves the security properties
against the **real compiled module**:

```bash
node proof/controlled-v3-deploy.mjs --plan     # prints the plan; sends nothing
node proof/controlled-v3-deploy.mjs --sandbox  # the whole proof on a local neard (no funds, no network)
node proof/controlled-v3-deploy.mjs            # deploys + verifies on real NEAR testnet
```

The harness **fails closed** if the wasm lacks the SEC-1 guard, so a stale artifact can never ship
the takeover. It creates one faucet-funded root, funds the sub-accounts from it, deploys the
compiled v3 wasm, configures a **3-of-5** operator quorum and a **3-of-5** resolver quorum, and then
asserts (against the deployed module, not the source):

1. five operators and five resolvers are registered, distinct, and none is the owner;
2. a **2-of-5 sub-quorum does not finalise** an observation (the threshold is enforced);
3. a **forged operator signature is refused**;
4. a **non-operator cannot report**;
5. the **owner cannot vote** on a dispute (no unilateral adjudication);
6. an operator that **signed the reading cannot resolve** its own dispute;
7. the **challenger cannot resolve** their own dispute;
8. a real challenge is decided by a **3-of-5 independent resolver quorum**;
9. a **third-party `migrate()` is refused** — SEC-1 closed on the new module — and the owner is
   unchanged afterwards;
10. the pool reserves capital per policy, settles it correctly, and stays solvent.

**Sandbox evidence (executed this mission).** `npm run verify:controlled-v3:sandbox` →
**29/29 checks passed**, `mode: SANDBOX`. Full record, with every check and transaction id:
`proof/controlled-v3-sandbox.json`.

**Testnet evidence (the remaining step).** The testnet run creates a real account and spends real
faucet funds, so it is run only when the faucet is available. It writes
`proof/controlled-v3-deploy.json` and the generated keys to the gitignored
`keys/controlled-v3.json` (mode `0600`). If the faucet is rate-limited the script **SKIPs cleanly**
(exit 0) rather than failing; set `REQUIRE_TESTNET=1` to make it fail loudly instead.

### Why the testnet run was not completed this session

The NEAR testnet faucet (`helper.testnet.near.org`) returned **HTTP 429** on every probe throughout
the session (the alternative faucets — `near-faucet.io`, `faucet.testnet.near.org` — returned 404
and a connection failure respectively). Without the faucet there is no free funded account to create
the fresh identity graph from, and the only funded accounts are the legacy ones whose keys are
unrecoverable (§3). The sandbox run exercises the identical harness against the identical compiled
wasm, so the only untested part of the testnet path is the account creation itself.

## 6. The operator's one step to close SEC-1 on the live address

If the operator holds `ed25519:CwZBmKyV…`, the non-destructive in-place upgrade closes SEC-1 on the
existing address without touching the pool or policies:

```bash
npm run verify:sandbox              # 21/21 (compiled wasm on a real neard)
npm run verify:upgrade-preservation # state preserved + the migrated policy still settles
node driver/upgrade.js --plan       # prints the exact operations + costs; sends nothing
node driver/upgrade.js              # DeployContract + self-call migrate + reconfigure
```

See `docs/DEPLOY_RUNBOOK.md` §3a. The upgrade is state-preserving (proven against the exact live v1
bytecode). If the operator does **not** hold that key, the controlled v3 deployment in §5 is the
supported path to a live, decentralised, SEC-1-closed contract.

## 7. Secret hygiene (why this document is safe to publish)

No secret material is in this document or the repository. The CI workflow fails the build if a
tracked file matches `ed25519:[0-9A-Za-z]{40,}` or `BEGIN … PRIVATE KEY`
(`.github/workflows/ci.yml`). The only `ed25519:` strings in the tree are documentation placeholders
(`ed25519:...`) and that CI pattern. Generated testnet keys are written only to the gitignored
`keys/` directory with mode `0600` and are never printed.
