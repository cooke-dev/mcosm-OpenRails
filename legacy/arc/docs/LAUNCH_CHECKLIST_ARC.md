# OpenRails V1 Launch Checklist

Use this checklist before a public demo or public-testnet launch. `npm run launch:check` verifies repo shape, environment shape, and deployment registry shape. It does not deploy contracts, submit transactions, print secrets, or replace manual security signoff.

## 1. Local Build and Test Gates

Last recorded validation baseline:

- `npm run build:sdk` passed.
- `npx tsc --noEmit` passed.
- Hardhat tests: 47 passing.
- Foundry tests: 8 passing.
- `npx vite build dashboard --outDir /tmp/openrails-dashboard-build` passed.
- `git diff --check` passed.

Automated:

- [ ] `npm run launch:check`
- [ ] `npm run compile`
- [ ] `npm run build:sdk`
- [ ] `npx tsc --noEmit`
- [ ] `git diff --check`
- [ ] `npm run test`
- [ ] `npm run test:foundry`
- [ ] `npx vite build dashboard --outDir /tmp/openrails-dashboard-build`

Manual:

- [ ] Confirm all changed files are expected for the release.
- [ ] Confirm no private keys, seed phrases, RPC secrets, or funded wallet credentials are committed.
- [ ] Confirm manual security review, key custody approval, and launch signoff remain complete and current.

## 2. Contract and Security Gates

Automated:

- [ ] Hardhat tests cover EIP-712 recovery, metadata hash binding, RailsFlow, RailsCard, nonce lanes, settlement, residual flush, and server validation paths.
- [ ] Foundry fuzz and invariant tests cover capital conservation, nonce sequencing, tamper rejection, wildcard RailsCard claims, horizon caps, and residual flush authorization.
- [ ] `npm run launch:check` confirms contract, deploy, smoke, SDK, and dashboard files are present.

Manual:

- [ ] Independent smart contract/security review accepted.
- [ ] Owner, deployer, relayer, and payer key custody confirmed.
- [ ] Emergency pause owner is reachable during the demo window.
- [ ] No production funds are used in demo wallets.
- [ ] Contract verification and ABI publication are complete.
- [ ] Circle Paymaster enablement is explicitly approved before use.

## 3. Arc Testnet Deployment Gates

Automated:

- [ ] `.env` is created from `.env.example` and placeholders are replaced locally.
- [ ] `npm run launch:check` reports non-placeholder Arc RPC, chain ID, token, hub, deployer, recipient, recovery, payer, and relayer configuration.
- [ ] `OPENRAILS_DEPLOYMENT_REGISTRY_PATH` points to a secret-free registry file.
- [ ] Registry includes valid `chainId`, `arcUsdcAddress`, `arcOpenRailsHubV1`, and explorer base URL.

Manual:

- [ ] Arc RPC URL and chain ID match the intended network.
- [ ] Deployer and relayer have native gas.
- [ ] Payer has enough USDC or test token balance.
- [ ] Payer allowance covers smoke allocations.
- [ ] Explorer links resolve for token, Vault, and smoke transactions.

Deployment command:

```bash
OPENRAILS_DEPLOYMENT_REGISTRY_PATH=deployments/openrails-addresses.local.json npm run deploy:openrails
```

Smoke command:

```bash
npm run smoke:testnet
```

## 4. Backend and Gateway Gates

Automated:

- [ ] Server rejects invalid envelope modes and invalid recipient combinations.
- [ ] Server rejects paycard and metadata header mismatches.
- [ ] Demo custodial flush remains disabled unless explicitly enabled for local-only demos.
- [ ] Rate limiting and validation helpers are present.

Manual:

- [ ] Public demo environment does not expose private keys.
- [ ] Public API logs do not print bearer tokens, signatures, or private RPC secrets.
- [ ] RPC failure and transaction failure messages are understandable to operators.

## 5. SDK, Link, and Access Gates

