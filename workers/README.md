# OpenRails Cloudflare Workers Sidecar Setup

This directory contains the serverless event-driven implementation of OpenRails sidecars: the
**Music Scrobble Webhook Worker**, the **Reconciliation Cron Worker**, the **Indexer Worker**, and
the **Faucet Worker**.

---

## 1. Prerequisites

* Cloudflare account and authenticated Wrangler CLI:
  ```bash
  npx wrangler login
  ```

---

## 2. Database & KV Setup

### A. Initialize the Key-Value (KV) Store
This store maps MusicBrainz Artist IDs (MBIDs) to artist EVM wallet addresses.
1. Create the KV namespace:
   ```bash
   npx wrangler kv:namespace create MUSICBRAINZ_REGISTRY
   ```
2. Wrangler will output a binding segment with IDs. Copy these into `workers/music-scrobble-worker/wrangler.toml` under `[[kv_namespaces]]`.

### B. Initialize the D1 SQL Database
This database acts as the off-chain cache database tracking pending play events and royalty balances.
1. Create the D1 database:
   ```bash
   npx wrangler d1 create openrails_stream_db
   ```
2. Copy the returned `database_id` UUID into BOTH `wrangler.toml` files:
   * `workers/music-scrobble-worker/wrangler.toml`
   * `workers/reconciliation-worker/wrangler.toml`
3. Execute the database schema initialization:
   * **For Local Sandbox Dev:**
     ```bash
     npx wrangler d1 execute openrails_stream_db --local --file=schema.sql
     ```
   * **For Production Edge Deploy:**
     ```bash
     npx wrangler d1 execute openrails_stream_db --remote --file=schema.sql
     ```

---

## 3. Deploying the Workers

### A. Deploy Music Scrobble Webhook Worker
1. Navigate to the scrobble worker folder and run deploy:
   ```bash
   cd music-scrobble-worker
   npm install
   npx wrangler deploy
   ```
2. Your worker endpoint will be live at `https://openrails-music-scrobble-worker.<subdomain>.workers.dev/webhook/scrobble`. You can point your Subsonic/Navidrome server webhook settings here.

### B. Deploy the Settler Cron Worker (reconciliation-worker)

A cron keeper that periodically **drip-settles active Paycard Streams** so recipients get paid
without anyone clicking "settle". It **only settles** (`processDripSettle`) — it never opens or
closes a rail; opening and closure (residual flush) stay with the payer/merchant/creator. Settling
is permissionless and non-custodial: funds always flow payer → recipient per on-chain state; the
keeper only pays gas.

- **`SETTLER_MODE = "chain"` (default):** enumerates active streams from chain
  (`PaycardProvisioned` logs → `registry`) — **no D1 required**. Streaming rails settle repeatedly
  once accrued value clears `MIN_ACCRUED_USDC`; one-time (`lifespanSeconds == 0`) rails settle once.
- **`SETTLER_MODE = "d1"`:** legacy — settle only paycards referenced by the music `plays` table
  (needs the D1 setup in §2.B; uncomment `[[d1_databases]]` in the worker `wrangler.toml`).

1. Fund a keeper wallet with Arc testnet gas, then set its key as a secret (never in the repo):
   ```bash
   cd ../reconciliation-worker
   npm install
   npx wrangler secret put RECONCILIATION_SIGNER_KEY
   # paste the funded keeper private key when prompted
   ```
2. (Optional) validate the bundle, then deploy:
   ```bash
   npx wrangler deploy --dry-run   # bundle check, no deploy
   npx wrangler deploy
   ```
3. Runs every minute (`crons = ["* * * * *"]` — Cloudflare Cron Triggers can't go below 1-minute
   granularity, this is the fastest native schedule available); tune interval, `MIN_ACCRUED_USDC`,
   `RECONCILIATION_BATCH_LIMIT`, and `SETTLER_WINDOW_BLOCKS` in `wrangler.toml`. Trigger manually
   with an authenticated `POST /reconcile` when `RECONCILIATION_ADMIN_TOKEN` is set.

**This worker also exposes two public, unauthenticated gasless-relay endpoints** (safety comes
from the envelope's own cryptographic signature, not caller identity — same non-custodial model as
everything else in this project):

- **`POST /relay-claim`** — sponsors gas for a RailsCard claim. Body: `{ envelopeToken, claimRecipient? }`.
  Decodes the signed envelope, does a `staticCall` precheck (returns `409` if the claim would
  revert — e.g. already claimed — rather than burning gas or silently double-processing), then
  submits `claimWildcardPaycardChannel`/`openPaycardChannel` on the caller's behalf. This is what
  the SDK's `claimGasless()` (`sdk/src/relay.ts`) calls under the hood. Toggle:
  `RELAY_CLAIMS_ENABLED` (default `true`).
