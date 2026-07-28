import * as fs from "fs";
import * as path from "path";

import { ethers } from "hardhat";

const GIWA_CHAIN_ID = 91342;
const DEFAULT_REGISTRY =
  "deployments/giwa-sepolia.json";

interface DeploymentRegistry {
  chainId: number;
  deployer: string;
  settlementToken: {
    address: string;
    symbol: string;
    decimals: number;
  };
  contracts: {
    masterImplementation: string;
    factory: string;
    canonicalVault: string;
  };
}

function registryPath(): string {
  return path.resolve(
    process.env.GIWA_DEPLOYMENT_REGISTRY_PATH?.trim() ||
      DEFAULT_REGISTRY,
  );
}

async function requireContract(
  label: string,
  address: string,
): Promise<void> {
  if (!ethers.isAddress(address)) {
    throw new Error(`${label} has an invalid address`);
  }

  const code = await ethers.provider.getCode(address);

  if (code === "0x") {
    throw new Error(`${label} has no contract code`);
  }
}

async function main(): Promise<void> {
  const filePath = registryPath();

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Deployment registry does not exist: ${filePath}`,
    );
  }

  const registry = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as DeploymentRegistry;

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (
    chainId !== GIWA_CHAIN_ID ||
    registry.chainId !== GIWA_CHAIN_ID
  ) {
    throw new Error(
      `GIWA chain mismatch: provider=${chainId} registry=${registry.chainId}`,
    );
  }

  await Promise.all([
    requireContract(
      "Settlement token",
      registry.settlementToken.address,
    ),
    requireContract(
      "Master implementation",
      registry.contracts.masterImplementation,
    ),
    requireContract(
      "Factory",
      registry.contracts.factory,
    ),
    requireContract(
      "Canonical vault",
      registry.contracts.canonicalVault,
    ),
  ]);

  const factory = await ethers.getContractAt(
    "OpenRailsFactoryV1",
    registry.contracts.factory,
  );

  const vault = await ethers.getContractAt(
    "OpenRailsHubV2Initializable",
    registry.contracts.canonicalVault,
  );

  const token = new ethers.Contract(
    registry.settlementToken.address,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  );

  const [
    configuredMaster,
    registeredVault,
    vaultOwner,
    vaultToken,
    symbol,
    decimals,
  ] = await Promise.all([
    factory.masterLogicHub(),
    factory.isDeployedVault(
      registry.contracts.canonicalVault,
    ),
    vault.owner(),
    vault.settlementToken(),
    token.symbol(),
    token.decimals(),
  ]);

  if (
    ethers.getAddress(configuredMaster) !==
    ethers.getAddress(
      registry.contracts.masterImplementation,
    )
  ) {
    throw new Error("Factory master implementation mismatch");
  }

  if (!registeredVault) {
    throw new Error(
      "Canonical vault is not registered by factory",
    );
  }

  if (
    ethers.getAddress(vaultOwner) !==
    ethers.getAddress(registry.deployer)
  ) {
    throw new Error("Canonical vault owner mismatch");
  }

  if (
    ethers.getAddress(vaultToken) !==
    ethers.getAddress(
      registry.settlementToken.address,
    )
  ) {
    throw new Error(
      "Canonical vault settlement-token mismatch",
    );
  }

  console.log("GIWA OpenRails deployment verified");
  console.log({
    chainId,
    token: registry.settlementToken.address,
    tokenSymbol: symbol,
    tokenDecimals: Number(decimals),
    master: configuredMaster,
    factory: registry.contracts.factory,
    canonicalVault:
      registry.contracts.canonicalVault,
    owner: vaultOwner,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
