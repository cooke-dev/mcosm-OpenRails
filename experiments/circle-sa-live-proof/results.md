# Circle Smart Account — live proof against the V2 Hub (Arc testnet)

Closes the outstanding item from
`docs/superpowers/plans/2026-07-06-demo-readiness-and-circle-integration.md`'s addendum: Circle
Smart Account (EIP-1271) had only ever been proven against a local `MockERC1271Account` in an
isolated Hardhat instance (`test/CircleAdapter.test.ts`, `test/v2-factory.test.ts`). This is a real
run against the **live deployed V2 Hub** on Arc testnet — real deployment tx, real signature, real
escrow pull, real settlement payout, all independently checkable on `testnet.arcscan.app`.

Script: [`prove.ts`](prove.ts). Contract:
[`contracts/v2-factory/proof/MinimalSmartAccountV1.sol`](../../contracts/v2-factory/proof/MinimalSmartAccountV1.sol)
— a minimal owner-gated EIP-1271 wallet (same verification shape a Circle Smart Account uses:
`isValidSignature` recovers a 65-byte ECDSA signature against a fixed owner). Signing went through
the SDK's real `openrails-sdk/adapters/circle` (`circleToAccount`, `isSmartAccount: true`) — the
same code path a real Circle Smart Account integration uses, not a shortcut.

## Result — PASS

Run on Arc testnet (chain `5042002`) against Hub `0x941C8029F0f912df3fAb7423890ab2359b996D0b`.

| Step | Tx hash |
|---|---|
| Deploy `MinimalSmartAccountV1` | [`0x72a87e8b…7cc2de6`](https://testnet.arcscan.app/tx/0x72a87e8b33f340c70822154ac1144b567e51f732f58396aa2db3897177cc2de6) |
| Seed smart account with 0.01 USDC | [`0x36113384…5efc3b8`](https://testnet.arcscan.app/tx/0x3611338414758276bbe7189bf7fe5492c30877d27038b15e841d9b25c5efc3b8) |
| Smart account approves the Hub | [`0xbb3b7880…4972c2`](https://testnet.arcscan.app/tx/0xbb3b78801a57fbbf08d503ee131de5e8c633103157ce1a59e4b7afb4f84972c2) |
| **`openPaycardChannel`** (EIP-1271-signed) | [`0xec7cbc3a…f0bde0c`](https://testnet.arcscan.app/tx/0xec7cbc3aa93dc6165b011599ab3bb1c9f07a2b51aca829bb952ce9ddff0bde0c) — block 51067482 |
| `processDripSettle` | [`0xa7923711…9aaa1cca`](https://testnet.arcscan.app/tx/0xa79237112829c6cd06b68bc5519d06c96f6ec16718cc00f33f1c55649aaa1cca) — block 51067494 |

- Smart account: [`0x1ec3b888…D51A4a`](https://testnet.arcscan.app/address/0x1ec3b8881594Fc66Eec4c34a13Be6D3563D51A4a)
- Owner EOA: `0x12079476a13BA617f0c258d504138D60bb330603`
- Recipient (freshly generated, unambiguous proof): `0x54E42bedD2533F74b958EE8b92A0A9F9692a6d4e`
- On-chain registry row after open: `payer` = the smart account address (not the owner EOA) —
  confirms the Hub's `SignatureChecker.isValidSignatureNow` path, not a plain EOA `ecrecover` path.
- Recipient USDC balance after settle: exactly `0.001` — the full escrowed amount, correctly paid
  out.

## What this proves

- The V2 Hub's EIP-1271 verification path (`SignatureChecker.isValidSignatureNow`) works against a
  **real deployed contract wallet**, not just a mock in an isolated test instance.
- The SDK's `openrails-sdk/adapters/circle` (`circleToAccount`) produces a signature a real
  deployed smart account accepts, end to end — sign → open → settle.
- The registry correctly records the **smart account** as `payer`, and correctly rejects treating
  the owner EOA as the payer (the escrow was pulled from the smart account's own USDC balance, not
  the owner's).

## What this does not prove

- This is not Circle's own Smart Account infrastructure (their factory/paymaster/session-key
  stack) — it's a minimal, purpose-built stand-in with the same `isValidSignature` verification
  shape. A real Circle-deployed smart account should behave identically at the Hub's verification
  boundary (that boundary only cares about EIP-1271 compliance), but this run does not exercise
  Circle's own infrastructure.
- Gasless/relayed submission through the keeper (`/relay-open`) was not exercised here — this run
  submitted directly with a funded EOA for clarity. The relay's `staticCall` precheck path is
  already covered separately (see `workers/README.md`).

## Reproduce

```bash
OPENRAILS_LIVE_PROOF_OPERATOR_KEY=0x<funded-arc-testnet-key> \
  npx ts-node experiments/circle-sa-live-proof/prove.ts
```
