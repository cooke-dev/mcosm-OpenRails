import { expect } from "chai";
import { ethers } from "hardhat";

import {
  depositToGateway,
  depositForToGateway,
  mintFromGateway,
} from "../sdk/src/gateway";

// The SDK hardcodes the live Arc testnet GatewayWallet/GatewayMinter addresses by default —
// deliberately, since those are real deployed contracts a caller should hit in production. Every
// exported function also accepts an override address specifically so this suite can point at a
// local mock instead of the real network. See sdk/src/gateway.ts.
describe("Circle Gateway SDK wrapper (depositToGateway / depositForToGateway / mintFromGateway)", () => {
  async function deployFixture() {
    const [depositor, onBehalfOf] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const gatewayWallet = await (await ethers.getContractFactory("MockGatewayWallet")).deploy();
    const gatewayMinter = await (await ethers.getContractFactory("MockGatewayMinter")).deploy();

    const usdcAddress = await usdc.getAddress();
    const gatewayWalletAddress = await gatewayWallet.getAddress();
    const gatewayMinterAddress = await gatewayMinter.getAddress();

    await (await usdc.mint(depositor.address, ethers.parseUnits("1000", 6))).wait();

    return { depositor, onBehalfOf, usdc, gatewayWallet, gatewayMinter, usdcAddress, gatewayWalletAddress, gatewayMinterAddress };
  }

  it("depositToGateway auto-approves when allowance is insufficient, then deposits", async () => {
    const { depositor, usdc, gatewayWallet, usdcAddress, gatewayWalletAddress } = await deployFixture();
    const amount = ethers.parseUnits("10", 6);

    expect(await usdc.allowance(depositor.address, gatewayWalletAddress)).to.equal(0n);

    const { txHash } = await depositToGateway({
      signer: depositor,
      amountBaseUnits: amount,
      tokenAddress: usdcAddress,
      gatewayWalletAddress,
    });
    expect(txHash).to.match(/^0x[0-9a-f]{64}$/);

    expect(await gatewayWallet.totalBalance(usdcAddress, depositor.address)).to.equal(amount);
    expect(await usdc.balanceOf(gatewayWalletAddress)).to.equal(amount);
  });

  it("depositToGateway skips the approval tx when allowance is already sufficient", async () => {
    const { depositor, usdc, gatewayWallet, usdcAddress, gatewayWalletAddress } = await deployFixture();
    const amount = ethers.parseUnits("10", 6);

    // Pre-approve well above what's needed.
    await (await usdc.connect(depositor).approve(gatewayWalletAddress, ethers.parseUnits("500", 6))).wait();
    const allowanceBefore = await usdc.allowance(depositor.address, gatewayWalletAddress);

    await depositToGateway({ signer: depositor, amountBaseUnits: amount, tokenAddress: usdcAddress, gatewayWalletAddress });

    // Allowance only decreased by the deposited amount — no redundant re-approve happened.
    const allowanceAfter = await usdc.allowance(depositor.address, gatewayWalletAddress);
    expect(allowanceBefore - allowanceAfter).to.equal(amount);
    expect(await gatewayWallet.totalBalance(usdcAddress, depositor.address)).to.equal(amount);
  });

  it("depositToGateway with autoApprove: false does not submit an approval and fails without one", async () => {
    const { depositor, usdcAddress, gatewayWalletAddress } = await deployFixture();
    let threw = false;
    try {
      await depositToGateway({
        signer: depositor,
        amountBaseUnits: ethers.parseUnits("10", 6),
        tokenAddress: usdcAddress,
        gatewayWalletAddress,
        autoApprove: false,
      });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it("depositForToGateway credits the named depositor, not the tx signer", async () => {
    const { depositor, onBehalfOf, gatewayWallet, usdcAddress, gatewayWalletAddress } = await deployFixture();
    const amount = ethers.parseUnits("5", 6);

    await depositForToGateway({
      signer: depositor,
      depositor: onBehalfOf.address,
      amountBaseUnits: amount,
      tokenAddress: usdcAddress,
      gatewayWalletAddress,
    });

    expect(await gatewayWallet.totalBalance(usdcAddress, onBehalfOf.address)).to.equal(amount);
    expect(await gatewayWallet.totalBalance(usdcAddress, depositor.address)).to.equal(0n);
  });

  it("mintFromGateway submits the attestation payload and signature to the Gateway Minter", async () => {
    const { depositor, gatewayMinter, gatewayMinterAddress } = await deployFixture();
    const attestationPayload = "0x1234";
    const signature = "0x5678";

    const { txHash } = await mintFromGateway({
      signer: depositor,
      attestationPayload,
      signature,
      gatewayMinterAddress,
    });
    expect(txHash).to.match(/^0x[0-9a-f]{64}$/);

    expect(await gatewayMinter.callCount()).to.equal(1n);
    expect(await gatewayMinter.lastAttestationPayload()).to.equal(attestationPayload);
    expect(await gatewayMinter.lastSignature()).to.equal(signature);
  });
});
