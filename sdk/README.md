# openrails-sdk

SDK + `openrails` CLI for **OpenRails** - intent-driven clearing & settlement for streamed USDC
work on **Arc**. Sign an intent → clear it into a bounded onchain Vault → settle value as work
is performed → recover residual. Usable by humans or agents.

> Arc testnet: chain `5042002`, Hub `0x941C8029F0f912df3fAb7423890ab2359b996D0b` (V2, canonical),
> USDC `0x3600000000000000000000000000000000000000`.
> V1 (`0x01EC54846524D043fD808152D41596beF603381d`) is frozen to new opens - don't target it.

## Install
```bash
npm i openrails-sdk        # library + the `openrails` CLI
```

## Library

A genuinely runnable first call - approve, sign an EIP-712 permission envelope, and open a
Paycard Stream (escrow is pulled from the signer's own USDC; non-custodial):

```ts
import { ethers } from "ethers";
import {
  approveOpenRailsSpend,
  signPermissionEnvelopeWithSigner,
  submitOpenPaycardWithSigner,
  readNonce,
  hashOpenRailsMetadata,
} from "openrails-sdk";

const HUB = "0x941C8029F0f912df3fAb7423890ab2359b996D0b"; // V2 canonical
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
const signer = new ethers.Wallet(process.env.MY_KEY!, provider);

const recipient = "0x<recipient>";
const allocation = "10000"; // 0.01 USDC, 6 decimals

const metadata = {
  version: "openrails-metadata-v1" as const,
  mode: "railsflow" as const,
  originator: signer.address,
  recipient, token: USDC, amount: allocation,
  flowVelocityPerSecond: "1", lifespanSeconds: 3600, metadataRef: "hello-openrails",
};
const nonceValue = await readNonce(provider, HUB, signer.address, 0);
const intent = {
  paycardId: ethers.keccak256(ethers.toUtf8Bytes(`pay-${Date.now()}`)),
  metadataHash: hashOpenRailsMetadata(metadata),
  recipient, totalAllocationPool: allocation, flowVelocityPerSecond: "1",
  genesisTimestamp: Math.floor(Date.now() / 1000) - 10, lifespanSeconds: 3600,
  residualDeltaRecipient: signer.address, nonceChannel: 0, nonceValue,
};

await (await approveOpenRailsSpend(signer, USDC, HUB, BigInt(allocation))).wait();
const token = await signPermissionEnvelopeWithSigner(
  signer, { chainId: CHAIN_ID, clearinghouseAddress: HUB, usdcAddress: USDC }, intent,
  { mode: "railsflow", metadata },
);
const tx = await submitOpenPaycardWithSigner(signer, HUB, token, "railsflow");
console.log("opened:", (await tx.wait())?.hash);

// later: settle (drip) and recover residual
// await submitSettleWithSigner(signer, HUB, intent.paycardId);   // processDripSettle
// await submitFlushWithSigner(signer, HUB, intent.paycardId);    // flushResidualDelta
```

Full walkthrough with more context: see [`GETTING_STARTED.md`](../GETTING_STARTED.md) Path B.

The public surface is re-exported from the package root (`client`, `wallet`, `metadata`,
`links`, `receipts`, `nonce`, `proof`, `policy`, `access`, …).

## Signer abstraction & gasless

OpenRails authenticates the **signature, not the sender** (the Hub recovers the payer via
`ecrecover`), so accounts only need to *sign* - submission can be sponsored. The SDK builds on that:

```ts
import { LeptonOpenRailsClient, payGasless, claimGasless, RelayClient, signUsdcPermit } from "openrails-sdk";
import { ethersToSubmitter } from "openrails-sdk/adapters/ethers";

// Any OpenRailsAccount works - no raw private key required.
const account = ethersToSubmitter(anyEthersSigner);              // or privyToAccount / turnkeyToAccount
const client  = await LeptonOpenRailsClient.fromAccount(account, hubAddress, chainId);

// Gasless: the payer signs an intent (+ an EIP-2612 permit) and a relayer submits it.
const relay  = new RelayClient({ baseUrl: RELAY_URL });
const permit = await signUsdcPermit(account, { token: usdc, spender: hubAddress, value, chainId, provider });
await payGasless({ client, relay, intent, options: { mode: "railsflow", metadata }, permit });

// Claim a RailsCard gaslessly (the payer already signed; the claimer needs no gas).
await claimGasless({ relay, envelopeToken, claimRecipient });
```

- **Accounts:** `OpenRailsAccount` (sign-only) / `OpenRailsSubmitter` (also self-submits). An
  `ethers.Signer` satisfies the latter. The `privateKey` constructor still works unchanged.
- **Adapters (subpath exports):** `openrails-sdk/adapters/ethers` · `.../adapters/privy` (humans) ·
  `.../adapters/turnkey` (agents / server wallets) · `.../adapters/circle` (Circle Smart Accounts,
  EIP-1271). `@privy-io/react-auth` and `@turnkey/ethers` are **optional peers** - the core imports
  neither, so a plain `import` pulls nothing extra. `circleToAccount` has no peer dep at all since
  it's structurally typed against any viem-shaped smart-account signer, not a specific package.
- **Permit:** `signUsdcPermit` produces an EIP-2612 permit so the payer's approval is a signature,
  not a transaction. Combined with the relay → no gas, no approval tx.

### Privy embedded wallets (humans)

A Privy embedded wallet exposes a standard EIP-1193 provider - bridge it into an
`OpenRailsAccount` with `privyToAccount`, then drive the same gasless flow above:

```tsx
import { useWallets } from "@privy-io/react-auth";
import { privyToAccount } from "openrails-sdk/adapters/privy";
import { LeptonOpenRailsClient, payGasless, RelayClient } from "openrails-sdk";

const { wallets } = useWallets();
const embedded = wallets.find(
  (w) => w.walletClientType === "privy" || w.walletClientType === "privy-v2",
);

const provider = await embedded.getEthereumProvider();
const account  = privyToAccount({ address: embedded.address, provider });
const client   = await LeptonOpenRailsClient.fromAccount(account, hubAddress, chainId);

const relay = new RelayClient({ baseUrl: RELAY_URL });
await payGasless({ client, relay, intent, options: { mode: "railsflow", metadata } });
```

The embedded wallet only ever *signs* - it never needs gas or a submitted transaction, since
`payGasless`/`claimGasless` route through the relay. `walletClientType` is Privy's own field for
distinguishing its embedded wallet (`"privy"` or the newer `"privy-v2"`) from an injected/external
one. This snippet is checked against the installed `@privy-io/react-auth` types but isn't
execution-tested here (that needs a real browser + Privy session) - `test/PrivyAdapter.test.ts`
in this repo proves the signing math end to end with a mock EIP-1193 provider instead.

### Circle Smart Account (EIP-1271)

The V2 Hub verifies signatures via OpenZeppelin's `SignatureChecker.isValidSignatureNow`, so it
accepts EIP-1271 smart-contract-account signatures alongside plain EOA ones - no separate
contract path. `circleToAccount` wraps any viem-shaped smart-account signer into an
`OpenRailsAccount`:

```ts
import { circleToAccount } from "openrails-sdk/adapters/circle";
import { LeptonOpenRailsClient, payGasless } from "openrails-sdk";

// `smartAccount` is any viem-compatible signer:
//   { address: string; signTypedData({ domain, types, primaryType, message }) }
const account = circleToAccount(smartAccount);
const client  = await LeptonOpenRailsClient.fromAccount(account, hubAddress, chainId);
await payGasless({ client, relay, intent });
```

`circleToAccount` sets `isSmartAccount: true` on the returned account, which tells the client to
skip the client-side ECDSA-recovery sanity check (EIP-1271 signatures were never recoverable that
way in the first place) - the real verification still happens on-chain via the Hub's
`SignatureChecker`. Proven both locally (`test/CircleAdapter.test.ts`, `test/v2-factory.test.ts`,
against a local Hardhat contract) and **live against the deployed V2 Hub on Arc testnet** - a real
open + settle with real tx hashes, not a mock:
[`experiments/circle-sa-live-proof/results.md`](../experiments/circle-sa-live-proof/results.md).

### Circle Gateway (cross-chain funding)

Circle Gateway gives near-instant (~500ms) unified-balance funding across chains - this is how
value gets **into** Arc from another chain, distinct from the OpenRails Hub flows above (which
assume you already hold USDC on Arc):

```ts
import { depositToGateway, mintFromGateway } from "openrails-sdk/gateway";

// deposit 25 USDC (6-decimal base units) into the Gateway Wallet
const { txHash } = await depositToGateway({
  signer,                    // ethers.Signer
  amountBaseUnits: 25_000_000n,
  autoApprove: true,         // submit approve() if allowance is insufficient
});
```

Live on Arc testnet: `GatewayWallet 0x0077777d7EBA4688BDeF3E311b846F25870A19B9`,
`GatewayMinter 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`. This module is entirely separate from
the Hub/Paycard flow - it's not re-exported from the package root, only from `openrails-sdk/gateway`.

For an agent-facing surface over these, see the companion **`openrails-mcp`** MCP server.

## CLI
```bash
npx openrails --help
npx openrails request-stream …     # build an unsigned RailsFlow request link
npx openrails pay-stream --execute --approve …   # sign + open a Paycard Stream
npx openrails settle  --execute …  # processDripSettle
npx openrails close   --execute --ack-irrevocable-close …   # flushResidualDelta
```

**Safety:** asset-affecting commands are **dry-run by default** (`--execute` to act); `close`
also needs `--ack-irrevocable-close`. **Private keys via env only** (`OPENRAILS_PAYER_PRIVATE_KEY`
or `--signer-env <NAME>`) - never on argv.

## Vocabulary
**Paycard Stream** (onchain Vault row) · **RailsFlow** (request link) · **RailsCard** (claimable
value link) · **Nonce Lane** (replay/concurrency) · **Receipts** (proof artifacts).

## Versioning

Semver in spirit, pre-1.0 - see [`CHANGELOG.md`](CHANGELOG.md) for the full policy and every
change so far. In short: deprecated names are kept as aliases (`OpenRailsArcClient`) rather than
deleted, legacy env vars are kept as fallbacks (`OPENRAILS_PRIVATE_KEY`) rather than removed, and a
default-value change (like the 0.1.1 EIP-712 domain-version bump) is treated as a minor bump even
with no signature change.

Peer dep: `ethers` v6. License: MIT.
