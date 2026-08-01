# OpenRails on GIWA

> **Commerce is becoming programmable. Its authority should be too.**

**OpenRails is the control, agreement, and settlement plane for programmable commerce on GIWA.**

OpenRails lets people, organisations, applications, and agents act and transact under explicit ownership, delegated authority, commercial terms, financial limits, verifiable evidence, and accountable settlement.

```text
Ownership → Delegation → Agreement → Execution → Verification → Settlement → Resolution
```

```text
Workspace → Path → Baphomet → Pact → Proof → Paycard / Vault → Gaia
```

OpenRails is not a wallet, autonomous custodian, or generic agent framework. The OpenRails Runtime prepares, evaluates, verifies, and records. The connected wallet remains the authorization boundary, while the deployed Vault remains the canonical onchain financial state.

---

## Product lifecycle

| Stage | Primitive | Responsibility |
| :--- | :--- | :--- |
| **Own** | **Workspace** | Establishes who owns an activity and its durable authority domain. |
| **Authorise** | **Path** | Defines what an actor or agent may do, with which assets, counterparties, limits, and duration. |
| **Evaluate** | **Baphomet Policy Engine** | Evaluates a proposal against the active signed Path and records `ALLOW` or `BLOCK`. |
| **Commit** | **Pact** | Binds an allowed proposal into immutable commercial and payment terms. |
| **Prove** | **Proof** | Attaches signed checkpoints and canonical evidence to Pact milestones. |
| **Settle** | **RailsFlow / RailsCard + Paycard / Vault** | Opens, meters, and settles value under the signed allocation. |
| **Resolve** | **Gaia** | Preserves and rectifies exceptional outcomes when the normal lifecycle cannot continue. |

Supporting primitives include **STN-Delta** for earned and residual value routing, **Nonce Lanes** for replay-safe concurrent activity, and metadata-bound receipts that connect offchain decisions to exact onchain state.

### OpenRails Runtime

The product-facing runtime is the **OpenRails Runtime**. Its technical architecture is the **BNH Runtime**, with the **Baphomet Policy Engine** as its featured policy component.

The Runtime:

- evaluates bounded proposals;
- records allowed and blocked outcomes;
- coordinates wallet-confirmed actions;
- tracks Pact and Proof state;
- verifies canonical GIWA receipts and Vault state;
- advances lifecycle state only after exact evidence matching;
- routes exceptional outcomes toward Gaia.

Baphomet emits only `ALLOW` or `BLOCK`. An allowed decision does not itself authorize payment: financial actions still require wallet confirmation.

---

## GIWA GASOK product surface

The fresh GIWA web application lives at [`apps/gasok-web`](apps/gasok-web).

| Route | Surface |
| :--- | :--- |
| `/` | Narrative product experience and lifecycle introduction. |
| `/system` | OpenRails System Lab with Live Run and deterministic Recorded Run modes. |
| `/network` | GIWA deployment evidence, balances, faucet, contracts, Vault state, and receipts. |
| `/build` | Runtime architecture, SDK, MCP, schemas, and integration boundaries. |
| `/docs` | Product and technical operating manual. |

Legacy network-specific implementations remain for migration history and compatibility. They are **not** the canonical GIWA product surface.

### Live Run

The System Lab can execute one bounded, wallet-confirmed GIWA Sepolia lifecycle:

```text
Connect wallet
→ establish Workspace authority
→ register an Agent and activate a Path
→ submit a 420 orUSD proposal
→ Baphomet ALLOW
→ sign a Pact
→ open a canonical Paycard on GIWA
→ verify the opening receipt
→ approve an activation Proof
→ settle after the accelerated earning window
→ verify final GIWA state
```

A negative control submits `1,420 orUSD` against a `1,000 orUSD` Path ceiling. The expected result is:

```text
Baphomet result = BLOCK
Pact formed = false
Financial effect = none
Wallet transaction requested = false
```

### Recorded Run

The System Lab also contains a deterministic, read-only **Recorded Run** based on a previously completed wallet-confirmed GIWA lifecycle. It is designed for reproducible review and demo recording without depending on fresh wallet popups, RPC timing, or transaction propagation.

Evidence is labelled at the value level:

- `LIVE ON GIWA` — current RPC, contract, balance, Vault, Paycard, or receipt state;
- `RECORDED` — previously observed Runtime or testnet evidence;
- `DEMONSTRATION` — curated explanatory state that is not represented as a live onchain object.

---

## Live GIWA Sepolia deployment

> Testnet only. `orUSD` is an OpenRails test settlement token. It is not USDC and must not be represented as production USD.

