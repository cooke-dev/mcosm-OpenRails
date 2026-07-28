# Security Boundary

- External wallets sign Workspace, Agent, Path, and Pact typed data.
- Agents receive identity/runtime credentials only; no owner private keys.
- The default authority modes are observe, propose, prepare, and confirmed execution.
- The runtime never accepts arbitrary calldata or arbitrary settlement targets.
- Verification plugins return decisions and never receive custody authority.
- Gaia closes future economic exposure and creates rectification obligations; it does not reverse finalized transfers.
- The GIWA OpenRails vault is authoritative for balances, nonces, settlement, and residual recovery.
