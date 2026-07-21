# OpenRails API Reference

Every HTTP route across the repo in one place: the legacy Express server and all 5 Cloudflare
Workers. Cross-checked directly against a `grep` of every `app.get`/`app.post`/Worker
`url.pathname ===` route definition (see the verification note at the bottom); if this doc and the
code ever disagree, the code wins - please file that as a bug.

**The on-chain Vault is always the authoritative source of truth.** Every read below that is
served from an off-chain index/projection is marked `authoritative: false` in its own response
and called out here too.

---

## 1. Legacy Express server (`server/index.ts`)

> **Superseded.** This server targets the frozen **V1 Hub** only (`ArcOpenRailsHubV1`) and is kept
> for the local Hardhat sandbox demo. New integrations should use the SDK/CLI/MCP + keeper worker
> path against the V2 Hub - see [`GETTING_STARTED.md`](../GETTING_STARTED.md). Local sandbox mode
> also exposes non-custodial demo conveniences (mint, time-travel) that only exist for the Hardhat
> node, never on Arc testnet/mainnet.

Run with `npm run server` (`OPENRAILS_DASHBOARD_MODE=local` or `arc-testnet`). CORS is open (`*`).

| Method & Path | Purpose | Auth |
|---|---|---|
| `GET /api/config` | Chain id, hub/USDC addresses, explorer URL, current relayer capability flags. | none |
| `GET /api/paycard/:id` | **Authoritative** on-chain registry row for a paycard. | none |
| `GET /api/streams` | Indexed stream list (filter by `payer`, `recipient`, `workflowId`, `metadataHash`, `status`). | none |
| `GET /api/streams/:paycardId/history` | Indexed event timeline for one paycard. | none |
| `GET /api/workflows/:id` | Streams + events grouped by workflow id. | none |
| `GET /api/transactions/:hash` | Events + streams touched by a tx hash. | none |
| `GET /api/balance/:address` | USDC `balanceOf`. | none |
| `GET /api/allowance/:owner` | USDC `allowance(owner, hub)`. | none |
| `GET /api/nonce/:payer/:channel` | On-chain nonce-lane value. | none |
| `GET /api/paycards/recover?payer=&recipient=&metadataHash=&fromBlock=&toBlock=&limit=` | Bounded `PaycardProvisioned` log scan (≤250k block span, ≤50 results). Rate-limited. | none |
| `POST /api/paycard/open` | Local relayer submits a signed envelope (`openPaycardChannel` / `claimWildcardPaycardChannel`). Body or `Authorization: OpenRails <token>` header. Nonce-retry on mempool rejection. | **Pattern 1 (capability flag)** - gated by `canRelayOpen` - **+ Pattern 2 (EIP-712 envelope signature)**, verified server-side before submission. Rate-limited. |
| `POST /api/paycard/drip` | `processDripSettle` for a paycard. | Pattern 1 (`canGatewaySettle`). Rate-limited. |
| `POST /api/paycard/flush` | `flushResidualDelta` for a paycard, local-sandbox only. | Pattern 1 (`canDemoFlush`) **+ Pattern 5 (`ethers.verifyMessage`)** - caller signs a fixed message off-chain; recovered signer must be the paycard's payer or recipient. Rate-limited. |
| `POST /api/usdc/mint` | Mint demo USDC (local sandbox only). | Pattern 1 (`canMint`). Rate-limited. |
| `POST /api/blockchain/increase-time` | Advance the local Hardhat clock (demo "time travel"). | Pattern 1 (`canTimeTravel`). Rate-limited. |
| `GET /api/demo/protected-resource` | Local-sandbox-only demo route gated by a custom access credential. | **Pattern 3 (custom "OpenRails" bearer credential)** - `Authorization: OpenRails <credential>` plus `X-OpenRails-Credential-Type` / `X-OpenRails-Paycard-Id` / `X-OpenRails-Metadata-Hash` / `X-OpenRails-Mode` headers, validated against chain id, vault, scope, and the paycard's real payer/recipient. |
| `GET /api/x402/openrails-artifact` | Circle x402-gated OpenRails metadata artifact (HTTP payment proof; does **not** claim Vault escrow itself - pair with a bridge script to turn it into a real stream). | **Pattern 4 (Circle x402 middleware)**, requires `OPENRAILS_DASHBOARD_MODE=arc-testnet` and the real Arc chain id. |

**Five auth patterns, by design non-unified in this pass** (a full merge is a breaking change for
existing integrators - tracked, not attempted here): (1) no-auth + capability flags keyed off
`OPENRAILS_DASHBOARD_MODE`/env toggles, (2) EIP-712 envelope-signature verification, (3) a
one-off `Authorization: OpenRails <credential>` scheme with custom `X-OpenRails-*` headers, (4)
Circle x402 middleware, (5) ad-hoc `ethers.verifyMessage` against a fixed message string. Routes
above cite which pattern(s) gate them.

---

## 2. Music Scrobble Webhook Worker (`workers/music-scrobble-worker/`)

CORS open. Auth: shared `authorized()` helper (see §5) - `Authorization: Bearer <WEBHOOK_SECRET>`
or `X-OpenRails-Webhook-Secret: <WEBHOOK_SECRET>`.

