# Getting started with OpenRails

OpenRails is a non-custodial USDC payment rail on **Arc testnet**. You sign a bounded intent, value
streams to the recipient as it's earned, and the unspent remainder returns to you. This guide gets you
from zero to a first payment.

> **Testnet, unaudited — use test funds only.** Everything below runs on Arc testnet (chainId `5042002`).

## 0. What you need

- An **Arc testnet wallet** you control (a private key). Because USDC is Arc's native gas token, that
  wallet just needs some **testnet USDC** — it pays both the escrow and the gas.
- Node 18+ (only for the SDK/CLI paths).

The live V2 contracts (already the default in every tool below):

| | Address |
|---|---|
| Canonical hub | `0x941C8029F0f912df3fAb7423890ab2359b996D0b` |
| USDC (native) | `0x3600000000000000000000000000000000000000` |
| RPC | `https://rpc.testnet.arc.network` · chainId `5042002` |

---

## Path A — The cockpit (no install, easiest)

Open **https://openrails.pages.dev**, connect your wallet, switch to Arc testnet, and use:
- **Request** a payment → generates a **RailsFlow** link/QR to share.
- **Pay** a link → opens the stream; escrow leaves your wallet, streams to the recipient.
- **Issue / claim a RailsCard** → pre-signed claimable value.

The cockpit computes the cryptographic bits (metadata commitment, nonce, paycard id) for you. This is
the fastest way to see a real payment end-to-end.

---

## Path B — The SDK library (programmatic, auto-computes everything)

```bash
npm install openrails-sdk
```

```ts
import { ethers } from "ethers";
import {
  approveOpenRailsSpend,
  signPermissionEnvelopeWithSigner,
  submitOpenPaycardWithSigner,
  readNonce,
  hashOpenRailsMetadata,
} from "openrails-sdk"; // all re-exported from the package entry

const HUB = "0x941C8029F0f912df3fAb7423890ab2359b996D0b";
const USDC = "0x3600000000000000000000000000000000000000";
const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");
const signer = new ethers.Wallet(process.env.MY_KEY!, provider);
const chainId = 5042002;

const recipient = "0x<recipient>";
const allocation = "10000"; // 0.01 USDC (6 decimals)

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
  signer, { chainId, clearinghouseAddress: HUB, usdcAddress: USDC }, intent, { mode: "railsflow", metadata },
);
const tx = await submitOpenPaycardWithSigner(signer, HUB, token, "railsflow");
console.log("opened:", (await tx.wait())?.hash);
```

The signer can be a raw key (above) or an embedded wallet / smart account via
`openrails-sdk/adapters/{privy,turnkey}` — same interface.

---

## Path C — The CLI (`openrails`, for scripting / power users)

```bash
npm install -g openrails-sdk      # provides the `openrails` command
# or, no global install:  npx -p openrails-sdk openrails <command>
```

**Network config now defaults to Arc-testnet-V2** — you only set your key. Any value is overridable by
flag or env (`flag > OPENRAILS_* env > ARC_* env > built-in default`):

```bash
export OPENRAILS_PAYER_PRIVATE_KEY=0x<your-funded-arc-testnet-key>
# optional overrides:
# export OPENRAILS_RPC_URL=... OPENRAILS_CHAIN_ID=... OPENRAILS_HUB_ADDRESS=... OPENRAILS_USDC_ADDRESS=...
```

**Create a RailsFlow request** (no transaction — produces a shareable link):
```bash
openrails request-stream \
  --merchant 0x<you> --recipient 0x<you> \
  --amount 10000 --flow-velocity-per-second 1 --lifespan-seconds 3600 \
  --metadata-hash 0x<keccak256-of-your-terms>
```

**Pay a request** (transacts). The crypto plumbing is auto-derived, so this is all you need:
```bash
openrails pay-stream --request-link '<link from request-stream>' --approve --execute
```
Or without a link, just the payment terms:
```bash
openrails pay-stream --recipient 0x<you> \
  --total-allocation-pool 10000 --flow-velocity-per-second 1 --lifespan-seconds 3600 \
  --approve --execute
```

Other commands: `stream-status --paycard-id 0x...` (read), `settle --paycard-id 0x... --execute`,
`recover ...`, `close --paycard-id 0x... --execute --ack-irrevocable-close`.

**Safety rules baked in:**
- **Keys are never CLI flags.** Use `OPENRAILS_PAYER_PRIVATE_KEY` (or `--signer-env MYVAR`).
- **Mutating commands are dry-run by default** — add `--execute` to actually send.
- `--approve` does the bounded USDC allowance; `close` also needs `--ack-irrevocable-close`.
- Run `openrails <command> --help` for the full flag list.

> When omitted, the CLI auto-derives `--paycard-id` (random), `--metadata-hash` (from `--metadata-ref`,
> else a default), `--nonce-value` (read from the chain nonce lane), and `--residual-delta-recipient`
> (defaults to the payer) — so `pay-stream --request-link … --execute` just works. Pass any of them
> explicitly to override, e.g. for deterministic scripting or a specific nonce lane.

---

## Agents — the MCP server

To let an AI agent transact on the rail, register `openrails-mcp` with your MCP client (e.g. Claude
Desktop). It defaults to the same V2 hub; give it a signer key to transact, omit it for read-only.

```json
{
  "mcpServers": {
    "openrails": {
      "command": "npx",
      "args": ["openrails-mcp"],
      "env": { "OPENRAILS_MCP_SIGNER_KEY": "0x<funded-arc-testnet-key>" }
    }
  }
}
```

Tools: `pay_link`, `create_request_link`, `issue_railscard`, `paycard_status`, `openrails_config`.

---

*Repo contributors/deployers: see the root `.env.example` for the full deploy/test configuration.*
