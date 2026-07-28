# OpenRails GIWA Agent Kernel V1

## Scope

The Agent Kernel is the backend integration layer above the deployed OpenRails GIWA rail. It does not replace the vault, hold funds, sign payment intents, or broadcast transactions.

## Modules

- **Workspace** — principal, authority account, membership, roles, revision.
- **Agent Registry** — identity key, runtime credential hash, capabilities, Path assignments, revocation.
- **Path** — signed and versioned delegated economic mandate.
- **Pact** — signed agreement bound to one Path revision and one OpenRails payment lifecycle.
- **Baphomet** — deterministic ALLOW/BLOCK/REVIEW policy evaluation.
- **Hotshot boundary** — unsigned preparation and externally confirmed execution coordination.
- **Proof** — versioned plugins, checkpoints, decisions, evidence/source commitments.
- **Gaia** — runtime exception handling and rectification obligations.
- **GIWA adapters** — canonical RPC, Flashblocks observation, Dojang verification, optional `.up.id` resolution.

## Authority modes

1. `observe`
2. `propose`
3. `prepare`
4. `confirmed_execution`

No unattended autonomous spending is enabled in V1.

## Hash binding

A Pact records the exact signed Path hash and revision. Pact-bound RailsFlow preparation uses:

- `workflowId = pactId`
- `descriptionHash = canonical Pact hash`
- `metadataRef = compact Path revision + Path hash + evidence-policy hash commitment`
- `salt = Pact hash`

The OpenRails vault remains authoritative for payer, recipient, token, allocation, velocity, lifespan, nonces, settlements, and residual recovery.
