import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    arcTestnet: {
      url: process.env.ARC_RPC_URL || "",
      chainId: process.env.ARC_CHAIN_ID ? Number(process.env.ARC_CHAIN_ID) : undefined,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    giwaSepolia: {
      url:
        process.env.GIWA_SEPOLIA_RPC_URL ||
        "https://sepolia-rpc.giwa.io",
      chainId: 91342,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
};

export default config;