Automated:

- [ ] SDK builds successfully.
- [ ] Compact `orc1:` link helpers round-trip RailsFlow and RailsCard artifacts.
- [ ] Compact links remain URL fragment artifacts and are not sent as query parameters.
- [ ] Access credentials sign the expected fields and enforce the allowlist interceptor behavior.
- [ ] Nonce engine tests pass for sequential and concurrent calls.
- [ ] Workflow indexing tests pass for metadata-bound `workflowId` grouping.

Manual:

- [ ] RailsFlow and RailsCard vocabulary is consistent in demo scripts and UI.
- [ ] Bearer RailsCard links are treated as first-holder-wins value-bearing artifacts and shared only intentionally.
- [ ] Services using access headers verify Vault state onchain or through a trusted indexer.
- [ ] Operators understand that workflow indexing is an offchain projection bound through `metadataHash`, not new onchain authority.

## 5.1 x402 Proof Boundary Gates

Automated:

- [ ] Paid x402 smoke has a recorded request, settlement UUID or facilitator response, and OpenRails receipt linkage when the path is enabled.

Manual:

- [ ] x402 settlement proof is described separately from OpenRails Vault proof.
- [ ] OpenRails proof remains limited to signed intent, Vault transaction, settlement receipt, and residual recovery receipt.
- [ ] No x402 path is described as production-ready until a paid smoke completes against the intended environment.

## 6. Frontend Demo Gates

Automated:

- [ ] Dashboard production build succeeds.
- [ ] Dashboard uses current Vault, RailsFlow, RailsCard, metadata hash, nonce lane, and residual recovery wording.
- [ ] QR/link panels render for RailsFlow and RailsCard flows.
- [ ] Receipt and Judge Mode panels render payment, settlement, and residual receipt JSON.

Manual:

- [ ] Connected wallet is non-custodial.
- [ ] Dashboard can switch to or add Arc testnet using public Arc RPC metadata.
- [ ] Open, settle, and flush are submitted by the connected wallet.
- [ ] Local relayer, local time travel, and local auto drip remain sandbox-only.
- [ ] Wallet/testnet state is explained before the demo.
- [ ] Pending, confirmed, and failed transaction states are visible enough for operators.
- [ ] Receipt and Judge Mode panels label generated artifacts as demo/public-testnet evidence, not audit proof.
- [ ] Residual flush copy makes termination clear.
- [ ] Demo operator can recover from a failed or duplicate Paycard ID by generating a fresh ID.

## 7. Public Demo Runbook

Before demo:

- [ ] Run all local gates.
- [ ] Run `npm run launch:check` and review warnings.
- [ ] Confirm manual signoffs.
- [ ] Confirm deployed addresses and explorer links.
- [ ] Confirm funded payer, relayer, recipient, and recovery addresses.

During demo:

- [ ] Generate a fresh RailsFlow Paycard ID.
- [ ] Connect wallet on Arc.
- [ ] Open the Vault row and confirm the transaction mined.
- [ ] Process drip settlement and confirm the transaction mined.
- [ ] Flush residual delta and confirm the transaction mined.
- [ ] Repeat with a bearer RailsCard claim.
- [ ] Show explorer transactions and registry addresses.

After demo:

- [ ] Revoke or reduce demo allowances if no longer needed.
- [ ] Stop public services that are not intended to remain online.
- [ ] Rotate any demo key that was exposed during screen sharing or logs.

## 8. Rollback and Incident Steps

Manual:

- [ ] Pause the Vault if an active vulnerability is discovered and the pause owner is available.
- [ ] Stop relayer, dashboard, and stream gateway public endpoints.
- [ ] Mark stale deployment registry entries as invalid in operator notes.
- [ ] Revoke demo wallet allowances.
- [ ] Redeploy only after root cause is understood and the new registry is published.
- [ ] Communicate clearly that public-testnet activity is demo-only unless production approval exists.
