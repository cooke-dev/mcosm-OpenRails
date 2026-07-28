# OpenRails GIWA MCP

The default MCP exposes canonical GIWA reads, unsigned RailsFlow preparation, and the OpenRails Agent Kernel.

Safety boundary:

- no private keys;
- no signing;
- no transaction submission;
- no arbitrary calldata;
- no unattended autonomous spending;
- external wallet required for payment approval.

The Agent Kernel adds Workspace, Agent, Path, Pact, Proof, Baphomet, blocked-action, and Gaia tools. Complex signed artifacts are passed as JSON strings so wallets and external applications remain the authority boundary.

`OPENRAILS_AGENT_KERNEL_STATE_PATH` selects the durable JSON state file for local/MCP use. Production deployments should use the PostgreSQL store and `agent-kernel/sql/001_agent_kernel.sql`.

`OPENRAILS_UPID_RPC_URL` is optional. When configured, the GIWA identity adapter attempts ENS-compatible reverse and forward resolution for `.up.id` names. Dojang verification uses the canonical GIWA Sepolia DojangScroll contract.
