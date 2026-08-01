# OpenRails GIWA release checklist

## Product

- [ ] `/`, `/system`, `/network`, `/build`, and `/docs` load correctly
- [ ] GIWA is the default visible network
- [ ] Recorded Run loads without a wallet
- [ ] Live Run clearly requires wallet confirmation
- [ ] Midium is presented as the conversational interface over OpenRails
- [ ] No active product copy presents a legacy network as the default deployment

## Runtime and authority

- [ ] Workspace ownership is explicit
- [ ] Path limits and expiry are visible
- [ ] Baphomet emits only `ALLOW` or `BLOCK`
- [ ] Pact terms are immutable after signing
- [ ] Proof is bound to the Pact and canonical Paycard
- [ ] Wallet confirmation remains required for financial actions
- [ ] Vault state remains the financial source of truth

## GIWA deployment

- [ ] Chain ID is `91342`
- [ ] Vault matches `deployments/giwa-sepolia.json`
- [ ] Factory matches `deployments/giwa-sepolia.json`
- [ ] orUSD is labelled as a test settlement token
- [ ] Explorer links resolve correctly
- [ ] Faucet address and cooldown are correct

## Evidence

- [ ] Live evidence is labelled `LIVE ON GIWA`
- [ ] Historical evidence is labelled `RECORDED`
- [ ] Curated explanatory state is labelled `DEMONSTRATION`
- [ ] Transaction hashes and Paycard identifiers are readable
- [ ] No mainnet, audit, gasless, or autonomous-signing claims are made

## Verification

```bash
npm run test:agent-kernel
npm --prefix apps/gasok-web run typecheck
npm --prefix apps/gasok-web run build
```

Expected release gate:

- Agent Kernel: 25/25 tests passing
- TypeScript check passing
- production Vite build passing
