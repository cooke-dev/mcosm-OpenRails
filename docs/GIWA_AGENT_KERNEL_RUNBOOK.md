# Operator Runbook

## Local validation

```bash
npm run check:agent-kernel
npm run build:mcp
npm run smoke:mcp
npm run test:giwa-sdk
npm run test
```

## Operator-only HTTP service

The service binds to `127.0.0.1` by default. Global state debugging and mutations are disabled unless explicitly enabled.

```bash
export OPENRAILS_AGENT_KERNEL_API_KEY="$(openssl rand -hex 32)"
export OPENRAILS_AGENT_KERNEL_STATE_PATH='artifacts/giwa-agent-kernel/state.json'
export OPENRAILS_AGENT_KERNEL_ENABLE_HTTP_MUTATIONS=true
# Only for local operator diagnostics:
export OPENRAILS_AGENT_KERNEL_ENABLE_OPERATOR_DEBUG=true
npm run agent-kernel:start
```

Do not expose this service directly to the public internet. A non-loopback bind is rejected unless `OPENRAILS_AGENT_KERNEL_ALLOW_REMOTE_OPERATOR=true`; that override requires a separately reviewed authenticated reverse proxy and transport security.

The standalone HTTP server has no chain verifier, so it cannot mark a Pact active or settled. Canonical financial observation is currently provided by the GIWA MCP adapter.

## PostgreSQL

V1 intentionally stores one transactionally locked JSONB snapshot:

```bash
psql "$DATABASE_URL" -f agent-kernel/sql/001_agent_kernel.sql
```

Normalized tables are deferred until projection writers and deterministic rebuild behavior are implemented.

## Rollback

The integration deploys no contract and mutates no existing onchain state. Stop the service, disable Agent MCP tools, and revert the feature branch. Existing OpenRails GIWA payments remain unaffected.
