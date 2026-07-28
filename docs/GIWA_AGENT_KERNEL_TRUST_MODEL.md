# Trust Model

## Trusted authority

The Workspace authority wallet is trusted to create the Workspace, register/revoke Agents, sign Path revisions, and approve Pacts. The Agent Kernel verifies signatures but never receives the authority private key.

## Untrusted or bounded actors

- Agents may propose only typed registered actions.
- Baphomet evaluates policy and evidence but cannot move funds.
- Verification plugins return decisions but receive no custody or signing capability.
- The MCP prepares artifacts but signs and broadcasts nothing.
- External counterparties may submit evidence, which remains subject to the Pact's approved verifier.

## Onchain guarantees

The existing OpenRails GIWA deployment guarantees payment authorization, nonce consumption, escrow, settlement arithmetic, token movement, termination, and residual recovery.

## Runtime guarantees

The Kernel guarantees deterministic canonicalization, signed authority artifacts, versioned Path/Pact state, idempotency, append-only events, blocked-action records, plugin digest binding, and Gaia rectification records.

Runtime records do not independently prove subjective work quality. They prove what evidence was supplied, which verifier version ran, and which decision was produced.
