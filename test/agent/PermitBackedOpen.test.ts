import { expect } from "chai";
import { ethers } from "hardhat";
import { LeptonOpenRailsClient, type OpenRailsIntentV1 } from "../../sdk/src/client";
import { ethersToSubmitter } from "../../sdk/src/adapters/ethers";
import { signUsdcPermit } from "../../sdk/src/permit";

function buildIntent(overrides: Partial<OpenRailsIntentV1> = {}): OpenRailsIntentV1 {
  const metadataHash = overrides.metadataHash ?? ethers.keccak256(ethers.toUtf8Bytes(`permit-metadata-${Date.now()}`));
  return {
    paycardId: overrides.paycardId ?? ethers.keccak256(ethers.toUtf8Bytes(`permit-paycard-${metadataHash}`)),
    metadataHash,
    recipient: overrides.recipient!,
    totalAllocationPool: overrides.totalAllocationPool ?? ethers.parseUnits("3", 6).toString(),
    flowVelocityPerSecond: overrides.flowVelocityPerSecond ?? ethers.parseUnits("0.01", 6).toString(),
    genesisTimestamp: overrides.genesisTimestamp ?? Math.floor(Date.now() / 1000) - 5,
    lifespanSeconds: overrides.lifespanSeconds ?? 300,
    residualDeltaRecipient: overrides.residualDeltaRecipient!,
    nonceChannel: overrides.nonceChannel ?? 2612,
    nonceValue: overrides.nonceValue ?? 0,
  };
}

// Ported from the successor repo's X-Layer-targeted variant, retargeted onto our own existing
// ArcOpenRailsHubV1 (V1-style 11-arg openPaycardChannel, ecrecover-only) — same interface shape
// as the successor's XLayerOpenRailsHubV1, so no new chain-specific Hub clone is needed.
describe("Arc permit-backed Paycard open", () => {
  it("uses EIP-2612 permit allowance for hub safeTransferFrom during gasless open", async () => {
    const [deployer, relayer, recipient, recoveryVault] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    const Token = await ethers.getContractFactory("MockUSDCPermit");
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Hub = await ethers.getContractFactory("ArcOpenRailsHubV1");
    const hub = await Hub.deploy(await token.getAddress());
    await hub.waitForDeployment();

    const payerWallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await deployer.sendTransaction({ to: payerWallet.address, value: ethers.parseEther("1") });

    const allocation = ethers.parseUnits("3", 6);
    await token.mint(payerWallet.address, allocation);
    expect(await token.allowance(payerWallet.address, await hub.getAddress())).to.equal(0n);

    const permit = await signUsdcPermit(ethersToSubmitter(payerWallet), {
      token: await token.getAddress(),
      spender: await hub.getAddress(),
      value: allocation,
      chainId,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      provider: ethers.provider,
    });

    await token.connect(relayer).permit(
      permit.owner,
      permit.spender,
      permit.value,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    );

    expect(await token.allowance(payerWallet.address, await hub.getAddress())).to.equal(allocation);

    const client = new LeptonOpenRailsClient(
      payerWallet.privateKey,
      await hub.getAddress(),
      chainId,
      undefined,
      10_000_000,
      "1.0.0",
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    const intent = buildIntent({
      recipient: recipient.address,
      residualDeltaRecipient: recoveryVault.address,
      totalAllocationPool: allocation.toString(),
      genesisTimestamp: Number(latestBlock!.timestamp) - 5,
    });
    const envelope = LeptonOpenRailsClient.deserializePayload(await client.signPermissionEnvelope(intent));

    await expect(hub.connect(relayer).openPaycardChannel(
      envelope.intent.paycardId,
      envelope.intent.metadataHash,
      envelope.intent.recipient,
      envelope.intent.totalAllocationPool,
      envelope.intent.flowVelocityPerSecond,
      envelope.intent.genesisTimestamp,
      envelope.intent.lifespanSeconds,
      envelope.intent.residualDeltaRecipient,
      envelope.envelopeSignature,
      envelope.intent.nonceChannel,
      envelope.intent.nonceValue,
    )).to.emit(hub, "PaycardProvisioned");

    expect(await token.balanceOf(payerWallet.address)).to.equal(0n);
    expect(await token.balanceOf(await hub.getAddress())).to.equal(allocation);
    expect(await token.allowance(payerWallet.address, await hub.getAddress())).to.equal(0n);

    const card = await hub.registry(intent.paycardId);
    expect(card.payer).to.equal(payerWallet.address);
    expect(card.recipient).to.equal(recipient.address);
    expect(card.availableBalance).to.equal(allocation);
    expect(card.operationalStatus).to.equal(0);
  });
});
