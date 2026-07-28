# Trust Model

## Trusted

- Workspace authority signatures.
- Counterparty signatures over immutable Pact terms.
- Canonical GIWA receipts and OpenRails vault state.
- Explicitly configured verification-plugin implementations whose code digest matches an installed signed manifest.

## Not trusted

- Agent proposals.
- MCP or HTTP caller-supplied actor labels.
- Flashblocks observations as finality.
- Arbitrary transaction hashes, JSON type assertions, evidence hashes, or plugin manifests without their required signatures and bindings.

Administrative mutations use short-lived Workspace commands bound to an exact payload, Workspace revision, and monotonic nonce. V1 supports EOA Workspace authorities only; multisig and smart-account authority require EIP-1271 support before enablement. Proof checkpoints bind the signer, Pact terms hash, Paycard, index, evidence, and expiry.
