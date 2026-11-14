# Overcover — company film (demo write-up)

Text to attach alongside the demo video and to post publicly. Every number and hash below is real
and reproducible; nothing is invented.

---

## Download

| Asset | Link | Size |
| --- | --- | --- |
| **Film (web, recommended)** | https://github.com/itzebe/overcover/raw/feat/overcover-company-film/video/company/out/overcover-company-film-web.mp4 | 26.5 MB |
| Poster frame | https://github.com/itzebe/overcover/raw/feat/overcover-company-film/video/company/out/poster.png | 158 KB |
| Film (master, 1920×1080) | *not committed* (62 MB, regenerable — see `reports/VIDEO_QA_REPORT.md` for its SHA-256) | 61.7 MB |

> The links above point at the `feat/overcover-company-film` branch. Once that branch is merged to
> `main`, the same paths work on `main`:
> `https://github.com/itzebe/overcover/raw/main/video/company/out/overcover-company-film-web.mp4`.

**Specs:** 1920×1080 · 16:9 · 30 fps · H.264 / stereo AAC 48 kHz · **3 min 09 s** · web build 1,125 kbps.
SHA-256 — web `41607d5c2dae9c747018a891e43389a287cc7850aaee84b8325ee053484c692e`; master
`5f6e57588a77c4f8b1aef5564b4784d90e4b889590fdbefc9abcc68cd8ca2d0d`.

---

## The post

**Overcover — capital-backed parametric insurance infrastructure, built on NEAR.**

This is our company film: three minutes on what Overcover is, how a policy's life runs on-chain, and
how the security model actually works. Every frame of product footage is the **live console**, and
every figure is read from the deployed contract — nothing is staged.

Then, at the centre of the film, the part we care about most: **the customer journey, exercised.**

A buyer discovers the catalogue, the contract quotes the price (5 % of payout, fixed in code), one
`buy_cover` is signed, and a policy is issued with its payout reserved from the pool *before* it is
sold. The film shows that path on the live site — discover → select → quote → buy surface → policy
register — and then the **real on-chain purchase that proves it works**:

- Contract: `contract.ovc-v3-ctl-2f6c4c.testnet` (NEAR testnet)
- Transaction: [`45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn`](https://explorer.testnet.near.org/transactions/45A1s3hz16hXLGdf9YNgfuZf46QrxvN1yhNgFZ8sznyn)
- Result: policy **#3**, `heat-lagos`, status **active**, payout reserved from the pool

The live pool (read straight from the contract): capital **1.4250 NEAR**, reserved **0.2000 NEAR**,
available **1.2250 NEAR**, **solvent**, not paused.

**One honest caveat, on the card and here.** That purchase was **signed by the project's agent**, not
a person at a keyboard. We checked the chain and we are not going to pretend otherwise: **no
human-wallet purchase has been recorded on the hardened contract — or on the legacy one.** Every
recorded `buy_cover` was signed programmatically. The one transaction that was previously described
as "human" was signed by an automated sub-account of our own agent, on the legacy contract.

So the film shows exactly what is true: the journey is live and the purchase path works end to end,
and **the human-wallet signature is the one acceptance step still outstanding.** The console is ready
for it — it is a ten-minute job with a funded testnet wallet, and we would rather say that plainly
than dress up an automated call as a person.

**Verify it yourself** (no wallet needed):

```bash
git clone https://github.com/itzebe/overcover && cd overcover
npm ci --ignore-scripts
npm run verify:proof     # checks the deployed code, solvency, and all recorded testnet txs

curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"contract.ovc-v3-ctl-2f6c4c.testnet","method_name":"get_pool","args_base64":"e30="}}'
```

Console: <https://overcover.vercel.app/>

**What Overcover is.** Programmable parametric insurance for autonomous businesses: a capital-backed
risk mutual that writes fully-collateralised cover against objective public indices and settles it
autonomously — signed external observations, a multi-operator oracle quorum, bonded disputes with
independent resolution, and deterministic settlement, all enforced by one Rust contract on NEAR. A
console, an autonomous agent, and a permissionless product factory all read and write the same
contract through the same rules.

**The state, stated honestly.** This is **testnet**, **unaudited**, and built to be verified — not
trusted. The TEE/attestation layer is a tested **prototype**, not deployed. We make no claim of
endorsement, funding, partnership, users, revenue or capital under management. Where the film shows a
wallet approval surface, it is the approval surface — not a completed signature.

*Built for the NEAR Hackathon 2026 — Business · Swarms · DeFi.*

---

## Hashtags / boilerplate

`#NEAR` `#DeFi` `#parametricInsurance` `#Rust` `#smartcontracts`

**Repo:** https://github.com/itzebe/overcover · **Console:** https://overcover.vercel.app/
