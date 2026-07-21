# OpenRails

**Pay for exactly what you use.**

**OpenRails is intent-driven clearing and settlement infrastructure for streamed work on Arc.**

In plain terms it's a payment rail: a payer signs a **bounded intent**, it **clears** into a
non-custodial on-chain Vault, value **settles** to the recipient as work is performed, and unused
residual **returns** to the payer when the stream ends — usable by **humans or AI agents**. Arc
provides fast, low-cost, USDC-native settlement; OpenRails provides the intent, escrow, streaming,
receipt, and recovery layer on top.

> Two properties make it work: the Vault authenticates the **signature, not the sender** (so
> payments can be relayed and gas-sponsored), and escrow is **bounded by construction** (a bug, a bad
> actor, or a runaway agent can never move more than was signed for).

**Core primitives** *(vocabulary is fixed — do not rename):*

| Primitive | Meaning |
| :--- | :--- |
| **RailsFlow** | A link to *ask* to be paid — invoice / paywall / usage bill. |
| **RailsCard** | A link to *send* pre-authorized value to claim — gift card / payout / agent budget (bearer or recipient-bound). |
| **Paycard Stream** | The on-chain Vault row that escrows funds and meters settlement. |
| **Nonce Lane** | Replay/concurrency protection for parallel agent payments (`nonceChannel` / `nonceValue`). |
| **Receipts** | Verifiable proof of every open, settlement, and residual return. |

The agent economy and the creator economy are the flagship verticals; the rail itself is
vertical-agnostic.

---

## Status

**Live on Arc testnet (chain `5042002`). Unaudited — test funds only.** V2 is deployed; V1 is frozen
to new opens and left to drain.

