# Operator Runbook

## Local build

```bash
npm run check:agent-kernel
npm run build:mcp
npm run smoke:mcp
npm run test:giwa-sdk
npm run test
```

## Kernel HTTP service

```bash
export OPENRAILS_AGENT_KERNEL_API_KEY='replace-me'
export OPENRAILS_AGENT_KERNEL_STATE_PATH='artifacts/giwa-agent-kernel/state.json'
npm run agent-kernel:start
```

The HTTP service rejects `OPENRAILS_AGENT_KERNEL_PRIVATE_KEY` and `OPENRAILS_MCP_SIGNER_KEY`.

## PostgreSQL

Apply:

```bash
psql "$DATABASE_URL" -f agent-kernel/sql/001_agent_kernel.sql
```

Instantiate `PostgresKernelStore` with a parameterized database executor. Database mutations are serialized under a row lock and committed atomically.

## GIWA identity

Dojang verification is read from the GIWA Sepolia DojangScroll contract. `OPENRAILS_UPID_RPC_URL` is optional and enables ENS-compatible reverse/forward `.up.id` checks.

## Rollback

The integration adds no contract deployment and mutates no onchain state. Rollback consists of stopping the Kernel service, disabling the Agent MCP tools, and reverting the feature branch. Existing OpenRails GIWA payments remain unaffected.