- **`POST /relay-open`** — sponsors gas for a RailsFlow/stream open. Body:
  `{ envelopeToken, permit? }` (an optional EIP-2612 permit lands the approval gaslessly too).
  Same `staticCall`-precheck-then-submit pattern; requires a fixed recipient (rejects wildcard).
  What the SDK's `payGasless()` calls under the hood. Same `RELAY_CLAIMS_ENABLED` toggle.

### C. Deploy the Indexer Worker (`indexer-worker`)

A factory-aware, durable read API: watches the V2 canonical hub plus every vault clone discovered
via `ArcOpenRailsFactoryV1`'s `CorporateVaultDeployed` event, ingests `PaycardProvisioned` /
`SettlementFlushed` / `ResidualDeltaReclaimed` into its own dedicated D1 database, and exposes a
public, CORS-enabled, GET-only read API (`/vaults`, `/streams`, `/streams/:vaultAddress/:paycardId
/history`, `/workflows/:id`, `/transactions/:hash`) so a static-hosted frontend (e.g. the cockpit on
Cloudflare Pages) can reach indexer-backed reads without needing any backend of its own. Every
response is explicitly `authoritative: false` — the onchain Vault is always the source of truth.

This worker uses its **own** D1 database (`openrails_indexer_db`) rather than the music sidecar's
`openrails_stream_db`, since nothing in this repo has actually provisioned that database yet
(both existing workers still ship with a placeholder `database_id`).

1. Create and seed the dedicated D1 database:
   ```bash
   cd indexer-worker
   npm install
   npx wrangler d1 create openrails_indexer_db
   # copy the returned database_id into indexer-worker/wrangler.toml
   npx wrangler d1 execute openrails_indexer_db --local --file=schema.sql
   npx wrangler d1 execute openrails_indexer_db --remote --file=schema.sql
   ```
2. (Optional) set an admin token to allow manually triggering a backfill tick without waiting for
   the cron:
   ```bash
   npx wrangler secret put INDEXER_ADMIN_TOKEN
   ```
3. Validate and deploy:
   ```bash
   npx wrangler deploy --dry-run
   npx wrangler deploy
   ```
4. Runs every 5 minutes (`crons = ["*/5 * * * *"]`); tune `SCAN_WINDOW_BLOCKS`,
   `MAX_CHUNKS_PER_TICK`, and `INITIAL_BACKFILL_BLOCKS` in `wrangler.toml`. Trigger manually with an
   authenticated `POST /tick` when `INDEXER_ADMIN_TOKEN` is set. Does not index V1 (`0x01EC…`,
   frozen/draining) or attempt reorg rollback — same last-write-wins/append-only policy as
   `stream-gateway` (see `docs/stream_indexing.md`).

### D. Deploy the Faucet Worker (`faucet-worker`)

A capped, self-serve testnet USDC drip for brand-new wallets — on Arc, USDC is also the native
gas token, so one drip covers both. Funded from its **own dedicated keeper wallet**, never the
deployer/governance wallet. Abuse-resistant by design: skips wallets that already hold enough,
cools down per-address *and* per-IP, and caps total drips per day on top of the wallet's own
limited balance.

1. Create the dedicated KV namespace (tracks cooldowns + the daily counter):
   ```bash
   cd faucet-worker
   npm install
   npx wrangler kv namespace create FAUCET_CLAIMS
   # copy the returned id into faucet-worker/wrangler.toml under [[kv_namespaces]]
   ```
2. Generate a dedicated faucet wallet (never reuses the deployer/settler keys) and fund it with a
   small amount of Arc testnet USDC via the Circle faucet UI (`https://faucet.circle.com`):
   ```bash
   npm run faucet:wallet   # prints the address only; key stays in gitignored .bot-wallets/faucet.json
   ```
3. Set secrets, then validate and deploy:
   ```bash
   npx wrangler secret put FAUCET_SIGNER_KEY    # paste the generated private key
   npx wrangler secret put FAUCET_ADMIN_TOKEN   # guards GET /status
   npx wrangler deploy --dry-run
   npx wrangler deploy
   ```
4. `POST /fund` (public, CORS-enabled, body `{"address": "0x…"}`) sends `FAUCET_DRIP_AMOUNT_USDC`
   (default 0.05) if the recipient holds less than `FAUCET_MAX_BALANCE_USDC` (default 0.10),
   subject to a `FAUCET_COOLDOWN_SECONDS` (default 1 day) cooldown per address and per requesting
   IP, and a `FAUCET_MAX_DRIPS_PER_DAY` (default 500) global cap. `FAUCET_ENABLED = "false"` is an
   instant kill switch. `GET /status` (admin-token gated) reports the faucet wallet's balance and
   today's drip count, so you know when it needs a top-up.
