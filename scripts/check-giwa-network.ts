import { ethers } from "hardhat";

async function main(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  const latestBlock = await ethers.provider.getBlockNumber();
  const feeData = await ethers.provider.getFeeData();

  if (network.chainId !== 91342n) {
    throw new Error(
      `Expected GIWA Sepolia chain ID 91342, received ${network.chainId}`,
    );
  }

  console.log("GIWA Sepolia connection successful");
  console.log({
    chainId: network.chainId.toString(),
    latestBlock,
    gasPriceWei: feeData.gasPrice?.toString() ?? null,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