| | Address / package |
| :--- | :--- |
| **V2 canonical hub** (default) | `0x941C8029F0f912df3fAb7423890ab2359b996D0b` |
| V2 factory · master logic | see `deployments/openrails-v2-addresses.local.json` after deploy |
| V1 hub (frozen/legacy) | `0x01EC54846524D043fD808152D41596beF603381d` |
| USDC (native gas token) | `0x3600000000000000000000000000000000000000` |
| SDK + CLI | [`openrails-sdk`](https://www.npmjs.com/package/openrails-sdk) (npm) |
| Agent server | [`openrails-mcp`](https://www.npmjs.com/package/openrails-mcp) (npm) |

**What's shipped:** EIP-1271 **smart accounts** *and* EOAs (humans via embedded wallets, agents via
server wallets) — including a real, live proof of a Circle-Smart-Account-style EIP-1271 open +
settle against the deployed V2 Hub on Arc testnet, not just a local mock (real tx hashes:
[`experiments/circle-sa-live-proof/results.md`](experiments/circle-sa-live-proof/results.md));
**gasless** relaying via the keeper worker; streaming + instant settlement; automatic
residual return; on-chain receipts; a published SDK/CLI and MCP server; a deployed cockpit at
[openrails.pages.dev](https://openrails.pages.dev). Test baseline: **90 Hardhat + 9 Foundry** passing.

**Not yet:** mainnet, a security audit, session keys, USDC paymaster, and Circle's own Smart
Account factory/session-key/paymaster infrastructure specifically (the Hub's EIP-1271 verification
is proven live; Circle's own deployed infra hasn't been wired in yet). See [`HANDOFF.md`](HANDOFF.md)
for the full roadmap.

---

## Quick start

**Start here.** Want to just use it? → **Cockpit** (no install). Building an app or bot? → **SDK**
(library, pluggable signers). Scripting or a one-off transaction? → **CLI**. Wiring up an AI agent?
→ **MCP**. All four below hit the same live V2 Hub; pick one and go.

The fastest paths need no repo checkout — the packages default to Arc-testnet-V2. No testnet USDC
yet? See "Get testnet funds" in [`GETTING_STARTED.md`](GETTING_STARTED.md#0-what-you-need) — the
faucet drips both escrow funds and gas (USDC is Arc's native gas token) to any address in one call.
Full walkthrough in [`GETTING_STARTED.md`](GETTING_STARTED.md).

**CLI (one command to a first payment):**
```bash
npm i -g openrails-sdk
export OPENRAILS_PAYER_PRIVATE_KEY=0x<funded-arc-testnet-key>
openrails pay-stream --recipient 0x… --total-allocation-pool 10000 \
  --flow-velocity-per-second 1 --lifespan-seconds 3600 --execute
```
Network config (chain / RPC / hub / USDC) is defaulted; the paycard id, nonce, and metadata hash are
auto-derived. Mutating commands are dry-run until `--execute`; keys come from env, never argv.

**SDK (library):**
```bash
npm install openrails-sdk
```
```ts
import { LeptonOpenRailsClient, payGasless } from "openrails-sdk";
// pluggable signers: openrails-sdk/adapters/{ethers,privy,turnkey}
```

**Agent (MCP):** register with an MCP client (e.g. Claude Desktop):
```json
{ "mcpServers": { "openrails": {
  "command": "npx", "args": ["openrails-mcp"],
  "env": { "OPENRAILS_MCP_SIGNER_KEY": "0x<funded-key>" } } } }
```
Tools: `pay_link`, `create_request_link`, `issue_railscard`, `paycard_status`, `openrails_config`.
Omit the signer key for read-only.

**Cockpit (no install):** [openrails.pages.dev](https://openrails.pages.dev) — connect a wallet,
create/pay a link, issue/claim a RailsCard.

---

## The suite

```
Surface   RailsFlow & RailsCard  — links/QR: ask to be paid, or send value to claim
Accounts  whoever signs          — embedded wallets, EIP-1271 smart accounts, agents
Rail      intent → vault → stream → residual  — non-custodial clearing & settlement
Build     SDK · CLI · MCP        — one command / one tool-call to transact
Settle    on Arc                 — USDC-native, fast, low-cost finality
```

- **Contracts** (`contracts/`): `ArcOpenRailsHubV1.sol` (V1, frozen); `contracts/v2-factory/`
  — `ArcOpenRailsHubV2Initializable.sol` (master logic), `ArcOpenRailsFactoryV1.sol` (ERC-1167
  clone factory). The **canonical default hub is a governance-owned clone** of the master; enterprise
  tenants can mint their own isolated clones. V2 verifies signatures via OpenZeppelin
  `SignatureChecker` (EOA + EIP-1271) with an explicit `payer` argument; EIP-712 domain version
  `2.0.0`.
- **SDK + CLI** (`sdk/`): `LeptonOpenRailsClient` (version-aware EIP-712 signing), gasless helpers
  (`payGasless`/`claimGasless`), pluggable-signer `adapters/*`, and the `openrails` CLI.
- **Keeper** (`workers/reconciliation-worker/`): a Cloudflare Worker that cron-settles active streams
  and sponsors gas for opens/claims (`/relay-open`, `/relay-claim`).
- **Cockpit** (`cockpit/`): the React/Vite product surface.

Every HTTP route across the legacy server and all 4 Cloudflare Workers — method, path, purpose,
auth model — is in one table: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md).

---

## Core mechanics

**Vault-centered security.** The SDK, cockpit, keeper, and links are convenience layers; the security
boundary is the on-chain Vault. It verifies the EIP-712 signature for the claimed `payer`, enforces
the Nonce Lane, blocks `paycardId` reuse, escrows USDC, and stores the isolated `PaycardRegistry` row.
Non-custodial: nothing but the Vault ever holds the funds.

**Smart accounts (EIP-1271).** The open path takes an explicit `payer` and verifies via
`SignatureChecker.isValidSignatureNow` — transparently accepting both EOAs (ECDSA) and contract
accounts (Circle Smart Accounts, EIP-1271). Domain separation (`verifyingContract` + version `2.0.0`)
makes cross-version replay impossible.

**RailsFlow & RailsCard.** RailsFlow is a merchant-created request the payer reviews and signs.
RailsCard is a payer-signed value link — **bearer** (first valid claimant binds, first-holder-wins) or
**recipient-bound**. Fixed-recipient envelopes cannot be redirected after signing. Both produce
links/QR encoded as URL fragments (`#or=…`) so payloads never hit HTTP servers as query strings.

**Streaming & instant settlement.** `processDripSettle` uses block clock-math so a recipient claims
exactly what's earned to the current block; `lifespanSeconds == 0` is explicit instant mode (full
release on first settle). Off-chain projections are non-authoritative; balances change only on-chain.

**STN-Delta residual recovery.** Payers over-provision (allocation = realized invoice + safety
buffer). On `flushResidualDelta`, the Vault settles accrued value first, then returns the unspent
residual to the payer's recovery address in the same transaction.

**Metadata integrity & receipts.** Every intent commits a `metadataHash` (bound to the invoice/card
terms), signed and emitted so indexers and proofs connect on-chain events to exact off-chain terms.
Receipts distinguish open, settlement, residual return, and workflow timelines.

---

## Develop

```bash
npm install
npm run compile          # Hardhat compile (viaIR)
npm run test             # Hardhat: 90 passing
npm run test:foundry     # Foundry fuzz/invariant: 9 passing
npm run build:sdk        # tsc build of the SDK + CLI
npm --prefix cockpit run build
```

**Deploy V2 to a network** (`scripts/deploy-v2-core.ts`): deploys master → factory → a
governance-owned canonical clone and writes an address registry. Requires `.env` (see `.env.example`)
with `ARC_USDC_ADDRESS` + a funded `DEPLOYER_PRIVATE_KEY`. Note: on Arc the deploy script's
governance signer path assumes `governance == deployer`; a separate governance multisig needs a
key env or a deploy-then-`transferOwnership` handoff (tracked for mainnet).

---

## Limitations & honesty

- **Testnet, unaudited, test funds only.** Not production software; do not handle non-demo funds.
- Non-custodial and bounded by design — but a mainnet **audit** is the gate before real value.
- **Bearer RailsCard** links are first-holder-wins until claimed; treat unclaimed links as sensitive.
- On Arc, USDC is the native gas token — a USDC holder inherently has gas; `transferFrom` cannot move
  a holder's *entire* balance, so over-fund the payer.
- The legacy Express server (`server/index.ts`) and dashboard remain on V1 and are superseded by the
  cockpit + keeper + SDK path.
- Never commit secrets, private keys, private RPC URLs, or local registry files (`.env`,
  `.bot-wallets/`, and `deployments/*.local.json` are gitignored).

---

**OpenRails** // *Intent-driven clearing & settlement infrastructure for streamed work on Arc.*
