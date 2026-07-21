# Integrate with OpenRails

> **⚠️ Archived — describes the frozen V1 Hub and the legacy Express server (`server/index.ts`),
> both superseded by V2. Start at [`GETTING_STARTED.md`](../GETTING_STARTED.md) instead — it covers
> the current cockpit / SDK / CLI / MCP paths against the live V2 Hub
> (`0x941C8029F0f912df3fAb7423890ab2359b996D0b`). This file is kept for historical reference only
> and is not maintained.**

OpenRails is intent-driven clearing & settlement for **streamed work on Arc** — a USDC payment
rail for humans or agents: sign an intent → clear into a bounded onchain Vault → settle as work
is performed → recover residual. Three ways to integrate: the **SDK/CLI**, the **agent skill**,
and the **HTTP endpoints**. (Arc testnet: chain `5042002`, Hub `0x01EC54846524D043fD808152D41596beF603381d`,
USDC `0x3600000000000000000000000000000000000000`.)

Vocabulary: **Paycard Stream** (onchain Vault row), **RailsFlow** (request link), **RailsCard**
(claimable value link), **Nonce Lane** (replay/concurrency), **Receipts** (proof artifacts).

---

## 1. SDK / CLI (`openrails`)

```bash
npm run build:sdk           # builds sdk/dist (incl. the `openrails` bin)
node sdk/dist/cli.js --help
```
Commands (asset-affecting ones are **dry-run by default**; add `--execute`):
- `request-stream` — build an unsigned RailsFlow request link.
- `pay-stream` — sign / open a Paycard Stream (`--sign-only` to get a signed envelope/link).
- `stream-status` — read a stream's registry row.
- `recover` — scan `PaycardProvisioned` logs for a payer/recipient.
- `settle` — `processDripSettle` (`--execute`).
- `close` — `flushResidualDelta` (`--execute --ack-irrevocable-close`).

**Keys via env only** (`OPENRAILS_PAYER_PRIVATE_KEY` or `--signer-env <NAME>`); never on argv.
Programmatic: `LeptonOpenRailsClient` (`sdk/src/client.ts`) + `sdk/src/wallet.ts`
(`submitOpenPaycardWithSigner`, `submitSettleWithSigner`, `submitFlushWithSigner`,
`approveOpenRailsSpend`, `readNonce`, …) + `sdk/src/metadata.ts`
(`hashOpenRailsMetadata`, `buildMetadataBoundPaycardId`). See `experiments/x402-smoke/x402-to-stream.ts`
and `experiments/traction-bots/run-bots.ts` for end-to-end examples.

> Browser/agents without the SDK can mirror the EIP-712 in-app — see `cockpit/src/lib/intents.ts`
> (types, domain, `hashOpenRailsMetadata`) and self-submit `openPaycardChannel` /
> `claimWildcardPaycardChannel` via the Hub ABI (`cockpit/src/lib/contracts.ts`).

---

## 2. Agent skill / plugin

- `skills/openrails/SKILL.md` — the OpenRails skill (safety rules: dry-run first, env-only keys,
  V1 only).
- `commands/openrails-*.md` — per-command references.
- `.factory-plugin/plugin.json` — plugin manifest (`name: openrails`).

An agent installs the skill + the `openrails` bin and drives the same 6 commands. The skill
enforces: never echo keys, mutating commands need `--execute`, `close` needs
`--ack-irrevocable-close`.

---

## 3. HTTP endpoints (gateway)

`npm run server` (Arc mode: `OPENRAILS_DASHBOARD_MODE=arc-testnet`). CORS `*`. **Indexer reads
are non-authoritative** (`authoritative: false`); the Vault is the source of truth.

**Reads**
- `GET /api/config` — chain, hub, usdc, explorer, relayer mode.
- `GET /api/paycard/:id` — **authoritative** onchain registry row.
- `GET /api/streams[?payer=&recipient=&workflowId=&metadataHash=&status=]` — indexed list.
- `GET /api/streams/:paycardId/history` — indexed event timeline.
- `GET /api/transactions/:hash` — events + streams for a tx.
- `GET /api/workflows/:id` — streams + events for a workflow.
- `GET /api/paycards/recover?payer=&recipient=&limit=` — log-scan recovery (bounded window).
- `GET /api/balance/:address`, `GET /api/allowance/:owner`, `GET /api/nonce/:payer/:channel`.

**Writes** (the connected wallet can also **self-submit** these to the Hub directly, no relayer)
- `POST /api/paycard/open` — relayer submits a signed envelope (gated by relayer capability).
- `POST /api/paycard/drip` — `processDripSettle`. `POST /api/paycard/flush` — `flushResidualDelta`.

**x402**
- `GET /api/x402/openrails-artifact` — Circle x402-gated; returns an OpenRails metadata artifact
  with `vaultEscrowClaimed: false` (payment proof is separate from Vault escrow). Pair with the
  bridge (`experiments/x402-smoke/x402-to-stream.ts`) to turn a paid request into a real stream.

---

## Notes
- **Non-custodial:** escrow is pulled from the intent signer's own balance; opens can self-submit
  (`cockpit/` does this), so no relayer/backend is required.
- **Roadmap is live:** this integration surface is V1; the 8-phase roadmap continues toward
  V2 multi-vault (workflow NFTs, dynamic payout) and production hardening — traction work runs in
  parallel, not instead of it.
