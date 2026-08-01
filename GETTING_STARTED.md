# Getting started with OpenRails on GIWA

OpenRails is the control, agreement, and settlement plane for programmable
commerce on GIWA.

## Requirements

- Node.js 20 or newer
- npm
- a browser wallet for Live Run
- GIWA Sepolia ETH for transaction gas
- test-only orUSD for settlement actions

## Install

```bash
npm install
npm --prefix agent-kernel install
npm --prefix apps/gasok-web install
```

## Start the GIWA product

```bash
npm --prefix apps/gasok-web run dev
```

Product routes:

- `/` — product narrative
- `/system` — Live Run and Recorded Run
- `/network` — GIWA deployment evidence
- `/build` — Runtime, SDK, and MCP architecture
- `/docs` — product and technical documentation

## Recorded Run

Recorded Run is deterministic and does not require fresh wallet transactions.
It demonstrates the canonical 420 orUSD lifecycle and its negative policy control.

## Live Run

Live Run requires a connected wallet and performs the bounded GIWA Sepolia
lifecycle through the deployed OpenRails Vault.

The Runtime prepares, evaluates, verifies, and records. The wallet remains the
authorization and transaction-broadcast boundary.

## Verify the release

```bash
npm run test:agent-kernel
npm --prefix apps/gasok-web run typecheck
npm --prefix apps/gasok-web run build
```

Canonical deployment information is stored in:

```text
deployments/giwa-sepolia.json
deployments/giwa-orusd-faucet.json
```
