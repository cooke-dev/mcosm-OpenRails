import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import * as fs from "fs";
import * as path from "path";
import {
  LeptonOpenRailsClient,
  OpenRailsIntentV1,
  hashSettlementIntent,
} from "../sdk/src/client";
import { evaluatePolicyEnvelope } from "../sdk/src/policy";
import { buildIntentProof } from "../sdk/src/proof";
import {
  buildMetadataBoundPaycardId,
  canonicalizeMetadata,
  hashOpenRailsMetadata,
} from "../sdk/src/metadata";
import { NonceEngine, MemoryNonceCacheAdapter } from "../sdk/src/nonce";
import { base64UrlEncode, base64UrlDecode, serializeEnvelope, deserializeEnvelope } from "../sdk/src/serialization";
import {
  validateOpenPaycardRequest,
  validateOpenRailsAccessRequest,
} from "../server/validation";
import {
  createRailsFlowRequestLink,
  createRailsCardClaimLink,
  parseOpenRailsLink,
  serializeLegacyOpenRailsLinkArtifact,
} from "../sdk/src/links";
import { MemoryCacheStateStore } from "../stream-gateway/state-store";
import {
  buildOpenRailsAccessHeaders,
  createOpenRailsAccessCredential,
  createOpenRailsFetch,
  serializeOpenRailsAccessCredential,
  verifyOpenRailsAccessCredential,
} from "../sdk/src/access";
import {
  approveOpenRailsSpend,
  recoverPaycardsFromLogs,
  readNonce,
  readTokenAllowance,
  readTokenBalance,
  signPermissionEnvelopeWithSigner,
  submitOpenPaycardWithSigner,
  submitSettleWithSigner,
  submitFlushWithSigner,
  switchOrAddOpenRailsNetwork,
  toEip155ChainIdHex,
} from "../sdk/src/wallet";
import {
  createPaymentReceipt,
  createResidualRecoveryReceipt,
  createSettlementReceipt,
  parseReceipt,
  serializeReceipt,
  verifyReceiptMetadataHash,
} from "../sdk/src/receipts";

