# Legacy Arc implementation

This directory preserves the original Arc-specific OpenRails implementation,
deployment material, applications, and operational documentation.

Arc is no longer the default product or developer surface of this repository.

The canonical active implementation is OpenRails on GIWA:

- Product web: `apps/gasok-web`
- Agent Kernel: `agent-kernel`
- GIWA deployments: `deployments/giwa-sepolia.json`
- GIWA faucet: `deployments/giwa-orusd-faucet.json`
- GIWA documentation: `docs/GIWA_*`

Compatibility-sensitive contract names and ABI symbols remain unchanged until a
separate versioned contract migration is performed.
