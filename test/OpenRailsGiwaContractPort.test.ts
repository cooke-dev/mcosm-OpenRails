import { expect } from "chai";
import { ethers } from "hardhat";

describe("OpenRails GIWA contract port", function () {
  it("deploys a six-decimal orUSD test token", async function () {
    const [deployer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory(
      "OpenRailsTestUSD",
    );
    const token = await Token.deploy();
    await token.waitForDeployment();

    expect(await token.name()).to.equal(
      "OpenRails Test USD",
    );
    expect(await token.symbol()).to.equal("orUSD");
    expect(await token.decimals()).to.equal(6n);

    expect(
      await token.balanceOf(deployer.address),
    ).to.equal(10_000_000n * 10n ** 6n);
  });

  it("deploys a chain-neutral OpenRails vault clone", async function () {
    const [deployer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory(
      "OpenRailsTestUSD",
    );
    const token = await Token.deploy();
    await token.waitForDeployment();

    const Hub = await ethers.getContractFactory(
      "OpenRailsHubV2Initializable",
    );
    const master = await Hub.deploy();
    await master.waitForDeployment();

    const Factory = await ethers.getContractFactory(
      "OpenRailsFactoryV1",
    );
    const factory = await Factory.deploy(
      await master.getAddress(),
    );
    await factory.waitForDeployment();

    await (
      await factory.deployCorporateVault(
        await token.getAddress(),
      )
    ).wait();

    const vaultAddress =
      await factory.deployedVaults(0);

    expect(
      await factory.isDeployedVault(vaultAddress),
    ).to.equal(true);

    const vault = await ethers.getContractAt(
      "OpenRailsHubV2Initializable",
      vaultAddress,
    );

    expect(await vault.owner()).to.equal(
      deployer.address,
    );

    expect(await vault.settlementToken()).to.equal(
      await token.getAddress(),
    );

    // Backward compatibility for current Arc SDK consumers.
    expect(await vault.arcUsdc()).to.equal(
      await token.getAddress(),
    );
  });
});
