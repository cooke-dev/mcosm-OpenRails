# Security Boundary

- External wallets sign Workspace, Agent, Path, Pact terms, Workspace commands, Gaia claims, and checkpoints.
- Agents receive identity/runtime credentials only; no owner private keys.
- The default authority modes are observe, propose, prepare, and confirmed execution.
- The runtime never accepts arbitrary calldata or arbitrary settlement targets.
- Proposal parties cannot be substituted during Pact creation.
- Mutable Pact lifecycle state is separated cryptographically from immutable signed terms through `termsHash`; signature replay cannot move a Pact backward.
- Verification plugins return decisions and never receive custody authority. The bundled development hash-syntax plugin returns `review`, never automatic completion.
- Gaia creates canonical-closure obligations but cannot mark a Paycard closed without canonical chain evidence.
- The GIWA OpenRails vault is authoritative for balances, nonces, settlement, and residual recovery.
- The standalone HTTP server is an operator-only localhost surface. Mutations and global state debugging are disabled by default.
