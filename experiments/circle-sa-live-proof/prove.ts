/**
 * Real Circle-Smart-Account-style EIP-1271 proof against the LIVE OpenRails V2 Hub on Arc
 * testnet — not the local Hardhat mock (`test/CircleAdapter.test.ts` / `MockERC1271Account`).
 *
 * Deploys `MinimalSmartAccountV1` (an owner-gated EIP-1271 wallet — same verification shape a
 * Circle Smart Account uses) for real, funds it with a small amount of the operator wallet's own
 * testnet USDC, has the smart account approve the Hub, signs a SettlementIntent as the smart
 * account (via `circleToAccount`, `isSmartAccount: true`), and submits a real
 * `openPaycardChannel` + `processDripSettle` against the live V2 Hub. Prints real tx hashes.
 *
 *   OPENRAILS_LIVE_PROOF_OPERATOR_KEY=0x... npx ts-node experiments/circle-sa-live-proof/prove.ts
 *
 * The operator key only needs to be a funded Arc testnet EOA (gas + a little USDC to seed the
 * smart account) — the `.bot-wallets/wallets.json` pool already has funded wallets from prior
 * experiments.
 */
import { ethers } from "ethers";
import { circleToAccount, type CircleLikeSmartAccount } from "../../sdk/src/adapters/circle";
import { LeptonOpenRailsClient, type OpenRailsIntentV1 } from "../../sdk/src/client";
import {
  assertOpenRailsNetwork,
  readNonce,
  readPaycard,
  readTokenBalance,
  submitOpenPaycardWithSigner,
  submitSettleWithSigner,
} from "../../sdk/src/wallet";

const RPC_URL = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID || "5042002");
const HUB = process.env.ARC_OPENRAILS_HUB_ADDRESS || "0x941C8029F0f912df3fAb7423890ab2359b996D0b";
const USDC = process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
const EXPLORER = "https://testnet.arcscan.app";

// Compiled artifact — populated by `npm run compile` (contracts/v2-factory/proof/MinimalSmartAccountV1.sol).
const artifact = require("../../artifacts/contracts/v2-factory/proof/MinimalSmartAccountV1.sol/MinimalSmartAccountV1.json");

