import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("OrUsdFaucet", function () {
  const UNIT = 10n ** 6n;
  const CLAIM_AMOUNT = 1_000n * UNIT;
  const INITIAL_RESERVE = 100_000n * UNIT;
  const COOLDOWN = 24 * 60 * 60;

  async function deployFixture() {
    const [owner, alice, bob, attacker] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory(
      "OpenRailsTestUSD",
    );

    const token = await Token.deploy();
    await token.waitForDeployment();

    const Faucet = await ethers.getContractFactory(
      "OrUsdFaucet",
    );

    const faucet = await Faucet.deploy(
      await token.getAddress(),
      owner.address,
      CLAIM_AMOUNT,
      COOLDOWN,
    );

    await faucet.waitForDeployment();

    await (
      await token.transfer(
        await faucet.getAddress(),
        INITIAL_RESERVE,
      )
    ).wait();

    return {
      owner,
      alice,
      bob,
      attacker,
      token,
      faucet,
    };
  }

  it("binds the canonical token and immutable limits", async function () {
    const { owner, token, faucet } =
      await deployFixture();

    expect(await faucet.owner()).to.equal(
      owner.address,
    );

    expect(await faucet.token()).to.equal(
      await token.getAddress(),
    );

    expect(await faucet.claimAmount()).to.equal(
      CLAIM_AMOUNT,
    );

    expect(await faucet.cooldown()).to.equal(
      COOLDOWN,
    );

    expect(
      await token.balanceOf(
        await faucet.getAddress(),
      ),
    ).to.equal(INITIAL_RESERVE);
  });

  it("transfers exactly one fixed claim", async function () {
    const { alice, token, faucet } =
      await deployFixture();

    await expect(
      faucet.connect(alice).claim(),
    )
      .to.emit(faucet, "Claimed");

    expect(
      await token.balanceOf(alice.address),
    ).to.equal(CLAIM_AMOUNT);

    expect(
      await token.balanceOf(
        await faucet.getAddress(),
      ),
    ).to.equal(
      INITIAL_RESERVE - CLAIM_AMOUNT,
    );

    const lastClaim =
      await faucet.lastClaimAt(alice.address);

    expect(lastClaim).to.be.greaterThan(0n);

    expect(
      await faucet.nextClaimAt(alice.address),
    ).to.equal(
      lastClaim + BigInt(COOLDOWN),
    );

    expect(
      await faucet.canClaim(alice.address),
    ).to.equal(false);
  });

  it("rejects repeated claims during cooldown", async function () {
    const { alice, faucet } =
      await deployFixture();

    await faucet.connect(alice).claim();

    const nextClaim =
      await faucet.nextClaimAt(alice.address);

    await expect(
      faucet.connect(alice).claim(),
    )
      .to.be.revertedWithCustomError(
        faucet,
        "CooldownActive",
      )
      .withArgs(nextClaim);
  });

  it("permits another fixed claim after cooldown", async function () {
    // Hardhat time is shared across test files. Revert this test's
    // timestamp change so later suites are not contaminated.
    const snapshotId = await ethers.provider.send(
      "evm_snapshot",
      [],
    );

    try {
      const { alice, token, faucet } =
        await deployFixture();

      await faucet.connect(alice).claim();

      await time.increase(COOLDOWN);

      expect(
        await faucet.canClaim(alice.address),
      ).to.equal(true);

      await faucet.connect(alice).claim();

      expect(
        await token.balanceOf(alice.address),
      ).to.equal(CLAIM_AMOUNT * 2n);
    } finally {
      await ethers.provider.send(
        "evm_revert",
        [snapshotId],
      );
    }
  });

  it("tracks cooldown independently per address", async function () {
    const { alice, bob, faucet } =
      await deployFixture();

    await faucet.connect(alice).claim();

    expect(
      await faucet.canClaim(alice.address),
    ).to.equal(false);

    expect(
      await faucet.canClaim(bob.address),
    ).to.equal(true);

    await faucet.connect(bob).claim();

    expect(
      await faucet.canClaim(bob.address),
    ).to.equal(false);
  });

  it("fails closed when its reserve is insufficient", async function () {
    const [owner, alice] =
      await ethers.getSigners();

    const Token = await ethers.getContractFactory(
      "OpenRailsTestUSD",
    );

    const token = await Token.deploy();
    await token.waitForDeployment();

    const Faucet = await ethers.getContractFactory(
      "OrUsdFaucet",
    );

    const faucet = await Faucet.deploy(
      await token.getAddress(),
      owner.address,
      CLAIM_AMOUNT,
      COOLDOWN,
    );

    await faucet.waitForDeployment();

    await expect(
      faucet.connect(alice).claim(),
    )
      .to.be.revertedWithCustomError(
        faucet,
        "InsufficientReserve",
      )
      .withArgs(0n, CLAIM_AMOUNT);
  });

  it("allows only the owner to pause distribution", async function () {
    const { alice, attacker, faucet } =
      await deployFixture();

    await expect(
      faucet.connect(attacker).pause(),
    )
      .to.be.revertedWithCustomError(
        faucet,
        "OwnableUnauthorizedAccount",
      )
      .withArgs(attacker.address);

    await faucet.pause();

    expect(await faucet.paused()).to.equal(true);

    expect(
      await faucet.canClaim(alice.address),
    ).to.equal(false);

    await expect(
      faucet.connect(alice).claim(),
    ).to.be.revertedWithCustomError(
      faucet,
      "EnforcedPause",
    );

    await faucet.unpause();

    await expect(
      faucet.connect(alice).claim(),
    ).to.emit(faucet, "Claimed");
  });

  it("allows only bounded reserve recovery by the owner", async function () {
    const {
      owner,
      bob,
      attacker,
      token,
      faucet,
    } = await deployFixture();

    const recoveryAmount = 2_000n * UNIT;

    await expect(
      faucet
        .connect(attacker)
        .recoverReserve(
          bob.address,
          recoveryAmount,
        ),
    )
      .to.be.revertedWithCustomError(
        faucet,
        "OwnableUnauthorizedAccount",
      )
      .withArgs(attacker.address);

    await expect(
      faucet.recoverReserve(
        ethers.ZeroAddress,
        recoveryAmount,
      ),
    ).to.be.revertedWithCustomError(
      faucet,
      "ZeroRecipient",
    );

    await expect(
      faucet.recoverReserve(
        bob.address,
        recoveryAmount,
      ),
    )
      .to.emit(faucet, "ReserveRecovered")
      .withArgs(
        bob.address,
        recoveryAmount,
      );

    expect(
      await token.balanceOf(bob.address),
    ).to.equal(recoveryAmount);

    expect(
      await token.balanceOf(owner.address),
    ).to.equal(
      10_000_000n * UNIT -
        INITIAL_RESERVE,
    );
  });

  it("rejects unsafe constructor configuration", async function () {
    const [owner] = await ethers.getSigners();

    const Token = await ethers.getContractFactory(
      "OpenRailsTestUSD",
    );

    const token = await Token.deploy();
    await token.waitForDeployment();

    const Faucet = await ethers.getContractFactory(
      "OrUsdFaucet",
    );

    await expect(
      Faucet.deploy(
        ethers.ZeroAddress,
        owner.address,
        CLAIM_AMOUNT,
        COOLDOWN,
      ),
    ).to.be.revertedWithCustomError(
      Faucet,
      "ZeroToken",
    );

    await expect(
      Faucet.deploy(
        await token.getAddress(),
        ethers.ZeroAddress,
        CLAIM_AMOUNT,
        COOLDOWN,
      ),
    )
      .to.be.revertedWithCustomError(
        Faucet,
        "OwnableInvalidOwner",
      )
      .withArgs(ethers.ZeroAddress);

    await expect(
      Faucet.deploy(
        await token.getAddress(),
        owner.address,
        0,
        COOLDOWN,
      ),
    ).to.be.revertedWithCustomError(
      Faucet,
      "ZeroClaimAmount",
    );

    await expect(
      Faucet.deploy(
        await token.getAddress(),
        owner.address,
        CLAIM_AMOUNT,
        0,
      ),
    ).to.be.revertedWithCustomError(
      Faucet,
      "ZeroCooldown",
    );
  });
});