| Method & Path | Purpose | Auth |
|---|---|---|
| `PUT /artist/:mbid` | Register an artist MusicBrainz ID → wallet address in KV. | `WEBHOOK_SECRET` |
| `POST /session/open` | Open a listening-session Paycard Stream for a registered artist. | `WEBHOOK_SECRET` |
| `POST /webhook/scrobble` | Log a scrobble play event (pending royalty) to D1. | `WEBHOOK_SECRET` |

---

## 3. Reconciliation (Keeper) Worker (`workers/reconciliation-worker/`)

CORS open. Cron: `* * * * *` (every minute - Cloudflare's floor). See
[`workers/README.md`](../workers/README.md) for the full settlement-model writeup.

| Method & Path | Purpose | Auth |
|---|---|---|
| `POST /relay-claim` | Public gasless RailsCard claim relay - decodes a signed envelope, `staticCall` prechecks (409 on a would-revert retry, not a silent double-process), submits on the caller's behalf. | none (safety is the envelope's own signature) - toggle `RELAY_CLAIMS_ENABLED` |
| `POST /relay-open` | Public gasless RailsFlow/stream-open relay (optional bundled EIP-2612 permit). | none - same toggle |
| `POST /reconcile` | Manually trigger the drip-settle sweep (the cron does this automatically otherwise). | `RECONCILIATION_ADMIN_TOKEN` via shared `authorized()` |

---

## 4. Indexer Worker (`workers/indexer-worker/`)

CORS open, GET-only except `/tick`. Cron: every 5 minutes. Every read response includes
`authoritative: false` - the Vault is always the source of truth. Does not index V1 or attempt
reorg rollback (last-write-wins/append-only, same as `stream-gateway` - see
[`docs/stream_indexing.md`](stream_indexing.md)).

| Method & Path | Purpose | Auth |
|---|---|---|
| `GET /vaults` | List watched vaults (canonical V2 hub + every discovered factory clone). | none |
| `GET /streams` | Indexed stream list (filterable). | none |
| `GET /streams/:vaultAddress/:paycardId/history` | Indexed event timeline for one paycard on one vault. | none |
| `GET /workflows/:id` | **Not implemented - returns a `501`-style "not supported" response today.** Documented here rather than silently omitted; do not build against it yet. | none |
| `GET /transactions/:hash` | Events + streams touched by a tx hash. | none |
| `POST /tick` | Manually trigger a backfill/ingestion tick. | `INDEXER_ADMIN_TOKEN` via shared `authorized()` |

---

## 5. Faucet Worker (`workers/faucet-worker/`)

CORS open. Self-serve, capped testnet USDC drip (also Arc's native gas token).

| Method & Path | Purpose | Auth |
|---|---|---|
| `POST /fund` | Drip `FAUCET_DRIP_AMOUNT_USDC` (default 0.05) to `{ "address": "0x…" }` if under `FAUCET_MAX_BALANCE_USDC`. Per-address + per-IP cooldown, daily global cap. | none |
| `GET /status` | Faucet wallet balance + today's drip count. | `FAUCET_ADMIN_TOKEN` via shared `authorized()` |

### Shared `authorized()` helper

`music-scrobble-worker`, `reconciliation-worker`, `indexer-worker`, and `faucet-worker` all import
one implementation from [`workers/shared/auth.ts`](../workers/shared/auth.ts) (previously four
independent copies - a fix to one had no way to reach the others). It's a plain relative-file
import, not an npm workspace package - each worker is bundled independently by
wrangler/esbuild from its own `src/index.ts`, and esbuild resolves relative filesystem imports
outside a worker's own directory without any special linking. Accepts either
`Authorization: Bearer <secret>` or a worker-specific fallback header (preserved per-worker rather
than unified, to avoid a breaking header rename for existing integrators).

---

## 6. x402 Gateway Worker (`workers/x402-gateway-worker/`)

CORS open. This worker exposes a Circle x402-gated OpenRails artifact endpoint. It is separate from
the legacy Express `GET /api/x402/openrails-artifact` route.

| Method & Path | Purpose | Auth |
|---|---|---|
| `GET /` | Health/config check. | none |
| `GET /health` | Health/config check. | none |
| `GET /api/x402/openrails-artifact` | Circle x402-gated OpenRails metadata artifact. | Circle x402 payment middleware |

---

## 7. MCP server (`mcp/`)

Not HTTP - stdio, per the [Model Context Protocol](https://modelcontextprotocol.io). See
[`mcp/README.md`](../mcp/README.md) for the tool table and write-tool guardrails
(`MCP_MAX_AMOUNT_USDC` cap, idempotent retries, bearer-mode acknowledgment).

---

## Verification

This table was built by reading every `app.get(`/`app.post(` in `server/index.ts` and every
`url.pathname ===` / `request.method` dispatch in the 5 workers' `src/index.ts` files directly,
not from an existing summary. To re-verify after a change:

```bash
grep -n 'app\.\(get\|post\|put\|delete\)' server/index.ts
grep -n 'url.pathname ===' workers/*/src/index.ts
```

Any route that shows up in either command but not in this doc (or vice versa) means this doc has
drifted - fix it in the same PR that changed the routes.