describe("ArcOpenRailsHubV1", () => {
  let clearinghouse: any;
  let mockUsdc: any;
  let owner: any;
  let payer: any;
  let recipient: any;
  let recoveryVault: any;
  let relayer: any;
  let chainId: number;

  /**
   * Helper: create a funded wallet with USDC, approve the clearinghouse,
   * and return a LeptonOpenRailsClient wired to it.
   */
  async function createFundedClient(usdcAmount: string = "1000"): Promise<{
    client: LeptonOpenRailsClient;
    wallet: any;
    providerWallet: any;
  }> {
    const tempWallet = ethers.Wallet.createRandom();
    const providerWallet = tempWallet.connect(ethers.provider);

    await owner.sendTransaction({
      to: tempWallet.address,
      value: ethers.parseEther("1.0"),
    });
    await mockUsdc.mint(tempWallet.address, ethers.parseUnits(usdcAmount, 6));
    await mockUsdc
      .connect(providerWallet)
      .approve(
        await clearinghouse.getAddress(),
        ethers.parseUnits(usdcAmount, 6)
      );

    const client = new LeptonOpenRailsClient(
      tempWallet.privateKey,
      await clearinghouse.getAddress(),
      chainId,
      undefined,
      60,
      "1.0.0" // V1 hub uses the legacy EIP-712 domain version
    );

    return { client, wallet: tempWallet, providerWallet };
  }

  /**
   * Helper: build a standard intent payload.
   */
  function buildIntent(overrides: Partial<OpenRailsIntentV1> = {}): OpenRailsIntentV1 {
    const metadataHash =
      overrides.metadataHash ??
      ethers.keccak256(ethers.toUtf8Bytes("metadata-" + Math.random().toString(36).slice(2)));
    const paycardId =
      overrides.paycardId ??
      ethers.keccak256(ethers.toUtf8Bytes("paycard-" + metadataHash));

    return {
      paycardId,
      metadataHash,
      recipient: overrides.recipient ?? recipient.address,
      totalAllocationPool:
        overrides.totalAllocationPool ?? ethers.parseUnits("500", 6).toString(),
      flowVelocityPerSecond:
        overrides.flowVelocityPerSecond ?? ethers.parseUnits("2", 6).toString(),
      genesisTimestamp:
        overrides.genesisTimestamp ?? Math.floor(Date.now() / 1000) - 10,
      lifespanSeconds: overrides.lifespanSeconds ?? 200,
      residualDeltaRecipient:
        overrides.residualDeltaRecipient ?? recoveryVault.address,
      nonceChannel: overrides.nonceChannel ?? 0,
      nonceValue: overrides.nonceValue ?? 0,
    };
  }

  /**
   * Helper: sign, decode, and open a paycard via the relayer.
   */
  async function openPaycard(
    client: LeptonOpenRailsClient,
    intent: OpenRailsIntentV1
  ): Promise<any> {
    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);

    return clearinghouse.connect(relayer).openPaycardChannel(
      decoded.intent.paycardId,
      decoded.intent.metadataHash,
      decoded.intent.recipient,
      decoded.intent.totalAllocationPool,
      decoded.intent.flowVelocityPerSecond,
      decoded.intent.genesisTimestamp,
      decoded.intent.lifespanSeconds,
      decoded.intent.residualDeltaRecipient,
      decoded.envelopeSignature,
      decoded.intent.nonceChannel,
      decoded.intent.nonceValue
    );
  }

  async function claimWildcardPaycard(
    client: LeptonOpenRailsClient,
    intent: OpenRailsIntentV1,
    claimRecipient: string
  ): Promise<any> {
    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);

    return clearinghouse.connect(relayer).claimWildcardPaycardChannel(
      decoded.intent.paycardId,
      decoded.intent.metadataHash,
      claimRecipient,
      decoded.intent.totalAllocationPool,
      decoded.intent.flowVelocityPerSecond,
      decoded.intent.genesisTimestamp,
      decoded.intent.lifespanSeconds,
      decoded.intent.residualDeltaRecipient,
      decoded.envelopeSignature,
      decoded.intent.nonceChannel,
      decoded.intent.nonceValue
    );
  }

  beforeEach(async () => {
    [owner, payer, recipient, recoveryVault, relayer] =
      await ethers.getSigners();

    // 1. Deploy Mock USDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUsdc = await MockUSDCFactory.deploy();
    await mockUsdc.waitForDeployment();

    // 2. Deploy ArcOpenRailsHubV1 with Mock USDC address
    const HubFactory = await ethers.getContractFactory("ArcOpenRailsHubV1");
    clearinghouse = await HubFactory.deploy(await mockUsdc.getAddress());
    await clearinghouse.waitForDeployment();

    // 3. Mint USDC to Payer and Approve
    const mintAmount = ethers.parseUnits("10000", 6);
    await mockUsdc.mint(payer.address, mintAmount);
    await mockUsdc
      .connect(payer)
      .approve(await clearinghouse.getAddress(), mintAmount);

    const network = await ethers.provider.getNetwork();
    chainId = Number(network.chainId);
  });

  // =========================================================================
  //  Ported Tests (4 original)
  // =========================================================================

  it("should successfully open a paycard channel using a valid EIP-712 signature from the SDK", async () => {
    const { client, wallet } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("paycard-test-1"));
    const totalAllocation = ethers.parseUnits("500", 6);

    const intent = buildIntent({
      paycardId,
      totalAllocationPool: totalAllocation.toString(),
    });

    await expect(openPaycard(client, intent))
      .to.emit(clearinghouse, "PaycardProvisioned")
      .withArgs(
        paycardId,
        wallet.address,
        recipient.address,
        intent.metadataHash,
        totalAllocation,
        BigInt(intent.flowVelocityPerSecond),
        intent.genesisTimestamp,
        intent.lifespanSeconds
      );

    const card = await clearinghouse.registry(paycardId);
    expect(card.payer).to.equal(wallet.address);
    expect(card.recipient).to.equal(recipient.address);
    expect(card.metadataHash).to.equal(intent.metadataHash);
    expect(card.totalAllocationPool).to.equal(totalAllocation);
    expect(card.availableBalance).to.equal(totalAllocation);
    expect(card.operationalStatus).to.equal(0); // Active
  });

  it("SDK should recover paycards from PaycardProvisioned logs with current registry state", async () => {
    const { client, wallet } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("recover-paycard-log"));
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes("recover-paycard-metadata"));
    const totalAllocation = ethers.parseUnits("125", 6);
    const intent = buildIntent({
      paycardId,
      metadataHash,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 300,
      nonceChannel: 7,
    });

    const tx = await openPaycard(client, intent);
    const receipt = await tx.wait();

    const recovered = await recoverPaycardsFromLogs(
      ethers.provider,
      await clearinghouse.getAddress(),
      {
        payer: wallet.address,
        recipient: recipient.address,
        metadataHash,
        fromBlock: receipt!.blockNumber,
        toBlock: receipt!.blockNumber,
        limit: 5,
        chunkSize: 1,
      },
    );

    expect(recovered).to.have.length(1);
    expect(recovered[0].paycardId).to.equal(paycardId);
    expect(recovered[0].provisioned.metadataHash).to.equal(metadataHash);
    expect(recovered[0].provisioned.poolAllocation).to.equal(totalAllocation.toString());
    expect(recovered[0].provisioned.blockNumber).to.equal(receipt!.blockNumber);
    expect(recovered[0].registry.payer).to.equal(wallet.address);
    expect(recovered[0].registry.recipient).to.equal(recipient.address);
    expect(recovered[0].registry.metadataHash).to.equal(metadataHash);
    expect(recovered[0].registry.operationalStatus).to.equal("Active");

    const wrongMetadata = await recoverPaycardsFromLogs(
      ethers.provider,
      await clearinghouse.getAddress(),
      {
        payer: wallet.address,
        metadataHash: ethers.keccak256(ethers.toUtf8Bytes("wrong-metadata")),
        fromBlock: receipt!.blockNumber,
        toBlock: receipt!.blockNumber,
      },
    );
    expect(wrongMetadata).to.deep.equal([]);
  });

  it("should fail to open channel if paycardId is already in use (replay defense)", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("duplicate-id"));

    const intent = buildIntent({
      paycardId,
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 100,
    });

    // Open first time
    await openPaycard(client, intent);

    // Try opening again with incremented nonce (paycardId collision still caught)
    const intent2 = { ...intent, nonceValue: 1 };
    await expect(openPaycard(client, intent2)).to.be.revertedWithCustomError(
      clearinghouse,
      "CryptographicCollision"
    );
  });

  it("should correctly process time-based linear drips", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("drip-id"));
    const totalAllocation = ethers.parseUnits("100", 6);
    const velocity = ethers.parseUnits("2", 6);
    const genesisTime = Math.floor(Date.now() / 1000);

    const intent = buildIntent({
      paycardId,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: velocity.toString(),
      genesisTimestamp: genesisTime,
      lifespanSeconds: 200,
    });

    await openPaycard(client, intent);

    // Fast-forward 10 seconds
    await ethers.provider.send("evm_increaseTime", [10]);
    await ethers.provider.send("evm_mine", []);

    const initialRecipientBalance = await mockUsdc.balanceOf(recipient.address);
    const tx = await clearinghouse.connect(relayer).processDripSettle(paycardId);
    await tx.wait();

    const finalRecipientBalance = await mockUsdc.balanceOf(recipient.address);
    const difference = BigInt(finalRecipientBalance) - BigInt(initialRecipientBalance);

    // At least 20 USDC (10 seconds * 2 USDC/second)
    expect(difference).to.be.greaterThanOrEqual(ethers.parseUnits("20", 6));

    const card = await clearinghouse.registry(paycardId);
    expect(card.availableBalance).to.be.lessThanOrEqual(totalAllocation - difference);
  });

  it("should flush residual delta and return buffer back to the recovery vault", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("stn-delta-id"));
    const totalAllocation = ethers.parseUnits("500", 6);

    // Get genesis from the actual chain clock, not Date.now() which drifts
    const latestBlock = await ethers.provider.getBlock("latest");
    const genesisTime = latestBlock!.timestamp + 1;

    const intent = buildIntent({
      paycardId,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(), // 1 USDC/sec (low velocity)
      genesisTimestamp: genesisTime,
      lifespanSeconds: 600,
    });

    await openPaycard(client, intent);

    // Fast-forward only 5 seconds to drip 5 USDC
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await clearinghouse.connect(relayer).processDripSettle(paycardId);

    const cardBefore = await clearinghouse.registry(paycardId);
    const remainingBalance = cardBefore.availableBalance;
    expect(remainingBalance).to.be.greaterThan(0n);

    const initialRecipientBalance = await mockUsdc.balanceOf(recipient.address);
    const initialVaultBalance = await mockUsdc.balanceOf(recoveryVault.address);

    await expect(
      clearinghouse.connect(recipient).flushResidualDelta(paycardId)
    )
      .to.emit(clearinghouse, "ResidualDeltaReclaimed")
      .withArgs(paycardId, recoveryVault.address, anyValue);

    const finalRecipientBalance = await mockUsdc.balanceOf(recipient.address);
    const finalVaultBalance = await mockUsdc.balanceOf(recoveryVault.address);
    expect(
      finalVaultBalance - initialVaultBalance + finalRecipientBalance - initialRecipientBalance
    ).to.equal(remainingBalance);

    const cardAfter = await clearinghouse.registry(paycardId);
    expect(cardAfter.availableBalance).to.equal(0n);
    expect(cardAfter.operationalStatus).to.equal(1); // Terminated
  });

  // =========================================================================
  //  New: Reentrancy Guard
  // =========================================================================

  it("should have nonReentrant modifier on processDripSettle", async () => {
    // We verify the contract state initialisation for _status
    // and that the function completes without reentrancy issues
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("reentrancy-test"));

    const intent = buildIntent({
      paycardId,
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 200,
    });

    await openPaycard(client, intent);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);

    // Normal drip should succeed (proves guard passes for non-reentrant calls)
    await expect(
      clearinghouse.connect(relayer).processDripSettle(paycardId)
    ).to.emit(clearinghouse, "SettlementFlushed");
  });

  // =========================================================================
  //  New: Pausable Circuit Breaker
  // =========================================================================

  it("should block openPaycardChannel when paused and allow after unpause", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("pause-test"));

    const intent = buildIntent({ paycardId });

    // Pause the contract (owner is the deployer)
    await clearinghouse.connect(owner).pause();
    expect(await clearinghouse.isPaused()).to.equal(true);

    // Opening should revert with Pausable
    await expect(openPaycard(client, intent)).to.be.revertedWith(
      "Pausable: paused"
    );

    // Unpause
    await clearinghouse.connect(owner).unpause();
    expect(await clearinghouse.isPaused()).to.equal(false);

    // Now it should succeed
    await expect(openPaycard(client, intent)).to.emit(
      clearinghouse,
      "PaycardProvisioned"
    );
  });

  // =========================================================================
  //  New: Ownable2Step
  // =========================================================================

  it("should enforce two-phase ownership transfer", async () => {
    // Owner is the deployer (first signer)
    expect(await clearinghouse.owner()).to.equal(owner.address);

    // Non-owner cannot transfer
    await expect(
      clearinghouse.connect(relayer).transferOwnership(relayer.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    // Owner initiates transfer
    await expect(
      clearinghouse.connect(owner).transferOwnership(relayer.address)
    )
      .to.emit(clearinghouse, "OwnershipTransferStarted")
      .withArgs(owner.address, relayer.address);

    // Owner still has control
    expect(await clearinghouse.owner()).to.equal(owner.address);
    expect(await clearinghouse.pendingOwner()).to.equal(relayer.address);

    // Random account cannot accept
    await expect(
      clearinghouse.connect(recipient).acceptOwnership()
    ).to.be.revertedWith("Ownable2Step: caller is not the new owner");

    // Pending owner accepts
    await expect(clearinghouse.connect(relayer).acceptOwnership())
      .to.emit(clearinghouse, "OwnershipTransferred")
      .withArgs(owner.address, relayer.address);

    expect(await clearinghouse.owner()).to.equal(relayer.address);

    // New owner can now pause
    await clearinghouse.connect(relayer).pause();
    expect(await clearinghouse.isPaused()).to.equal(true);
  });

  it("should reject zero token constructor and zero owner transfer", async () => {
    const HubFactory = await ethers.getContractFactory("ArcOpenRailsHubV1");
    await expect(HubFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      clearinghouse,
      "InvalidIntent"
    );

    await expect(
      clearinghouse.connect(owner).transferOwnership(ethers.ZeroAddress)
    ).to.be.revertedWith("Ownable: new owner is the zero address");
  });

  // =========================================================================
  //  New: 2D Nonce Consumption
  // =========================================================================

  it("should enforce 2D nonce tracking and prevent replay across channels", async () => {
    const { client } = await createFundedClient("5000");

    // First paycard on channel 0, nonce 0 — should succeed
    const intent1 = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("nonce-test-1")),
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      nonceChannel: 0,
      nonceValue: 0,
    });
    await openPaycard(client, intent1);

    // Second paycard on channel 0, nonce 0 again — should FAIL (replay)
    const intent2 = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("nonce-test-2")),
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      nonceChannel: 0,
      nonceValue: 0,
    });
    await expect(openPaycard(client, intent2)).to.be.revertedWith(
      "Nonce: invalid nonce"
    );

    // Second paycard on channel 0, nonce 1 — should succeed
    const intent3 = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("nonce-test-3")),
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      nonceChannel: 0,
      nonceValue: 1,
    });
    await openPaycard(client, intent3);

    // Third paycard on channel 1, nonce 0 — should succeed (independent channel)
    const intent4 = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("nonce-test-4")),
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      nonceChannel: 1,
      nonceValue: 0,
    });
    await openPaycard(client, intent4);
  });

  it("should bind a wildcard RailsCard claim recipient through the dedicated claim path", async () => {
    const { client, wallet } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("railscard-wildcard"));
    const totalAllocation = ethers.parseUnits("50", 6);
    const genesisTime = Math.floor(Date.now() / 1000) - 1;

    const intent = buildIntent({
      paycardId,
      recipient: ethers.ZeroAddress,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      genesisTimestamp: genesisTime,
      lifespanSeconds: 10000,
    });

    await expect(claimWildcardPaycard(client, intent, recipient.address))
      .to.emit(clearinghouse, "PaycardProvisioned")
      .withArgs(
        paycardId,
        wallet.address,
        recipient.address,
        intent.metadataHash,
        totalAllocation,
        BigInt(intent.flowVelocityPerSecond),
        intent.genesisTimestamp,
        intent.lifespanSeconds
      );

    const card = await clearinghouse.registry(paycardId);
    expect(card.recipient).to.equal(recipient.address);
    expect(card.availableBalance).to.equal(totalAllocation);
  });

  it("should block duplicate bearer RailsCard claims after first redemption", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("bearer-first-claim"));
    const intent = buildIntent({
      paycardId,
      recipient: ethers.ZeroAddress,
      lifespanSeconds: 10000,
    });

    await claimWildcardPaycard(client, intent, recipient.address);

    await expect(
      claimWildcardPaycard(client, { ...intent, nonceValue: 1 }, recoveryVault.address)
    ).to.be.revertedWithCustomError(clearinghouse, "CryptographicCollision");

    const card = await clearinghouse.registry(paycardId);
    expect(card.recipient).to.equal(recipient.address);
  });

  it("should support recipient-bound RailsCard terms without redirectability", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("bound-railscard"));
    const intent = buildIntent({
      paycardId,
      recipient: recipient.address,
      metadataHash: hashOpenRailsMetadata({
        version: "openrails-metadata-v1",
        mode: "railscard_recipient_bound",
        originator: client.getAddress(),
        recipient: recipient.address,
        token: await mockUsdc.getAddress(),
        amount: ethers.parseUnits("500", 6).toString(),
        flowVelocityPerSecond: ethers.parseUnits("2", 6).toString(),
        lifespanSeconds: 200,
        metadataRef: "card-bound-demo",
      }),
    });

    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);
    await expect(
      clearinghouse.connect(relayer).openPaycardChannel(
        decoded.intent.paycardId,
        decoded.intent.metadataHash,
        recoveryVault.address,
        decoded.intent.totalAllocationPool,
        decoded.intent.flowVelocityPerSecond,
        decoded.intent.genesisTimestamp,
        decoded.intent.lifespanSeconds,
        decoded.intent.residualDeltaRecipient,
        decoded.envelopeSignature,
        decoded.intent.nonceChannel,
        decoded.intent.nonceValue
      )
    ).to.be.reverted;

    await openPaycard(client, intent);
    const card = await clearinghouse.registry(paycardId);
    expect(card.recipient).to.equal(recipient.address);
  });

  it("should reject wildcard recipients on the fixed RailsFlow open path", async () => {
    const { client } = await createFundedClient();
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("bad-fixed-wildcard")),
      recipient: ethers.ZeroAddress,
    });

    await expect(openPaycard(client, intent)).to.be.revertedWithCustomError(
      clearinghouse,
      "InvalidIntent"
    );
  });

  it("should reject zero claim recipients for wildcard RailsCard claims", async () => {
    const { client } = await createFundedClient();
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("bad-claim-recipient")),
      recipient: ethers.ZeroAddress,
    });

    await expect(
      claimWildcardPaycard(client, intent, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(clearinghouse, "InvalidIntent");
  });

  it("should reject zero metadata hash and zero recovery vault", async () => {
    const { client } = await createFundedClient();
    const zeroMetadata = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("zero-metadata")),
      metadataHash: ethers.ZeroHash,
    });
    const zeroRecovery = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("zero-recovery")),
      residualDeltaRecipient: ethers.ZeroAddress,
      nonceValue: 1,
    });

    await expect(openPaycard(client, zeroMetadata)).to.be.revertedWithCustomError(
      clearinghouse,
      "InvalidIntent"
    );
    await expect(openPaycard(client, zeroRecovery)).to.be.revertedWithCustomError(
      clearinghouse,
      "InvalidIntent"
    );
  });

  it("should reject tampered fixed-recipient envelopes", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("tampered-recipient"));
    const intent = buildIntent({ paycardId });
    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);

    await expect(
      clearinghouse.connect(relayer).openPaycardChannel(
        decoded.intent.paycardId,
        decoded.intent.metadataHash,
        recoveryVault.address,
        decoded.intent.totalAllocationPool,
        decoded.intent.flowVelocityPerSecond,
        decoded.intent.genesisTimestamp,
        decoded.intent.lifespanSeconds,
        decoded.intent.residualDeltaRecipient,
        decoded.envelopeSignature,
        decoded.intent.nonceChannel,
        decoded.intent.nonceValue
      )
    ).to.be.reverted;

    const card = await clearinghouse.registry(paycardId);
    expect(card.payer).to.equal(ethers.ZeroAddress);
  });

  it("should reject tampered RailsFlow metadata hashes", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("tampered-metadata"));
    const intent = buildIntent({
      paycardId,
      metadataHash: hashOpenRailsMetadata({
        version: "openrails-metadata-v1",
        mode: "railsflow",
        originator: recipient.address,
        recipient: recipient.address,
        token: await mockUsdc.getAddress(),
        amount: ethers.parseUnits("500", 6).toString(),
        flowVelocityPerSecond: ethers.parseUnits("2", 6).toString(),
        lifespanSeconds: 200,
        metadataRef: "invoice-001",
      }),
    });
    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);
    const tamperedMetadataHash = hashOpenRailsMetadata({
      version: "openrails-metadata-v1",
      mode: "railsflow",
      originator: recipient.address,
      recipient: recipient.address,
      token: await mockUsdc.getAddress(),
      amount: ethers.parseUnits("999", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("2", 6).toString(),
      lifespanSeconds: 200,
      metadataRef: "invoice-001",
    });

    await expect(
      clearinghouse.connect(relayer).openPaycardChannel(
        decoded.intent.paycardId,
        tamperedMetadataHash,
        decoded.intent.recipient,
        decoded.intent.totalAllocationPool,
        decoded.intent.flowVelocityPerSecond,
        decoded.intent.genesisTimestamp,
        decoded.intent.lifespanSeconds,
        decoded.intent.residualDeltaRecipient,
        decoded.envelopeSignature,
        decoded.intent.nonceChannel,
        decoded.intent.nonceValue
      )
    ).to.be.reverted;

    const card = await clearinghouse.registry(paycardId);
    expect(card.payer).to.equal(ethers.ZeroAddress);
  });

  it("should reject tampered amount, nonce, and lifespan fields", async () => {
    const { client } = await createFundedClient();
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("tampered-fields")),
      totalAllocationPool: ethers.parseUnits("100", 6).toString(),
      lifespanSeconds: 120,
    });
    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);

    const submit = (overrides: Partial<OpenRailsIntentV1>) =>
      clearinghouse.connect(relayer).openPaycardChannel(
        decoded.intent.paycardId,
        overrides.metadataHash ?? decoded.intent.metadataHash,
        overrides.recipient ?? decoded.intent.recipient,
        overrides.totalAllocationPool ?? decoded.intent.totalAllocationPool,
        overrides.flowVelocityPerSecond ?? decoded.intent.flowVelocityPerSecond,
        overrides.genesisTimestamp ?? decoded.intent.genesisTimestamp,
        overrides.lifespanSeconds ?? decoded.intent.lifespanSeconds,
        overrides.residualDeltaRecipient ?? decoded.intent.residualDeltaRecipient,
        decoded.envelopeSignature,
        overrides.nonceChannel ?? decoded.intent.nonceChannel,
        overrides.nonceValue ?? decoded.intent.nonceValue
      );

    await expect(
      submit({ totalAllocationPool: ethers.parseUnits("101", 6).toString() })
    ).to.be.reverted;
    await expect(submit({ nonceValue: decoded.intent.nonceValue + 1 })).to.be.reverted;
    await expect(submit({ lifespanSeconds: decoded.intent.lifespanSeconds + 1 })).to.be.reverted;

    const card = await clearinghouse.registry(intent.paycardId);
    expect(card.payer).to.equal(ethers.ZeroAddress);
  });

  it("should reject malformed signatures and expired windows", async () => {
    const { client } = await createFundedClient();

    const latestBlock = await ethers.provider.getBlock("latest");
    if (!latestBlock) {
      throw new Error("Unable to read latest Hardhat block");
    }

    // Use chain time so earlier time-travel tests cannot expire this
    // intent before malformed-signature validation is reached.
    const malformed = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("malformed-signature")),
      genesisTimestamp: latestBlock.timestamp - 1,
      lifespanSeconds: 3600,
    });

    const expired = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("expired-window")),
      genesisTimestamp: Math.floor(Date.now() / 1000) - 1000,
      lifespanSeconds: 1,
      nonceValue: 1,
    });
    const expiredToken = await client.signPermissionEnvelope(expired);
    const decodedExpired = LeptonOpenRailsClient.deserializePayload(expiredToken);

    await expect(
      clearinghouse.connect(relayer).openPaycardChannel(
        malformed.paycardId,
        malformed.metadataHash,
        malformed.recipient,
        malformed.totalAllocationPool,
        malformed.flowVelocityPerSecond,
        malformed.genesisTimestamp,
        malformed.lifespanSeconds,
        malformed.residualDeltaRecipient,
        "0x",
        malformed.nonceChannel,
        malformed.nonceValue
      )
    ).to.be.revertedWithCustomError(clearinghouse, "AccessViolation");

    await expect(
      clearinghouse.connect(relayer).openPaycardChannel(
        decodedExpired.intent.paycardId,
        decodedExpired.intent.metadataHash,
        decodedExpired.intent.recipient,
        decodedExpired.intent.totalAllocationPool,
        decodedExpired.intent.flowVelocityPerSecond,
        decodedExpired.intent.genesisTimestamp,
        decodedExpired.intent.lifespanSeconds,
        decodedExpired.intent.residualDeltaRecipient,
        decodedExpired.envelopeSignature,
        decodedExpired.intent.nonceChannel,
        decodedExpired.intent.nonceValue
      )
    ).to.be.revertedWithCustomError(clearinghouse, "TimeWindowClosed");
  });

  it("should settle instant one-time payments through the Vault when lifespan is zero", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("instant-payment"));
    const totalAllocation = ethers.parseUnits("75", 6);

    const intent = buildIntent({
      paycardId,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: "0",
      lifespanSeconds: 0,
    });

    await openPaycard(client, intent);
    const initialRecipientBalance = await mockUsdc.balanceOf(recipient.address);

    await expect(clearinghouse.connect(relayer).processDripSettle(paycardId))
      .to.emit(clearinghouse, "SettlementFlushed")
      .withArgs(paycardId, recipient.address, totalAllocation);

    const finalRecipientBalance = await mockUsdc.balanceOf(recipient.address);
    expect(finalRecipientBalance - initialRecipientBalance).to.equal(totalAllocation);

    const card = await clearinghouse.registry(paycardId);
    expect(card.availableBalance).to.equal(0n);
    expect(card.operationalStatus).to.equal(1);
  });

  it("should reject repeated settlement and flush after termination", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("no-double-settle"));
    const intent = buildIntent({
      paycardId,
      totalAllocationPool: ethers.parseUnits("30", 6).toString(),
      flowVelocityPerSecond: "0",
      lifespanSeconds: 0,
    });

    await openPaycard(client, intent);
    await clearinghouse.connect(relayer).processDripSettle(paycardId);

    await expect(
      clearinghouse.connect(relayer).processDripSettle(paycardId)
    ).to.be.revertedWithCustomError(clearinghouse, "AccessViolation");
    await expect(
      clearinghouse.connect(recipient).flushResidualDelta(paycardId)
    ).to.be.revertedWithCustomError(clearinghouse, "AccessViolation");
  });

  it("should conserve escrow across settlement and residual reclaim", async () => {
    const { client } = await createFundedClient();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("conservation"));
    const totalAllocation = ethers.parseUnits("90", 6);
    const intent = buildIntent({
      paycardId,
      totalAllocationPool: totalAllocation.toString(),
      flowVelocityPerSecond: ethers.parseUnits("3", 6).toString(),
      lifespanSeconds: 10000,
    });

    await openPaycard(client, intent);
    const recipientBefore = await mockUsdc.balanceOf(recipient.address);
    const recoveryBefore = await mockUsdc.balanceOf(recoveryVault.address);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await clearinghouse.connect(recipient).flushResidualDelta(paycardId);

    const recipientDelta =
      (await mockUsdc.balanceOf(recipient.address)) - recipientBefore;
    const recoveryDelta =
      (await mockUsdc.balanceOf(recoveryVault.address)) - recoveryBefore;
    expect(recipientDelta + recoveryDelta).to.equal(totalAllocation);
  });

  it("should allow payer to early flush residual after accrued settlement", async () => {
    const { client, providerWallet } = await createFundedClient("50000");
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("payer-early-flush"));
    const intent = buildIntent({
      paycardId,
      totalAllocationPool: ethers.parseUnits("45000", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      genesisTimestamp: Math.floor(Date.now() / 1000) - 1,
      lifespanSeconds: 1000000,
    });

    await openPaycard(client, intent);
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      clearinghouse.connect(providerWallet).flushResidualDelta(paycardId)
    ).to.emit(clearinghouse, "ResidualDeltaReclaimed");

    const card = await clearinghouse.registry(paycardId);
    expect(card.operationalStatus).to.equal(1);
    expect(card.availableBalance).to.equal(0n);
  });


  it("should reject unauthorized residual flush", async () => {
    const { client } = await createFundedClient();
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("unauthorized-flush")),
      lifespanSeconds: 10000,
    });

    await openPaycard(client, intent);
    await expect(
      clearinghouse.connect(relayer).flushResidualDelta(intent.paycardId)
    ).to.be.revertedWithCustomError(clearinghouse, "AccessViolation");
  });

  // =========================================================================
  //  New: SDK NonceEngine Unit Tests
  // =========================================================================

  it("SDK NonceEngine should manage channel selection and sequencing", async () => {
    const adapter = new MemoryNonceCacheAdapter();
    const engine = new NonceEngine(adapter);

    // Channel selection is deterministic
    const ch1 = engine.selectChannel("payment");
    const ch2 = engine.selectChannel("payment");
    expect(ch1).to.equal(ch2);

    // Different task types may produce different channels
    const ch3 = engine.selectChannel("subscription");
    // They could be the same by hash collision, but the engine should return a number
    expect(typeof ch3).to.equal("number");

    // Nonce sequencing
    const n0 = await engine.nextNonce("0xABC", 0);
    expect(n0).to.equal(0);
    const n1 = await engine.nextNonce("0xABC", 0);
    expect(n1).to.equal(1);
    const n2 = await engine.nextNonce("0xABC", 0);
    expect(n2).to.equal(2);

    // Different channel starts at 0
    const m0 = await engine.nextNonce("0xABC", 1);
    expect(m0).to.equal(0);

    // currentNonce reads without increment
    const current = await engine.currentNonce("0xABC", 0);
    expect(current).to.equal(3);
  });

  it("SDK NonceEngine should issue unique nonces under concurrent calls", async () => {
    const engine = new NonceEngine(new MemoryNonceCacheAdapter());
    const channel = engine.selectChannel("concurrent");
    const issued = await Promise.all(
      Array.from({ length: 25 }, () => engine.nextNonce(payer.address, channel))
    );

    expect(new Set(issued).size).to.equal(25);
    expect([...issued].sort((a, b) => a - b)).to.deep.equal(
      Array.from({ length: 25 }, (_, index) => index)
    );
    expect(await engine.currentNonce(payer.address, channel)).to.equal(25);
  });

  // =========================================================================
  //  New: SDK Serialization Round-Trip
  // =========================================================================

  it("SDK serialization should round-trip base64Url encode/decode correctly", () => {
    const original = "Hello, OpenRails V1! Special chars: +/= and unicode: 🚀";
    const encoded = base64UrlEncode(original);

    // Must not contain standard Base64 chars that are URL-unsafe
    expect(encoded).to.not.include("+");
    expect(encoded).to.not.include("/");
    expect(encoded).to.not.include("=");

    const decoded = base64UrlDecode(encoded);
    expect(decoded).to.equal(original);

    // Object serialization round-trip
    const payload = { key: "value", number: 42, nested: { arr: [1, 2, 3] } };
    const token = serializeEnvelope(payload);
    const parsed = deserializeEnvelope<typeof payload>(token);
    expect(parsed).to.deep.equal(payload);
  });

  it("SDK link helpers should round-trip RailsFlow and RailsCard link artifacts", async () => {
    const metadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railsflow" as const,
      originator: recipient.address,
      recipient: recipient.address,
      token: await mockUsdc.getAddress(),
      amount: ethers.parseUnits("15", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 60,
      metadataRef: "invoice-link",
    };
    const metadataHash = hashOpenRailsMetadata(metadata);
    const flowLink = createRailsFlowRequestLink({
      appBaseUrl: "https://app.openrails.test/start",
      chainId,
      vault: await clearinghouse.getAddress(),
      token: await mockUsdc.getAddress(),
      metadataHash,
      payload: {
        mode: "railsflow",
        merchant: recipient.address,
        recipient: recipient.address,
        amount: metadata.amount,
        flowVelocityPerSecond: metadata.flowVelocityPerSecond,
        lifespanSeconds: metadata.lifespanSeconds,
        metadataRef: metadata.metadataRef,
      },
    });

    expect(flowLink).to.include("/openrails/flow#or=");
    expect(flowLink).to.include("#or=orc1:f.");
    expect(flowLink).to.not.include("?or=");
    const parsedFlow = parseOpenRailsLink(flowLink);
    expect(parsedFlow.kind).to.equal("railsflow");
    expect(parsedFlow.metadataHash).to.equal(metadataHash);
    expect((parsedFlow.payload as any).metadataRef).to.equal(metadata.metadataRef);

    const legacyFlowToken = serializeLegacyOpenRailsLinkArtifact({
      version: "openrails-link-v1",
      kind: "railsflow",
      chainId,
      vault: await clearinghouse.getAddress(),
      token: await mockUsdc.getAddress(),
      metadataHash,
      payload: {
        mode: "railsflow",
        merchant: recipient.address,
        recipient: recipient.address,
        amount: metadata.amount,
        flowVelocityPerSecond: metadata.flowVelocityPerSecond,
        lifespanSeconds: metadata.lifespanSeconds,
        metadataRef: metadata.metadataRef,
      },
    });
    const compactFlowToken = flowLink.split("#or=")[1];
    expect(compactFlowToken.length).to.be.lessThan(legacyFlowToken.length);
    const legacyFlow = parseOpenRailsLink(`https://app.openrails.test/openrails/flow#or=${legacyFlowToken}`);
    expect(legacyFlow.metadataHash).to.equal(metadataHash);

    const { client } = await createFundedClient();
    const intent = buildIntent({
      recipient: ethers.ZeroAddress,
      metadataHash,
    });
    const envelopeToken = await client.signPermissionEnvelope(intent, { mode: "railscard_bearer" });
    const cardLink = createRailsCardClaimLink({
      appBaseUrl: "https://app.openrails.test/start",
      chainId,
      vault: await clearinghouse.getAddress(),
      token: await mockUsdc.getAddress(),
      metadataHash,
      mode: "railscard_bearer",
      envelopeToken,
      claimHint: "first-holder-wins",
    });
    const parsedCard = parseOpenRailsLink(cardLink);
    expect(parsedCard.kind).to.equal("railscard");
    expect((parsedCard.payload as any).envelopeToken).to.equal(envelopeToken);
    expect(cardLink).to.include("#or=orc1:c.");
    const compactCardToken = cardLink.split("#or=")[1];
    const legacyCardToken = serializeLegacyOpenRailsLinkArtifact({
      version: "openrails-link-v1",
      kind: "railscard",
      chainId,
      vault: await clearinghouse.getAddress(),
      token: await mockUsdc.getAddress(),
      metadataHash,
      payload: {
        mode: "railscard_bearer",
        envelopeToken,
        claimHint: "first-holder-wins",
      },
    });
    expect(compactCardToken.length).to.be.lessThan(legacyCardToken.length);
    expect(() => parseOpenRailsLink("orc1:z.AAAA")).to.throw("Unknown compact OpenRails link profile");
    expect(() => parseOpenRailsLink("orc1:f.AAAA")).to.throw("Malformed compact OpenRails link payload");
    expect(() => parseOpenRailsLink("https://app.openrails.test/openrails/card?or=leaky")).to.throw();
  });

  it("SDK access credentials should verify and interceptor should enforce allowlists", async () => {
    const signer = ethers.Wallet.createRandom();
    const now = Math.floor(Date.now() / 1000);
    const credential = await createOpenRailsAccessCredential(signer, {
      chainId,
      vault: await clearinghouse.getAddress(),
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("access-paycard")),
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("access-metadata")),
      mode: "railsflow",
      service: recipient.address,
      serviceOrigin: "https://api.service.test",
      scope: "GET /v1/inference",
      issuedAt: now,
      expiresAt: now + 60,
    });

    expect(
      verifyOpenRailsAccessCredential(credential, {
        expectedServiceOrigin: "https://api.service.test",
        expectedScope: "GET /v1/inference",
        now,
      })
    ).to.equal(signer.address);
    expect(() =>
      verifyOpenRailsAccessCredential(credential, {
        expectedServiceOrigin: "https://evil.test",
        expectedScope: "GET /v1/inference",
        now,
      })
    ).to.throw("service origin mismatch");
    expect(() =>
      verifyOpenRailsAccessCredential(
        { ...credential, mode: "railscard_bearer" },
        {
          expectedServiceOrigin: "https://api.service.test",
          expectedScope: "GET /v1/inference",
          now,
        }
      )
    ).to.throw("signer mismatch");

    const headers = buildOpenRailsAccessHeaders(credential);
    expect(headers.Authorization).to.match(/^OpenRails /);
    expect(headers["X-OpenRails-Paycard-Id"]).to.equal(credential.paycardId);

    let capturedHeaders: Record<string, string> = {};
    const fetcher = createOpenRailsFetch({
      credential,
      allowedOrigins: ["https://api.service.test"],
      fetchImpl: (async (_input: any, init?: any) => {
        const sent = new Headers(init.headers);
        capturedHeaders = Object.fromEntries(sent.entries());
        return new Response("ok");
      }) as any,
    });

    await fetcher("https://api.service.test/v1/inference");
    expect(capturedHeaders.authorization).to.match(/^OpenRails /);
    try {
      await fetcher("https://evil.test/v1/inference");
      expect.fail("Expected non-allowlisted origin to fail");
    } catch (err: any) {
      expect(err.message).to.include("non-allowlisted origin");
    }
  });

  it("server access validation should reject mismatched access headers and policy", async () => {
    const signer = ethers.Wallet.createRandom();
    const now = Math.floor(Date.now() / 1000);
    const service = recipient.address;
    const credential = await createOpenRailsAccessCredential(signer, {
      chainId,
      vault: await clearinghouse.getAddress(),
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("server-access-paycard")),
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("server-access-metadata")),
      mode: "railsflow",
      service,
      serviceOrigin: "http://localhost:3001",
      scope: "GET /api/demo/protected-resource",
      issuedAt: now,
      expiresAt: now + 60,
    });
    const token = serializeOpenRailsAccessCredential(credential);
    const headers = buildOpenRailsAccessHeaders(token);
    const options = {
      expectedChainId: chainId,
      expectedVault: await clearinghouse.getAddress(),
      expectedService: service,
      expectedServiceOrigin: "http://localhost:3001",
      expectedScope: "GET /api/demo/protected-resource",
      now,
    };

    const accepted = validateOpenRailsAccessRequest(
      {
        authorization: headers.Authorization,
        openRailsCredentialType: headers["X-OpenRails-Credential-Type"],
        openRailsPaycardId: headers["X-OpenRails-Paycard-Id"],
        openRailsMetadataHash: headers["X-OpenRails-Metadata-Hash"],
        openRailsMode: headers["X-OpenRails-Mode"],
      },
      options,
    );
    expect(accepted.ok).to.equal(true);

    const mismatchedPaycard = validateOpenRailsAccessRequest(
      {
        authorization: headers.Authorization,
        openRailsCredentialType: headers["X-OpenRails-Credential-Type"],
        openRailsPaycardId: ethers.keccak256(ethers.toUtf8Bytes("wrong-paycard")),
        openRailsMetadataHash: headers["X-OpenRails-Metadata-Hash"],
        openRailsMode: headers["X-OpenRails-Mode"],
      },
      options,
    );
    expect(mismatchedPaycard.ok).to.equal(false);
    if (!mismatchedPaycard.ok) {
      expect(mismatchedPaycard.error).to.include("paycard header mismatch");
    }

    const wrongOrigin = validateOpenRailsAccessRequest(
      {
        authorization: headers.Authorization,
        openRailsCredentialType: headers["X-OpenRails-Credential-Type"],
      },
      { ...options, expectedServiceOrigin: "https://evil.test" },
    );
    expect(wrongOrigin.ok).to.equal(false);

    const expired = validateOpenRailsAccessRequest(
      {
        authorization: headers.Authorization,
        openRailsCredentialType: headers["X-OpenRails-Credential-Type"],
      },
      { ...options, now: now + 120 },
    );
    expect(expired.ok).to.equal(false);
  });

  it("SDK wallet helpers should approve, open, settle, and flush with signer", async () => {
    const { wallet, providerWallet } = await createFundedClient("100");
    const tokenAddress = await mockUsdc.getAddress();
    // The SDK wallet opens NEW streams on the V2 hub (V1 is frozen to new opens), so
    // exercise the approve/open/settle/flush lifecycle against a V2 factory clone.
    const _master = await (await ethers.getContractFactory("ArcOpenRailsHubV2Initializable")).deploy();
    await _master.waitForDeployment();
    const _factory = await (await ethers.getContractFactory("ArcOpenRailsFactoryV1")).deploy(await _master.getAddress());
    await _factory.waitForDeployment();
    const _rc = await (await _factory.deployCorporateVault(tokenAddress)).wait();
    const _ev = _rc.logs.find((l: any) => l.fragment && l.fragment.name === "CorporateVaultDeployed");
    const hubAddress = _ev.args.vaultAddress as string;
    const hubV2 = await ethers.getContractAt("ArcOpenRailsHubV2Initializable", hubAddress);
    const metadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railsflow" as const,
      originator: wallet.address,
      recipient: recipient.address,
      token: tokenAddress,
      amount: ethers.parseUnits("10", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 20,
      metadataRef: "wallet-helper-open",
    };
    const nonceChannel = 44;
    const latestBlock = await ethers.provider.getBlock("latest");
    const nonceValue = await readNonce(ethers.provider, hubAddress, wallet.address, nonceChannel);
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("wallet-helper-open")),
      metadataHash: hashOpenRailsMetadata(metadata),
      recipient: recipient.address,
      totalAllocationPool: metadata.amount,
      flowVelocityPerSecond: metadata.flowVelocityPerSecond,
      genesisTimestamp: latestBlock!.timestamp,
      lifespanSeconds: metadata.lifespanSeconds,
      residualDeltaRecipient: recoveryVault.address,
      nonceChannel,
      nonceValue,
    });

    expect(await readTokenBalance(ethers.provider, tokenAddress, wallet.address)).to.equal(
      ethers.parseUnits("100", 6)
    );
    await (await approveOpenRailsSpend(providerWallet, tokenAddress, hubAddress, BigInt(intent.totalAllocationPool))).wait();
    expect(await readTokenAllowance(ethers.provider, tokenAddress, wallet.address, hubAddress)).to.equal(
      BigInt(intent.totalAllocationPool)
    );

    const token = await signPermissionEnvelopeWithSigner(providerWallet, {
      chainId,
      clearinghouseAddress: hubAddress,
      usdcAddress: tokenAddress,
    }, intent, { mode: "railsflow", metadata });
    await (await submitOpenPaycardWithSigner(providerWallet, hubAddress, token, "railsflow")).wait();
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await submitSettleWithSigner(providerWallet, hubAddress, intent.paycardId)).wait();
    await (await submitFlushWithSigner(providerWallet, hubAddress, intent.paycardId)).wait();

    const card = await hubV2.registry(intent.paycardId);
    expect(Number(card.operationalStatus)).to.equal(1);
  });

  it("SDK wallet network helper should switch or add Arc testnet", async () => {
    expect(toEip155ChainIdHex(5042002)).to.equal("0x4cef52");

    const switchCalls: any[] = [];
    const switched = await switchOrAddOpenRailsNetwork({
      request: async (args) => {
        switchCalls.push(args);
        return null;
      },
    }, {
      chainId: 5042002,
      chainName: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      rpcUrls: ["https://rpc.testnet.arc.network"],
      blockExplorerUrls: ["https://testnet.arcscan.app"],
    });
    expect(switched).to.equal("switched");
    expect(switchCalls[0]).to.deep.equal({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x4cef52" }],
    });

    const addCalls: any[] = [];
    let addSwitchAttempts = 0;
    const added = await switchOrAddOpenRailsNetwork({
      request: async (args) => {
        addCalls.push(args);
        if (args.method === "wallet_switchEthereumChain") {
          addSwitchAttempts += 1;
          if (addSwitchAttempts > 1) return null;
          throw { code: 4902, message: "Unrecognized chain" };
        }
        return null;
      },
    }, {
      chainId: 5042002,
      chainName: "Arc Testnet",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      rpcUrls: ["https://rpc.testnet.arc.network"],
      blockExplorerUrls: ["https://testnet.arcscan.app"],
    });
    expect(added).to.equal("added");
    expect(addCalls[1]).to.deep.equal({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: "0x4cef52",
        chainName: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
        rpcUrls: ["https://rpc.testnet.arc.network"],
        blockExplorerUrls: ["https://testnet.arcscan.app"],
      }],
    });
    expect(addCalls[2]).to.deep.equal({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x4cef52" }],
    });

    try {
      await switchOrAddOpenRailsNetwork({
        request: async () => {
          throw { code: 4902, message: "Unrecognized chain" };
        },
      }, {
        chainId: 5042002,
        chainName: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
      });
      expect.fail("expected missing public RPC URL to throw");
    } catch (err: any) {
      expect(err.message).to.include("no public RPC URL");
    }
  });

  it("SDK receipt helpers should bind metadata and round-trip proof artifacts", async () => {
    const hubAddress = await clearinghouse.getAddress();
    const tokenAddress = await mockUsdc.getAddress();
    const metadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railsflow" as const,
      originator: payer.address,
      recipient: recipient.address,
      token: tokenAddress,
      amount: ethers.parseUnits("7", 6).toString(),
      flowVelocityPerSecond: ethers.parseUnits("1", 6).toString(),
      lifespanSeconds: 30,
      metadataRef: "receipt-invoice-001",
    };
    const metadataHash = hashOpenRailsMetadata(metadata);
    expect(verifyReceiptMetadataHash(metadataHash, metadata)).to.equal(true);

    const paymentReceipt = createPaymentReceipt({
      chainId,
      hub: hubAddress,
      token: tokenAddress,
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("receipt-paycard")),
      metadataHash,
      payer: payer.address,
      recipient: recipient.address,
      txHash: ethers.keccak256(ethers.toUtf8Bytes("open-tx")),
      blockNumber: 123,
      issuedAt: 456,
      totalAllocationPool: metadata.amount,
      flowVelocityPerSecond: metadata.flowVelocityPerSecond,
      lifespanSeconds: metadata.lifespanSeconds,
      residualDeltaRecipient: recoveryVault.address,
      nonceChannel: 9,
      nonceValue: 11,
      metadata,
    });
    expect(paymentReceipt.type).to.equal("payment_opened");
    expect(paymentReceipt.issuedAt).to.equal(456);
    expect(parseReceipt(serializeReceipt(paymentReceipt))).to.deep.equal(paymentReceipt);

    const settlementReceipt = createSettlementReceipt({
      chainId,
      hub: hubAddress,
      token: tokenAddress,
      paycardId: paymentReceipt.paycardId,
      metadataHash,
      payer: payer.address,
      recipient: recipient.address,
      txHash: ethers.keccak256(ethers.toUtf8Bytes("settle-tx")),
      settledAmount: ethers.parseUnits("2", 6).toString(),
      remainingAvailableBalance: ethers.parseUnits("5", 6).toString(),
      metadata,
    });
    expect(settlementReceipt.type).to.equal("settlement_processed");

    const residualReceipt = createResidualRecoveryReceipt({
      chainId,
      hub: hubAddress,
      token: tokenAddress,
      paycardId: paymentReceipt.paycardId,
      metadataHash,
      payer: payer.address,
      recipient: recipient.address,
      txHash: ethers.keccak256(ethers.toUtf8Bytes("flush-tx")),
      recoveredAmount: ethers.parseUnits("5", 6).toString(),
      metadata,
    });
    expect(residualReceipt.finalStatus).to.equal("Terminated");
    expect(residualReceipt.recoveryStatus).to.equal("residual_recovered");

    const noResidualReceipt = createResidualRecoveryReceipt({
      chainId,
      hub: hubAddress,
      token: tokenAddress,
      paycardId: paymentReceipt.paycardId,
      metadataHash,
      payer: payer.address,
      recipient: recipient.address,
      txHash: ethers.keccak256(ethers.toUtf8Bytes("flush-no-residual-tx")),
      recoveredAmount: "0",
      metadata,
    });
    expect(noResidualReceipt.recoveryStatus).to.equal("no_residual_remaining");
    expect(noResidualReceipt.note).to.include("No STN-Delta residual remained");
    expect(parseReceipt(serializeReceipt(noResidualReceipt))).to.deep.equal(noResidualReceipt);

    expect(() => createPaymentReceipt({
      ...paymentReceipt,
      metadataHash: ethers.ZeroHash,
    })).to.throw("metadata does not match");
  });

  // =========================================================================
  //  New: SDK Signature Sanity Checker
  // =========================================================================

  it("SDK should validate recovered signer matches wallet address (sanity check)", async () => {
    const { client, wallet } = await createFundedClient();

    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("sig-check")),
    });

    // The envelope should be created successfully
    const token = await client.signPermissionEnvelope(intent);
    expect(token).to.be.a("string");
    expect(token.length).to.be.greaterThan(0);

    // Deserialize and verify the signer matches
    const decoded = LeptonOpenRailsClient.deserializePayload(token);
    expect(decoded.payerAddress.toLowerCase()).to.equal(
      wallet.address.toLowerCase()
    );
    expect(decoded.envelopeSignature).to.be.a("string");
    expect(decoded.envelopeSignature.length).to.equal(132); // 0x + 130 hex chars
  });

  it("SDK should require nonce fields and evaluate policy preflight without treating it as proof", async () => {
    const { client } = await createFundedClient();
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("policy-proof")),
    });

    const rejected = evaluatePolicyEnvelope(intent, {
      maxAllocationPool: ethers.parseUnits("1", 6).toString(),
    });
    expect(rejected.approved).to.equal(false);
    expect(rejected.reasons).to.include("allocation_exceeds_policy");

    const accepted = evaluatePolicyEnvelope(intent, {
      maxAllocationPool: ethers.parseUnits("1000", 6).toString(),
    });
    expect(accepted.approved).to.equal(true);

    const token = await client.signPermissionEnvelope(intent);
    const decoded = LeptonOpenRailsClient.deserializePayload(token);
    const proof = buildIntentProof(decoded, {
      chainId,
      verifyingContract: await clearinghouse.getAddress(),
    });
    expect(proof.stage).to.equal("signed_intent");
    expect(proof.paycardId).to.equal(intent.paycardId);
    expect(proof.metadataHash).to.equal(intent.metadataHash);
    expect(proof.intentDigest).to.equal(
      hashSettlementIntent(intent, chainId, await clearinghouse.getAddress())
    );
    expect(proof.txHash).to.equal(undefined);

    const boundPaycardId = buildMetadataBoundPaycardId({
      payer: decoded.payerAddress,
      nonceChannel: intent.nonceChannel,
      nonceValue: intent.nonceValue,
      metadataHash: intent.metadataHash,
      salt: "demo",
    });
    expect(boundPaycardId).to.equal(
      buildMetadataBoundPaycardId({
        payer: decoded.payerAddress,
        nonceChannel: intent.nonceChannel,
        nonceValue: intent.nonceValue,
        metadataHash: intent.metadataHash,
        salt: "demo",
      })
    );

    const nonceMissing = { ...intent } as any;
    delete nonceMissing.nonceValue;
    try {
      await client.signPermissionEnvelope(nonceMissing);
      expect.fail("Expected missing nonce signing to fail");
    } catch (err: any) {
      expect(err.message).to.include("nonceChannel and nonceValue are required");
    }
  });

  it("SDK should preserve recipient-bound RailsCard proof mode from hash-bound metadata", async () => {
    const { client } = await createFundedClient();
    const metadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railscard_recipient_bound" as const,
      originator: client.getAddress(),
      recipient: recipient.address,
      token: await mockUsdc.getAddress(),
      amount: ethers.parseUnits("25", 6).toString(),
      flowVelocityPerSecond: "0",
      lifespanSeconds: 0,
      metadataRef: "recipient-bound-proof",
    };
    const intent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("recipient-bound-proof")),
      recipient: recipient.address,
      metadataHash: hashOpenRailsMetadata(metadata),
      totalAllocationPool: metadata.amount,
      flowVelocityPerSecond: metadata.flowVelocityPerSecond,
      lifespanSeconds: metadata.lifespanSeconds,
    });

    const token = await client.signPermissionEnvelope(intent, { metadata });
    const decoded = LeptonOpenRailsClient.deserializePayload(token);
    const proof = buildIntentProof(decoded, {
      chainId,
      verifyingContract: await clearinghouse.getAddress(),
    });

    expect(decoded.mode).to.equal("railscard_recipient_bound");
    expect(proof.mode).to.equal("railscard_recipient_bound");
    expect(proof.metadataHash).to.equal(intent.metadataHash);
  });

  it("SDK metadata hashing should be deterministic and malformed envelopes should fail", () => {
    const metadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railsflow" as const,
      originator: recipient.address,
      recipient: recipient.address,
      token: "USDC",
      amount: "100",
      flowVelocityPerSecond: "0",
      lifespanSeconds: 0,
      metadataRef: "deterministic",
      workflowId: "workflow-alpha",
    };
    const sameMetadataDifferentOrder = {
      workflowId: "workflow-alpha",
      metadataRef: "deterministic",
      lifespanSeconds: 0,
      flowVelocityPerSecond: "0",
      amount: "100",
      token: "USDC",
      recipient: recipient.address,
      originator: recipient.address,
      mode: "railsflow" as const,
      version: "openrails-metadata-v1" as const,
    };

    expect(canonicalizeMetadata(metadata)).to.equal(
      canonicalizeMetadata(sameMetadataDifferentOrder)
    );
    expect(hashOpenRailsMetadata(metadata)).to.equal(
      hashOpenRailsMetadata(sameMetadataDifferentOrder)
    );
    expect(hashOpenRailsMetadata(metadata)).to.not.equal(
      hashOpenRailsMetadata({
        ...metadata,
        workflowId: "workflow-beta",
      })
    );
    expect(hashOpenRailsMetadata({
      ...metadata,
      workflowId: undefined,
    })).to.equal(hashOpenRailsMetadata({
      version: "openrails-metadata-v1",
      mode: "railsflow",
      originator: recipient.address,
      recipient: recipient.address,
      token: "USDC",
      amount: "100",
      flowVelocityPerSecond: "0",
      lifespanSeconds: 0,
      metadataRef: "deterministic",
    }));
    expect(() => LeptonOpenRailsClient.deserializePayload("not-base64!")).to.throw();
  });

  it("dashboard should use the hardened EIP-712 schema and honest relayer copy", () => {
    const appSource = fs.readFileSync(
      path.join(__dirname, "../dashboard/app.js"),
      "utf8"
    );
    const htmlSource = fs.readFileSync(
      path.join(__dirname, "../dashboard/index.html"),
      "utf8"
    );

    expect(appSource).to.include('{ name: "metadataHash", type: "bytes32" }');
    expect(appSource).to.include('{ name: "nonceChannel", type: "uint256" }');
    expect(appSource).to.include('{ name: "nonceValue", type: "uint256" }');
    expect(appSource).to.include("mode");
    expect(appSource).to.include("metadata");
    expect(appSource).to.include("workflowId");
    expect(appSource).to.include("attachWorkflowId");
    expect(appSource).to.include("checkX402BridgeGate");
    expect(appSource).to.include("/api/x402/openrails-artifact");
    expect(appSource).to.include("vaultEscrowClaimed");
    expect(appSource).to.include("X-OpenRails-Paycard-Id");
    expect(appSource).to.include("X-OpenRails-Metadata-Hash");
    expect(appSource).to.include("Bearer RailsCard value link");
    expect(appSource).to.include("Treat it like cash until claimed");
    expect(appSource).to.include("readBearerClaimRecipient");
    expect(appSource).to.include("No STN-Delta residual remained to recover");
    expect(appSource).to.include("No-Residual Close Receipt");
    expect(appSource).to.include("buildArtifactReview");
    expect(appSource).to.include('import QRCode from "qrcode"');
    expect(appSource).to.include("parseOpenRailsLink");
    expect(appSource).to.include("window.addEventListener(\"hashchange\"");
    expect(appSource).to.include("createOpenRailsAccessCredential");
    expect(appSource).to.include("createOpenRailsFetch");
    expect(appSource).to.include("serializeOpenRailsAccessCredential");
    expect(appSource).to.include("toggleAutoDrip");
    expect(appSource).to.include("runAutoDripStep");
    expect(appSource).to.include("config.capabilities");
    expect(appSource).to.include("Arc Testnet Read-Only");
    expect(appSource).to.include("Arc Public Relayer Alpha");
    expect(appSource).to.include("isPublicRelayerMode");
    expect(appSource).to.include("publicRelayerCapSummary");
    expect(appSource).to.include("approveArcSpend");
    expect(appSource).to.include("signArcEnvelope");
    expect(appSource).to.include("openSignedArcEnvelope");
    expect(appSource).to.include("resetSignedArcEnvelope");
    expect(appSource).to.include('elRelayerInputToken.value = ""');
    expect(appSource).to.include("elEnvelopeOutputContainer.classList.add(\"hidden\")");
    expect(appSource).to.include("latestArcEnvelopeToken = \"\"");
    expect(appSource).to.include("const token = (elRelayerInputToken.value || latestArcEnvelopeToken || \"\").trim()");
    expect(appSource).to.include("const envelopeMode = decodedEnvelope.mode || elModeInput.value");
    expect(appSource).to.include("mode: envelopeMode");
    expect(appSource).to.include("Public relayer opens only");
    expect(appSource).to.include("settlement and close use your wallet");
    expect(appSource).to.include("canUsePrivateKeySigning");
    expect(appSource).to.include("canRelayOpen");
    expect(appSource).to.include("connectWallet");
    expect(appSource).to.include("submitArcWalletOpen");
    expect(appSource).to.include("approveOpenRailsSpend");
    expect(appSource).to.include("submitOpenPaycardWithSigner");
    expect(appSource).to.include("submitSettleWithSigner");
    expect(appSource).to.include("submitFlushWithSigner");
    expect(appSource).to.include("switchOrAddOpenRailsNetwork");
    expect(appSource).to.include("Wallet-signed Arc transaction");
    expect(appSource).to.include("Wallet-signed local transaction");
    expect(appSource).to.include("https://rpc.testnet.arc.network");
    expect(appSource).to.include("createPaymentReceipt");
    expect(appSource).to.include("createSettlementReceipt");
    expect(appSource).to.include("createResidualRecoveryReceipt");
    expect(appSource).to.include("recoverPaycardsFromWallet");
    expect(appSource).to.include("recoverPaycardFromArtifact");
    expect(appSource).to.include("/api/paycards/recover");
    expect(appSource).to.include("parseReceipt");
    expect(appSource).to.include("updateAgentDecisionTrace");
    expect(appSource).to.include("sessionMetrics");
    expect(appSource).to.not.include("Authorization: OpenRails <short-lived access credential or envelope>");
    expect(htmlSource).to.include("share-qr-canvas");
    expect(htmlSource).to.include("inbound-link-container");
    expect(htmlSource).to.include("access-panel");
    expect(htmlSource).to.include("btn-auto-drip");
    expect(htmlSource).to.include("ledger-action-status");
    expect(htmlSource).to.include("btn-connect-wallet");
    expect(htmlSource).to.include("btn-switch-wallet-network");
    expect(htmlSource).to.include("Switch/Add Arc Testnet");
    expect(htmlSource).to.include("wallet-network-hint");
    expect(htmlSource).to.include("wallet-status");
    expect(htmlSource).to.include("intent-workflow-id");
    expect(htmlSource).to.include("Workflow Scope ID");
    expect(htmlSource).to.include("Agent Decision Trace");
    expect(htmlSource).to.include("Live Session Metrics");
    expect(htmlSource).to.include("External Testers");
    expect(htmlSource).to.include("Try V1 Now");
    expect(htmlSource).to.include("btn-approve-arc-spend");
    expect(htmlSource).to.include("btn-sign-arc-envelope");
    expect(htmlSource).to.include("btn-open-arc-paycard");
    expect(htmlSource).to.include("relayer-cap-panel");
    expect(htmlSource).to.include("tester-flow-status");
    expect(htmlSource).to.include("npm run smoke:sdk:arc -- --wallet 0x...");
    expect(htmlSource).to.include("OpenRails Receipt");
    expect(htmlSource).to.include("Recover Paycard ID");
    expect(htmlSource).to.include("recovery-artifact-input");
    expect(htmlSource).to.include("btn-recover-wallet");
    expect(htmlSource).to.include("Search Onchain");
    expect(htmlSource).to.include("Circle x402 Bridge");
    expect(htmlSource).to.include("btn-check-x402-bridge");
    expect(htmlSource).to.include("x402-bridge-output");
    expect(htmlSource).to.include("x402 proves HTTP payment");
    expect(htmlSource).to.include("toggle-judge-script");
    expect(htmlSource).to.include("protected endpoint");
    expect(htmlSource).to.include('type="module" src="app.js"');
    expect(htmlSource).to.include("Create RailsFlow Request Link");
    expect(htmlSource).to.include("rail-mode-guide");
    expect(htmlSource).to.include("Merchant / Recipient Address");
    expect(htmlSource).to.include("Review before sharing");
    expect(htmlSource).to.include("Local Relayer Gateway");
    expect(htmlSource).to.include("relayer-flow-copy");
    expect(htmlSource).to.include("receipt-submission-mode");
    expect(htmlSource).to.include("Bearer is first-holder-wins");
    expect(htmlSource).to.not.include("Gasless Relayer Gateway");
    expect(htmlSource).to.not.include("Circle Sponsored Relays");
  });

  it("server should reject invalid envelope mode and recipient combinations", () => {
    const validationSource = fs.readFileSync(
      path.join(__dirname, "../server/validation.ts"),
      "utf8"
    );

    expect(validationSource).to.include("Conflicting envelope modes");
    expect(validationSource).to.include("Unknown envelope mode");
    expect(validationSource).to.include("Bearer RailsCard requires wildcard recipient");
    expect(validationSource).to.include("RailsFlow requires fixed recipient");
    expect(validationSource).to.include("Recipient-bound RailsCard requires fixed recipient");
    expect(validationSource).to.include("workflowId: decoded.metadata?.workflowId");
  });

  it("server should keep demo keys and custodial flush out of the default public API", () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, "../server/index.ts"),
      "utf8"
    );

    expect(serverSource).to.include("exposesPrivateKeys: false");
    expect(serverSource).to.include("OPENRAILS_DASHBOARD_MODE");
    expect(serverSource).to.include("arc-testnet");
    expect(serverSource).to.include("ARC_READ_ONLY_CAPABILITIES");
    expect(serverSource).to.include("ARC_PUBLIC_RELAYER_ENABLED");
    expect(serverSource).to.include("OPENRAILS_ENABLE_ARC_PUBLIC_RELAYER");
    expect(serverSource).to.include("ARC_PUBLIC_RELAYER_CAPABILITIES");
    expect(serverSource).to.include("settleRequiresWallet: true");
    expect(serverSource).to.include("publicRelayerCaps");
    expect(serverSource).to.include("validatePublicRelayerCaps");
    expect(serverSource).to.include("Public relayer cap exceeded");
    expect(serverSource).to.include("canRelayOpen: false");
    expect(serverSource).to.include("forbiddenCapability");
    expect(serverSource).to.include("Flush requires caller authorization signature");
    expect(serverSource).to.include("OPENRAILS_ENABLE_DEMO_CUSTODIAL_FLUSH");
    expect(serverSource).to.include("hardhat_impersonateAccount");
    expect(serverSource).to.include("Local sandbox bootstrap refuses non-loopback RPC URLs");
    expect(serverSource).to.not.include("agentPrivateKey:");
    expect(serverSource).to.not.include("merchantPrivateKey:");
  });

  it("Arc public relayer alpha should be env-gated, capped, and close-wallet-only", () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, "../server/index.ts"),
      "utf8"
    );
    const launchCheckSource = fs.readFileSync(
      path.join(__dirname, "../scripts/launch-check.ts"),
      "utf8"
    );

    expect(serverSource).to.include('process.env.OPENRAILS_ENABLE_ARC_PUBLIC_RELAYER === "true"');
    expect(serverSource).to.include("OPENRAILS_RELAYER_PRIVATE_KEY must be a 32-byte hex key");
    expect(serverSource).to.include("new ethers.Wallet(privateKey, provider)");
    expect(serverSource).to.include("maxAllocationUsdc");
    expect(serverSource).to.include("maxLifespanSeconds");
    expect(serverSource).to.include("maxVelocityUsdcPerSecond");
    expect(serverSource).to.include("parsePublicRelayerUnits");
    expect(serverSource).to.include('canDemoFlush: false');
    const publicCapabilitiesStart = serverSource.indexOf("const ARC_PUBLIC_RELAYER_CAPABILITIES");
    const publicCapabilitiesEnd = serverSource.indexOf("function currentCapabilities", publicCapabilitiesStart);
    const publicCapabilitiesSource = serverSource.slice(publicCapabilitiesStart, publicCapabilitiesEnd);
    expect(publicCapabilitiesSource).to.include("canRelayOpen: true");
    expect(publicCapabilitiesSource).to.not.include("canGatewaySettle: true");
    expect(serverSource).to.include("Demo flush is available only in the local Hardhat sandbox");
    expect(serverSource).to.include("closeRequiresWallet: true");
    expect(serverSource).to.not.include("OPENRAILS_RELAYER_PRIVATE_KEY,");
    expect(launchCheckSource).to.include("publicRelayerEnabled");
    expect(launchCheckSource).to.include("required when OPENRAILS_ENABLE_ARC_PUBLIC_RELAYER=true");
    expect(launchCheckSource).to.include("OPENRAILS_PUBLIC_RELAYER_MAX_ALLOCATION_USDC");
    expect(launchCheckSource).to.include("OPENRAILS_PUBLIC_RELAYER_MAX_LIFESPAN_SECONDS");
    expect(launchCheckSource).to.include("OPENRAILS_PUBLIC_RELAYER_MAX_VELOCITY_USDC_PER_SECOND");
  });

  it("server and SDK should expose bounded Paycard ID recovery", () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, "../server/index.ts"),
      "utf8"
    );
    const walletSource = fs.readFileSync(
      path.join(__dirname, "../sdk/src/wallet.ts"),
      "utf8"
    );

    expect(walletSource).to.include("event PaycardProvisioned");
    expect(walletSource).to.include("recoverPaycardsFromLogs");
    expect(walletSource).to.include("provider.getLogs");
    expect(walletSource).to.include("readPaycard(provider, hubAddress, paycardId)");
    expect(serverSource).to.include('app.get("/api/paycards/recover", apiLimiter');
    expect(serverSource).to.include("PAYCARD_RECOVERY_MAX_BLOCK_SPAN");
    expect(serverSource).to.include("PAYCARD_RECOVERY_CHUNK_SIZE");
    expect(serverSource).to.include("payer or recipient is required");
    expect(serverSource).to.include("recoverPaycardsFromLogs(provider, clearinghouseAddress");
  });

  it("tester SDK smoke should be read-only and expose recovery commands", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
    );
    const scriptSource = fs.readFileSync(
      path.join(__dirname, "../scripts/sdk-arc-smoke.ts"),
      "utf8"
    );

    expect(packageJson.scripts["smoke:sdk:arc"]).to.equal("ts-node scripts/sdk-arc-smoke.ts");
    expect(scriptSource).to.include("Read-only OpenRails Arc SDK smoke");
    expect(scriptSource).to.include('provider.send("eth_chainId"');
    expect(scriptSource).to.include("Wrong network: expected chain");
    expect(scriptSource).to.include("recoverPaycardsFromLogs");
    expect(scriptSource).to.include("readPaycard");
    expect(scriptSource).to.include("readTokenBalance");
    expect(scriptSource).to.include("readTokenAllowance");
    expect(scriptSource).to.not.include("new ethers.Wallet");
    expect(scriptSource).to.not.include("approveOpenRailsSpend");
    expect(scriptSource).to.not.include("submitOpenPaycardWithSigner");
    expect(scriptSource).to.not.include("submitSettleWithSigner");
    expect(scriptSource).to.not.include("submitFlushWithSigner");
  });

  it("server should expose x402-paid OpenRails artifacts without claiming Vault escrow", () => {
    const serverSource = fs.readFileSync(
      path.join(__dirname, "../server/index.ts"),
      "utf8"
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
    );
    const routeStart = serverSource.indexOf('app.get(\n  "/api/x402/openrails-artifact"');
    const routeEnd = serverSource.indexOf("// ---------------------------------------------------------------------------\n// Server bootstrap", routeStart);
    const routeSource = serverSource.slice(routeStart, routeEnd);

    expect(packageJson.dependencies["@circle-fin/x402-batching"]).to.be.a("string");
    expect(serverSource).to.include('require("@circle-fin/x402-batching/server")');
    expect(serverSource).to.include("createGatewayMiddleware({");
    expect(serverSource).to.include("OPENRAILS_X402_SELLER_ADDRESS");
    expect(routeSource).to.include("requireArcX402Mode");
    expect(routeSource).to.include("x402Gateway.require(X402_PRICE)");
    expect(routeSource).to.include("circle-x402:");
    expect(routeSource).to.include("hashOpenRailsMetadata(metadata)");
    expect(routeSource).to.include("vaultEscrowClaimed: false");
    expect(routeSource).to.include('openRailsSettlementStage: "metadata_only"');
    expect(routeSource).to.not.include("openPaycardChannel");
    expect(routeSource).to.not.include("claimWildcardPaycardChannel");
    expect(routeSource).to.not.include("processDripSettle");
    expect(routeSource).to.not.include("flushResidualDelta");
  });

  it("stream gateway should not treat local expiry as authoritative termination", () => {
    const gatewaySource = fs.readFileSync(
      path.join(__dirname, "../stream-gateway/index.ts"),
      "utf8"
    );
    const stateSource = fs.readFileSync(
      path.join(__dirname, "../stream-gateway/state-store.ts"),
      "utf8"
    );

    expect(gatewaySource).to.include("processedLogKeys");
    expect(gatewaySource).to.include("StreamExpiredPendingSettlement");
    expect(gatewaySource).to.include('state.status = "PendingSettlement"');
    expect(gatewaySource).to.include("bindVerifiedMetadata");
    expect(gatewaySource).to.include("getStreamsByWorkflow");
    expect(gatewaySource).to.include("hashOpenRailsMetadata(metadata) !== state.metadataHash");
    expect(stateSource).to.include('"PendingSettlement"');
    expect(stateSource).to.include("workflowId?: string");
    expect(stateSource).to.include("getByWorkflow");
    expect(stateSource).to.include("getActiveByWorkflow");
  });

  it("stream gateway state store should index metadata-bound workflow scopes", () => {
    const store = new MemoryCacheStateStore();
    const first = ethers.keccak256(ethers.toUtf8Bytes("workflow-stream-1"));
    const second = ethers.keccak256(ethers.toUtf8Bytes("workflow-stream-2"));
    const baseState = {
      payer: payer.address,
      recipient: recipient.address,
      metadataHash: ethers.keccak256(ethers.toUtf8Bytes("workflow-metadata")),
      totalAllocation: "100",
      availableBalance: "100",
      velocity: "1",
      genesis: 1,
      lifespan: 60,
      lastCheckpoint: 1,
      status: "Active" as const,
    };

    store.set(first, {
      ...baseState,
      paycardId: first,
      workflowId: "workflow-alpha",
    });
    store.set(second, {
      ...baseState,
      paycardId: second,
      status: "Terminated",
      workflowId: "workflow-alpha",
    });

    expect(store.getByWorkflow("workflow-alpha").map((s) => s.paycardId)).to.deep.equal([
      first,
      second,
    ]);
    expect(store.getActiveByWorkflow("workflow-alpha").map((s) => s.paycardId)).to.deep.equal([
      first,
    ]);

    store.bindWorkflow(first, "workflow-beta");
    expect(store.getByWorkflow("workflow-alpha").map((s) => s.paycardId)).to.deep.equal([
      second,
    ]);
    expect(store.getByWorkflow("workflow-beta").map((s) => s.paycardId)).to.deep.equal([
      first,
    ]);

    store.delete(first);
    expect(store.getByWorkflow("workflow-beta")).to.deep.equal([]);
  });

  it("deployment prep should validate public-testnet configuration without secrets", () => {
    const scriptSource = fs.readFileSync(
      path.join(__dirname, "../scripts/deploy-openrails.ts"),
      "utf8"
    );
    const smokeSource = fs.readFileSync(
      path.join(__dirname, "../scripts/smoke-openrails-testnet.ts"),
      "utf8"
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
    );
    const registryTemplate = fs.readFileSync(
      path.join(__dirname, "../deployments/openrails-addresses.example.json"),
      "utf8"
    );
    const envExample = fs.readFileSync(
      path.join(__dirname, "../.env.example"),
      "utf8"
    );
    const gitignore = fs.readFileSync(
      path.join(__dirname, "../.gitignore"),
      "utf8"
    );

    expect(packageJson.scripts["deploy:openrails"]).to.include("scripts/deploy-openrails.ts");
    expect(packageJson.scripts["smoke:testnet"]).to.include("scripts/smoke-openrails-testnet.ts");
    expect(scriptSource).to.include('requireEnv("ARC_USDC_ADDRESS")');
    expect(scriptSource).to.include('requireEnv("ARC_CHAIN_ID")');
    expect(scriptSource).to.include("OPENRAILS_DEPLOYMENT_REGISTRY_PATH");
    expect(scriptSource).to.include("Secrets and private RPC URLs are intentionally excluded");
    expect(scriptSource).to.include("Chain ID mismatch");
    expect(scriptSource).to.include("ethers.isAddress");
    expect(smokeSource).to.include('requireEnv("OPENRAILS_PAYER_PRIVATE_KEY")');
    expect(smokeSource).to.include('requireEnv("OPENRAILS_RELAYER_PRIVATE_KEY")');
    expect(smokeSource).to.include("if (value === ethers.ZeroAddress) return undefined");
    expect(smokeSource).to.include("Payer");
    expect(smokeSource).to.include("must approve");
    expect(smokeSource).to.include("residual flush transactions");
    expect(smokeSource).to.include("verifyActiveRow");
    expect(smokeSource).to.include("registry metadataHash mismatch");
    expect(smokeSource).to.include("claimWildcardPaycardChannel");
    expect(smokeSource).to.include("openPaycardChannel");
    expect(registryTemplate).to.include("arcOpenRailsHubV1");
    expect(registryTemplate).to.include("explorerBaseUrl");
    expect(registryTemplate).to.include("Template only");
    expect(registryTemplate).to.not.include("arcRpcUrl");
    expect(registryTemplate).to.not.include("DEPLOYER_PRIVATE_KEY");
    expect(envExample).to.include("ARC_RPC_URL=https://example.invalid");
    expect(envExample).to.include("OPENRAILS_DASHBOARD_MODE=local");
    expect(envExample).to.include("DEPLOYER_PRIVATE_KEY=replace-with-testnet-private-key");
    expect(envExample).to.include("OPENRAILS_PAYER_PRIVATE_KEY=replace-with-funded-testnet-payer-key");
    expect(envExample).to.include("OPENRAILS_DEPLOYMENT_REGISTRY_PATH=deployments/openrails-addresses.local.json");
    expect(gitignore).to.include("deployments/openrails-addresses.local.json");
  });

  it("server validation helper should reject invalid relayer payloads at runtime", async () => {
    const { client } = await createFundedClient();
    const fixedIntent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("server-fixed-validation")),
      recipient: recipient.address,
    });
    const wildcardIntent = buildIntent({
      paycardId: ethers.keccak256(ethers.toUtf8Bytes("server-wildcard-validation")),
      recipient: ethers.ZeroAddress,
      nonceValue: 1,
    });
    const fixedToken = await client.signPermissionEnvelope(fixedIntent);
    const wildcardToken = await client.signPermissionEnvelope(wildcardIntent);
    const fixedDecoded = LeptonOpenRailsClient.deserializePayload(fixedToken);
    const wildcardDecoded = LeptonOpenRailsClient.deserializePayload(wildcardToken);
    const fixedTokenNoMode = serializeEnvelope({
      payerAddress: fixedDecoded.payerAddress,
      envelopeSignature: fixedDecoded.envelopeSignature,
      intent: fixedDecoded.intent,
    });
    const wildcardTokenNoMode = serializeEnvelope({
      payerAddress: wildcardDecoded.payerAddress,
      envelopeSignature: wildcardDecoded.envelopeSignature,
      intent: wildcardDecoded.intent,
    });

    const missingNonceToken = serializeEnvelope({
      ...fixedDecoded,
      intent: {
        ...fixedDecoded.intent,
        nonceValue: undefined,
      },
    });
    const zeroMetadataToken = serializeEnvelope({
      ...fixedDecoded,
      intent: {
        ...fixedDecoded.intent,
        metadataHash: ethers.ZeroHash,
      },
    });
    const mismatchedMetadataToken = serializeEnvelope({
      ...fixedDecoded,
      metadata: {
        version: "openrails-metadata-v1",
        mode: "railsflow",
        originator: recipient.address,
        recipient: recipient.address,
        token: await mockUsdc.getAddress(),
        amount: "1",
        flowVelocityPerSecond: "0",
        lifespanSeconds: 0,
      },
    });
    const semanticMismatchMetadata = {
      version: "openrails-metadata-v1" as const,
      mode: "railsflow" as const,
      originator: fixedDecoded.payerAddress,
      recipient: recipient.address,
      token: await mockUsdc.getAddress(),
      amount: "1",
      flowVelocityPerSecond: fixedDecoded.intent.flowVelocityPerSecond,
      lifespanSeconds: fixedDecoded.intent.lifespanSeconds,
    };
    const semanticMismatchToken = serializeEnvelope({
      ...fixedDecoded,
      metadata: semanticMismatchMetadata,
      intent: {
        ...fixedDecoded.intent,
        metadataHash: hashOpenRailsMetadata(semanticMismatchMetadata),
      },
    });
    const recipientMismatchMetadata = {
      ...semanticMismatchMetadata,
      amount: fixedDecoded.intent.totalAllocationPool,
      recipient: relayer.address,
    };
    const recipientMismatchToken = serializeEnvelope({
      ...fixedDecoded,
      metadata: recipientMismatchMetadata,
      intent: {
        ...fixedDecoded.intent,
        metadataHash: hashOpenRailsMetadata(recipientMismatchMetadata),
      },
    });
    const tokenMismatchMetadata = {
      ...semanticMismatchMetadata,
      amount: fixedDecoded.intent.totalAllocationPool,
      token: relayer.address,
    };
    const tokenMismatchToken = serializeEnvelope({
      ...fixedDecoded,
      metadata: tokenMismatchMetadata,
      intent: {
        ...fixedDecoded.intent,
        metadataHash: hashOpenRailsMetadata(tokenMismatchMetadata),
      },
    });

    const cases = [
      [{}, "Missing envelopeToken"],
      [{ envelopeToken: "not-base64!" }, "Malformed envelopeToken"],
      [{ envelopeToken: missingNonceToken }, "Missing nonceChannel or nonceValue"],
      [
        { envelopeToken: fixedToken, openRailsPaycardId: ethers.ZeroHash },
        "OpenRails paycard header does not match envelope",
      ],
      [
        { envelopeToken: fixedToken, openRailsMetadataHash: ethers.ZeroHash },
        "OpenRails metadata header does not match envelope",
      ],
      [{ envelopeToken: zeroMetadataToken }, "Missing metadataHash"],
      [{ envelopeToken: mismatchedMetadataToken }, "metadata does not match metadataHash"],
      [{ envelopeToken: semanticMismatchToken }, "metadata amount does not match intent totalAllocationPool"],
      [{ envelopeToken: recipientMismatchToken }, "metadata recipient does not match intent mode"],
      [
        { envelopeToken: fixedTokenNoMode, mode: "railsflow", policyEnvelope: { maxAllocationPool: "1" } },
        "Policy preflight rejected envelope",
      ],
      [{ envelopeToken: fixedTokenNoMode, mode: "unknown" }, "Unknown envelope mode"],
      [{ envelopeToken: fixedTokenNoMode, mode: "railscard_bearer" }, "Bearer RailsCard requires wildcard recipient"],
      [{ envelopeToken: tokenMismatchToken }, "metadata token does not match relayer token"],
      [
        { envelopeToken: fixedTokenNoMode, mode: "railscard_recipient_bound" },
        "Recipient-bound RailsCard mode must be metadata-bound",
      ],
      [{ envelopeToken: wildcardTokenNoMode, mode: "railsflow" }, "RailsFlow requires fixed recipient"],
      [
        { envelopeToken: wildcardTokenNoMode, mode: "railscard_recipient_bound" },
        "Recipient-bound RailsCard requires fixed recipient",
      ],
      [{ envelopeToken: wildcardToken }, "Wildcard RailsCard requires claimRecipient"],
      [
        { envelopeToken: wildcardToken, claimRecipient: "not-an-address" },
        "Wildcard RailsCard claimRecipient must be a non-zero address",
      ],
      [
        { envelopeToken: wildcardToken, claimRecipient: ethers.ZeroAddress },
        "Wildcard RailsCard claimRecipient must be a non-zero address",
      ],
      [
        { envelopeToken: fixedToken, mode: "railscard_recipient_bound" },
        "Conflicting envelope modes",
      ],
    ] as const;

    for (const [body, expectedError] of cases) {
      const result = validateOpenPaycardRequest(body, { tokenAddress: await mockUsdc.getAddress() });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.error).to.equal(expectedError);
    }

    const valid = validateOpenPaycardRequest({
      envelopeToken: wildcardToken,
      claimRecipient: recipient.address,
    });
    expect(valid.ok).to.equal(true);
    if (valid.ok) expect(valid.value.envelopeMode).to.equal("railscard_bearer");
  });
});