function fail(message: string): never {
  console.error(`\n[circle-sa-live-proof] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const operatorKey = process.env.OPENRAILS_LIVE_PROOF_OPERATOR_KEY;
  if (!operatorKey) fail("Set OPENRAILS_LIVE_PROOF_OPERATOR_KEY to a funded Arc testnet private key.");

  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  await assertOpenRailsNetwork(provider, CHAIN_ID);

  const operator = new ethers.Wallet(operatorKey, provider);
  console.log(`Operator (gas payer + smart-account owner): ${operator.address}`);

  const operatorUsdc = await readTokenBalance(provider, USDC, operator.address);
  console.log(`Operator USDC balance: ${ethers.formatUnits(operatorUsdc, 6)}`);
  const seedAmount = ethers.parseUnits("0.01", 6); // 10000 base units — trivial real economic footprint
  if (operatorUsdc < seedAmount * 2n) fail("Operator wallet needs at least ~0.02 USDC on Arc testnet.");

  // ---- 1. Deploy the smart account for real ----
  console.log("\n[1/6] Deploying MinimalSmartAccountV1...");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, operator);
  const smartAccount = await factory.deploy(operator.address);
  await smartAccount.waitForDeployment();
  const smartAccountAddress = await smartAccount.getAddress();
  console.log(`  Deployed: ${smartAccountAddress} (${EXPLORER}/address/${smartAccountAddress})`);
  console.log(`  Deploy tx: ${EXPLORER}/tx/${smartAccount.deploymentTransaction()?.hash}`);

  // ---- 2. Seed the smart account with a little of the operator's own USDC ----
  console.log("\n[2/6] Seeding smart account with USDC...");
  const usdcAbi = ["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
  const usdc = new ethers.Contract(USDC, usdcAbi, operator);
  const seedTx = await usdc.transfer(smartAccountAddress, seedAmount);
  await seedTx.wait();
  console.log(`  Seeded ${ethers.formatUnits(seedAmount, 6)} USDC. tx: ${EXPLORER}/tx/${seedTx.hash}`);

  // ---- 3. Smart account approves the Hub (owner-gated call, real tx) ----
  console.log("\n[3/6] Smart account approving the V2 Hub for USDC pull...");
  const allocation = ethers.parseUnits("0.001", 6); // 1000 base units — the actual open amount
  const approveTx = await (smartAccount as any).approveToken(USDC, HUB, allocation);
  await approveTx.wait();
  console.log(`  Approved. tx: ${EXPLORER}/tx/${approveTx.hash}`);

  // ---- 4. Sign the SettlementIntent AS the smart account (EIP-1271 path) ----
  console.log("\n[4/6] Signing SettlementIntent via circleToAccount (isSmartAccount: true)...");
  // circleToAccount expects a viem-shaped signTypedData({domain,types,primaryType,message}); wire
  // it straight to the operator EOA's own signTypedData — this IS the real EIP-1271 pattern: the
  // smart account's owner key produces the signature, the smart account's isValidSignature
  // verifies it recovers to that owner.
  const circleClient: CircleLikeSmartAccount = {
    address: smartAccountAddress,
    async signTypedData({ domain, types, message }) {
      const { EIP712Domain: _EIP712Domain, ...cleanTypes } = types;
      return operator.signTypedData(domain, cleanTypes, message);
    },
  };
  const account = circleToAccount(circleClient);

  const client = await LeptonOpenRailsClient.fromAccount(account, HUB, CHAIN_ID);
  if (client.getAddress() !== smartAccountAddress) fail("client payer address mismatch");

  const recipient = ethers.Wallet.createRandom().address; // fresh recipient, unambiguous proof
  const paycardId = ethers.keccak256(ethers.toUtf8Bytes(`circle-sa-live-proof:${Date.now()}`));
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("circle-sa-live-proof"));
  const nonceValue = await readNonce(provider, HUB, smartAccountAddress, 0);

  const intent: OpenRailsIntentV1 = {
    paycardId,
    metadataHash,
    recipient,
    totalAllocationPool: allocation.toString(),
    flowVelocityPerSecond: "0",
    genesisTimestamp: Math.floor(Date.now() / 1000),
    lifespanSeconds: 0, // instant/one-time mode
    residualDeltaRecipient: smartAccountAddress,
    nonceChannel: 0,
    nonceValue,
  };
  const envelopeToken = await client.signPermissionEnvelope(intent, { mode: "railsflow" });
  console.log(`  Signed. payer=${smartAccountAddress} recipient=${recipient} paycardId=${paycardId}`);

  // ---- 5. Submit the real openPaycardChannel tx against the live V2 Hub ----
  console.log("\n[5/6] Submitting openPaycardChannel to the live V2 Hub...");
  const openTx = await submitOpenPaycardWithSigner(operator, HUB, envelopeToken);
  const openReceipt = await openTx.wait();
  console.log(`  OPEN tx: ${EXPLORER}/tx/${openTx.hash} (block ${openReceipt?.blockNumber})`);

  const opened = await readPaycard(provider, HUB, paycardId);
  console.log(`  Registry row: payer=${opened.payer} recipient=${opened.recipient} status=${opened.operationalStatus}`);
  if (opened.payer.toLowerCase() !== smartAccountAddress.toLowerCase()) {
    fail(`Registry payer mismatch: expected ${smartAccountAddress}, got ${opened.payer}`);
  }

  // ---- 6. Settle it (permissionless — proves the recipient actually receives funds) ----
  console.log("\n[6/6] Settling (processDripSettle)...");
  const settleTx = await submitSettleWithSigner(operator, HUB, paycardId);
  const settleReceipt = await settleTx.wait();
  console.log(`  SETTLE tx: ${EXPLORER}/tx/${settleTx.hash} (block ${settleReceipt?.blockNumber})`);

  const recipientBalance = await readTokenBalance(provider, USDC, recipient);
  console.log(`  Recipient USDC balance after settle: ${ethers.formatUnits(recipientBalance, 6)}`);
  if (recipientBalance !== allocation) fail(`Recipient balance mismatch: expected ${allocation}, got ${recipientBalance}`);

  console.log("\n[circle-sa-live-proof] PASS — real EIP-1271 smart-account open + settle against the live V2 Hub.");
  console.log(
    JSON.stringify(
      {
        smartAccountAddress,
        owner: operator.address,
        recipient,
        paycardId,
        deployTxHash: smartAccount.deploymentTransaction()?.hash,
        openTxHash: openTx.hash,
        settleTxHash: settleTx.hash,
        explorer: EXPLORER,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));
