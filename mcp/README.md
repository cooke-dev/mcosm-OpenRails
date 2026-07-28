# OpenRails GIWA MCP

The default MCP exposes canonical GIWA reads, unsigned RailsFlow preparation, and the non-custodial OpenRails Agent Kernel.

Safety boundary:

- no private keys, signing, token approvals, or transaction submission;
- no arbitrary calldata or unattended autonomous spending;
- external wallet signatures for Workspace, Agent, Path, Pact terms, administrative commands, Gaia claims, and checkpoints;
- canonical GIWA receipt and OpenRails registry verification before financial state becomes active or settled;
- Flashblocks observations are UX feedback only.

The MCP derives Pact payer/recipient terms from the approved Proposal. It cannot replace them during Pact creation. Payment preparation records the exact metadata hash, Paycard ID, genesis, and nonce parameters; activation requires a matching canonical `PaycardProvisioned` event and registry state.

The only bundled Proof implementation is `proof.hash.dev`, a development syntax checker that returns `review` rather than automatically completing work.

`OPENRAILS_AGENT_KERNEL_STATE_PATH` selects the durable JSON state file for local/MCP use. The PostgreSQL V1 store uses one transactionally locked JSONB snapshot. Normalized projections are deferred.

`OPENRAILS_UPID_RPC_URL` is optional. When a Path requires `.up.id`, missing resolution or a failed forward match blocks the proposal. Dojang verification uses the canonical GIWA Sepolia deployment configuration exported by the Agent Kernel.
