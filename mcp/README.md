# OpenRails GIWA MCP

A read-and-prepare Model Context Protocol server for the canonical OpenRails deployment on GIWA Sepolia.

The default server is intentionally non-custodial and non-executing. It accepts no private keys, signs no intents, submits no transactions, and never takes custody of payer funds. It prepares deterministic payment data for an external wallet to review and authorize.

## Tools

| Tool | Purpose |
|---|---|
| `openrails_network_info` | Canonical GIWA chain, deployment, RPC, explorer, token, and safety information. |
| `openrails_get_balance` | Read an address's test-only orUSD balance. |
| `openrails_get_nonce` | Read a payer's current OpenRails nonce lane value. |
| `openrails_get_paycard` | Read canonical paycard or stream state by paycard ID. |
| `openrails_prepare_railsflow` | Prepare unsigned RailsFlow metadata, intent, paycard ID, EIP-712 typed data, approval requirement, and projected economics. |

## Canonical deployment

- Chain: GIWA Sepolia
- Chain ID: `91342`
- Standard RPC: `https://sepolia-rpc.giwa.io`
- Flashblocks RPC: `https://sepolia-rpc-flashblocks.giwa.io`
- Explorer: `https://sepolia-explorer.giwa.io`
- Token: `0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De`
- Vault: `0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1`
- Factory: `0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d`
- Master: `0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb`

`orUSD` is a six-decimal test token. It is not USDC.

## Build and run

```bash
npm install
npm run build
node dist/index.js
```

The server communicates over stdio. Logs are written to stderr so stdout remains reserved for MCP JSON-RPC traffic.

## Smoke test

```bash
npm run smoke
```

The smoke test launches the built server with a real MCP client, verifies the GIWA tool surface, calls `openrails_network_info`, and confirms that legacy signer/transaction tools are not exposed.

## Environment overrides

| Variable | Default |
|---|---|
| `OPENRAILS_RPC_URL` | `https://sepolia-rpc.giwa.io` |
| `OPENRAILS_FLASHBLOCKS_RPC_URL` | `https://sepolia-rpc-flashblocks.giwa.io` |
| `OPENRAILS_EXPLORER_BASE_URL` | `https://sepolia-explorer.giwa.io` |

`OPENRAILS_MCP_SIGNER_KEY` is rejected. Signing belongs in the external payer wallet.

## MCP client configuration

```json
{
  "mcpServers": {
    "openrails-giwa": {
      "command": "node",
      "args": ["/absolute/path/to/mcosm-OpenRails/mcp/dist/index.js"]
    }
  }
}
```
