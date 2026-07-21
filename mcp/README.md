# openrails-mcp

MCP server that lets an agent transact on the OpenRails USDC rail (Arc) over stdio. Opens and
claims are **gasless by default** - routed through the keeper relay - and the server is
**non-custodial**: it signs with its own configured account and never holds anyone else's keys.

## Tools

| Tool | Purpose |
|---|---|
| `openrails_config` | Network config, the server signer address, and its USDC balance. Read-only. |
| `pay_link` | Pay an OpenRails link - a RailsFlow request (the signer becomes the payer, gasless open) or a RailsCard (claimed to the signer). Returns the tx hash. |
| `create_request_link` | Create a RailsFlow request link to **receive** payment. Defaults to one-time. Streaming requires positive velocity and lifespan. No signing/tx. |
| `issue_railscard` | Issue a claimable RailsCard link (the server pre-signs as payer). Returns a claim link + paycardId. |
| `paycard_status` | Read a paycard/stream state from chain by id. |

## Write-tool guardrails

`pay_link` (RailsFlow-open branch only - claiming a RailsCard spends the *original payer's*
pre-authorized funds, not the caller's) and `issue_railscard` commit the server signer's own funds
or a standing pull-authorization, so both are guarded:

- **Spend ceiling.** Every amount is checked against `MCP_MAX_AMOUNT_USDC` (default `5` USDC)
  *before* any signing happens. Exceeding it fails fast with no wallet interaction.
- **Idempotent retries.** An identical tool call (same tool, same arguments) within 5 minutes
  replays the cached result instead of signing a second, independent authorization - safe for an
  agent to retry blindly after a timeout or dropped connection.
- **Bearer-mode acknowledgment.** `issue_railscard`'s default `mode: "bearer"` creates a standing,
  anyone-with-the-link pull-authorization (first claimant wins, no recipient check). It requires an
  explicit `acknowledgeBearerRisk: true` argument; omit bearer entirely and use
  `mode: "recipient_bound"` when the claimant is known.

The smoke test covers the negative paths for over-cap amounts, missing bearer acknowledgment, and
missing streaming terms:

```bash
npm run build && node smoke.mjs
```

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `OPENRAILS_MCP_SIGNER_KEY` | - | Dev signer (raw key). Omit for read-only. For prod, wire a Turnkey/Privy account via `openrails-sdk/adapters` (see below). |
| `OPENRAILS_RPC_URL` | `https://rpc.testnet.arc.network` | Public Arc RPC. |
| `OPENRAILS_CHAIN_ID` | `5042002` | |
| `OPENRAILS_HUB_ADDRESS` | `0x941C...6D0b` | ArcOpenRailsHubV2Initializable (canonical). |
| `OPENRAILS_USDC_ADDRESS` | `0x3600...0000` | |
| `OPENRAILS_RELAY_URL` | deployed keeper | Sponsors gas for opens/claims. |
| `OPENRAILS_APP_BASE_URL` | `https://openrails.pages.dev` | Base for generated links. |
| `OPENRAILS_EXPLORER_BASE_URL` | `https://testnet.arcscan.app` | |
| `MCP_MAX_AMOUNT_USDC` | `5` | Per-call spend ceiling for `pay_link` (RailsFlow-open) and `issue_railscard`. |

## Run

```bash
npm install && npm run build
OPENRAILS_MCP_SIGNER_KEY=0x... node dist/index.js   # stdio server
```

Register with an MCP client (e.g. Claude Desktop `mcpServers`):

```json
{
  "openrails": {
    "command": "npx",
    "args": ["openrails-mcp"],
    "env": { "OPENRAILS_MCP_SIGNER_KEY": "0x..." }
  }
}
```

Smoke test: `OPENRAILS_MCP_SIGNER_KEY=0x... node smoke.mjs [paycardId]`.

## Signer is pluggable

The server builds its signer via the SDK account abstraction (`openrails-sdk`). Dev uses a raw key
(`ethersToSubmitter`); for production swap in `turnkeyToAccount` (server wallets / agents) or
`privyToAccount` (humans) from `openrails-sdk/adapters/*` in `src/context.ts`. Because the OpenRails
Hub authenticates the signature (not `msg.sender`), any EOA-backed account works with no contract
change.
