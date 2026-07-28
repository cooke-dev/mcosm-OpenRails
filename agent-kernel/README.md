# OpenRails GIWA Agent Kernel

Backend-only V1 kernel for Workspace ownership, registered agents, signed and versioned Paths, proposal-bound immutable Pact terms, typed actions, Baphomet decisions, signed Proof checkpoints, canonical GIWA payment observations, and runtime Gaia rectification.

The kernel never accepts private keys, signs payment intents, approves tokens, or broadcasts transactions. A Pact can become financially active or settled only through an injected canonical OpenRails chain verifier. The deployed OpenRails vault remains the sole custody and payment-enforcement boundary.

## Security-critical invariants

- Pact payer, recipient, and residual recipient are derived from the approved Proposal and Workspace; adapters cannot replace them.
- Pact signatures and OpenRails metadata bind `termsHash`, which excludes mutable lifecycle fields; recorded signatures are replay-safe and cannot regress lifecycle state.
- Proposal policy is re-evaluated immediately before Pact creation.
- Agent status, plugin installation, and Gaia resolution require signed, expiring, nonce-protected Workspace commands.
- Checkpoints require a participant signature, monotonic index, immutable Pact terms hash, and canonical Paycard binding.
- Financial state requires canonical GIWA receipts and exact OpenRails event/state matching, including active Paycard status and nonzero available balance.
- Pact terms snapshot the exact verification plugin ID, version, and code digest.