| Component | Value |
| :--- | :--- |
| Network | GIWA Sepolia |
| Chain ID | `91342` |
| Standard RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |
| orUSD | [`0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De`](https://sepolia-explorer.giwa.io/address/0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De) |
| Master implementation | [`0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb`](https://sepolia-explorer.giwa.io/address/0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb) |
| Factory | [`0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d`](https://sepolia-explorer.giwa.io/address/0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d) |
| Canonical Vault | [`0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1`](https://sepolia-explorer.giwa.io/address/0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1) |
| Bounded orUSD faucet | [`0x86567D16324dB05CABF7c3c4E81cD07F7765a8A4`](https://sepolia-explorer.giwa.io/address/0x86567D16324dB05CABF7c3c4E81cD07F7765a8A4) |

The faucet distributes `1,000 orUSD` per eligible claim with a 24-hour cooldown. It has no mint authority and can distribute only its prefunded reserve.

Canonical registries:

- [`deployments/giwa-sepolia.json`](deployments/giwa-sepolia.json)
- [`deployments/giwa-orusd-faucet.json`](deployments/giwa-orusd-faucet.json)

---

## Authorization and trust boundary

```text
OpenRails Runtime
prepares · evaluates · verifies · records
                ↓
Connected wallet
signs typed data · approves tokens · broadcasts transactions
                ↓
GIWA Sepolia
finalises transactions and emits canonical receipts
                ↓
OpenRails Vault
holds and enforces canonical financial state
```

Security-critical properties:

- The Runtime does not receive, store, or use user private keys.
- The Runtime does not autonomously approve tokens, sign payment intents, or broadcast financial transactions.
- Workspace commands, Paths, Pacts, and Proof checkpoints are signed, expiring, and nonce-protected where required.
- Proposal policy is re-evaluated immediately before Pact creation.
- Pact payer, recipient, residual recipient, terms, and Paycard binding cannot be silently replaced by adapters.
- Proof checkpoints are monotonic and bound to immutable Pact terms.
- Financial lifecycle state advances only after exact GIWA receipt and live Vault-state verification.
- The Vault, not an indexer or UI projection, is the settlement source of truth.

See:

- [`agent-kernel/SECURITY.md`](agent-kernel/SECURITY.md)
- [`docs/GIWA_AGENT_KERNEL_TRUST_MODEL.md`](docs/GIWA_AGENT_KERNEL_TRUST_MODEL.md)
- [`docs/GIWA_AGENT_KERNEL_ARCHITECTURE.md`](docs/GIWA_AGENT_KERNEL_ARCHITECTURE.md)

---

## Repository structure

```text
apps/gasok-web/                  GIWA product web and System Lab
agent-kernel/                    Workspace, Path, Pact, Proof, Baphomet and Gaia runtime
contracts/                       OpenRails settlement contracts
contracts/giwa/                  GIWA bounded faucet
contracts/v2-factory/            Chain-neutral V2 master and factory
sdk/                             GIWA configuration and unsigned draft preparation
mcp/                             Safe read-and-prepare MCP tools
packages/openrails-design-system Shared visual tokens and design primitives
deployments/                     Canonical GIWA deployment registries
docs/                            Architecture, trust model, runbooks, and product specifications
cockpit/                         Legacy compatibility surface; not the GIWA application
```

---

## Run the GIWA product locally

Requirements:

- Node.js 20+
- npm
- a browser wallet for Live Run
- GIWA Sepolia native ETH for gas
- test-only orUSD for financial actions

Install:

```bash
npm install
npm --prefix agent-kernel install
npm --prefix apps/gasok-web install
```

Start the product web and same-origin Runtime API:

```bash
npm --prefix apps/gasok-web run dev
```

Open the Vite URL shown in the terminal and visit `/system`.

- Select **RECORDED RUN** for deterministic review or demo recording.
- Select **LIVE RUN** for the bounded wallet-confirmed lifecycle on GIWA Sepolia.

Production build:

```bash
npm --prefix apps/gasok-web run build
```

---

## Verification commands

```bash
npm run compile
npm run test
npm run build:sdk
npm run build:mcp
npm run smoke:mcp
npm run test:agent-kernel
npm run verify:giwa-agent-kernel
npm run check:giwa
npm run verify:giwa
npm run verify:giwa-faucet
npm --prefix apps/gasok-web run build
```

The v5.4 release candidate recorded:

- Agent Kernel: `25/25` tests passing;
- production GIWA web build passing;
- Live Run and Recorded Run preserved;
- a completed 420 orUSD lifecycle on GIWA Sepolia with canonical opening, Proof, settlement, and finality evidence.

These are release records, not a substitute for rerunning the commands in a fresh environment.

---

## SDK, MCP, and Midium

The GIWA SDK provides canonical network metadata, deployed addresses, unsigned bounded RailsFlow drafts, metadata-bound Paycard IDs, EIP-712 typed-data output, approval requirements, and projected stream economics.

The MCP surface is deliberately safe and non-custodial. It exposes read-and-prepare tools while rejecting private-key custody, signing, and autonomous broadcasting.

**Midium** is the conversational Telegram agent interface built alongside OpenRails. Midium reads GIWA state, turns a user request into bounded human-readable terms, and hands the exact authorization to the user's wallet. OpenRails supplies the authority, agreement, and financial enforcement underneath it.

```text
User → Midium → OpenRails Runtime → Wallet confirmation → GIWA settlement
```

Midium source: [`cooke-dev/gaymused-agent`](https://github.com/cooke-dev/gaymused-agent)

---

## Current scope

Shipped in the GIWA release candidate:

- live GIWA Sepolia V2 settlement deployment;
- test-only orUSD and bounded faucet;
- Workspace and Agent registration;
- signed and versioned Paths;
- `ALLOW` / `BLOCK` Baphomet evaluation;
- immutable proposal-bound Pacts;
- signed activation Proof checkpoints;
- canonical Paycard opening and settlement verification;
- settlement recovery and refresh-safe lifecycle restoration;
- Recorded Run fixture and System Lab;
- safe SDK and MCP preparation surfaces;
- product, network, build, and documentation routes.

Deferred or intentionally limited:

- production mainnet deployment;
- third-party smart-contract audit;
- production identity providers;
- arbitrary commercial Proof schemas;
- generalized multi-party signing;
- operational Gaia adjudication in the live vertical slice;
- autonomous wallet execution;
- mobile Midium signing without a public HTTPS handoff;
- PostgreSQL-backed production Runtime persistence;
- use of real-value assets.

---

## Product definition

> **OpenRails on GIWA is programmable infrastructure for coordinating authority, agreements, evidence, and settlement.**

```text
OWN → AUTHORISE → COMMIT → PROVE → SETTLE → RESOLVE
```

**OpenRails on GIWA** — from delegated authority to accountable settlement.
