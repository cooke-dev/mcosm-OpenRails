import * as fs from "fs";
import * as path from "path";

import { ethers, network } from "hardhat";

const GIWA_CHAIN_ID = 91342;
const DEFAULT_EXPLORER = "https://sepolia-explorer.giwa.io";
const DEFAULT_REGISTRY = "deployments/giwa-sepolia.json";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}


async function retryRpcRead<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 20,
  delayMs = 1_500,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        console.warn(
          `${label} unavailable; retrying ${attempt}/${attempts}`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, delayMs),
        );
      }
    }
  }

  console.error(lastError);
  throw new Error(
    `${label} remained unavailable after ${attempts} attempts`,
  );
}

function explorerLink(
  explorerBaseUrl: string,
  type: "address" | "tx",
  value: string,
): string {
  return `${explorerBaseUrl.replace(/\/$/, "")}/${type}/${value}`;
}

async function deploymentRecord(label: string, contract: any) {
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();

  if (!deploymentTx) {
    throw new Error(`${label} has no deployment transaction`);
  }

  const receipt = await deploymentTx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} deployment failed`);
  }

  console.log(
    `${label}: ${address} tx=${deploymentTx.hash} block=${receipt.blockNumber}`,
  );

  return {
    address,
    txHash: deploymentTx.hash,
    blockNumber: receipt.blockNumber,
  };
}

async function main(): Promise<void> {
  const actualNetwork = await ethers.provider.getNetwork();
  const actualChainId = Number(actualNetwork.chainId);

  if (actualChainId !== GIWA_CHAIN_ID) {
    throw new Error(
      `Expected GIWA Sepolia chain ID ${GIWA_CHAIN_ID}, received ${actualChainId}`,
    );
  }

  const [deployer] = await ethers.getSigners();

  if (!deployer) {
    throw new Error(
      "No deployer signer. Set DEPLOYER_PRIVATE_KEY before deployment.",
    );
  }

  const deployerBalance = await ethers.provider.getBalance(
    deployer.address,
  );

  if (deployerBalance === 0n) {
    throw new Error(
      `Deployer ${deployer.address} has no GIWA Sepolia ETH`,
    );
  }

  const explorerBaseUrl =
    env("GIWA_EXPLORER_URL") ?? DEFAULT_EXPLORER;

  console.log("OpenRails GIWA deployment");
  console.log({
    network: network.name,
    chainId: actualChainId,
    deployer: deployer.address,
    deployerBalanceWei: deployerBalance.toString(),
  });

  let settlementTokenAddress: string;
  let tokenDeployment:
    | {
        address: string;
        txHash: string;
        blockNumber: number;
      }
    | null = null;

  const configuredToken = env(
    "OPENRAILS_SETTLEMENT_TOKEN_ADDRESS",
  );

  if (
    configuredToken &&
    configuredToken !== ethers.ZeroAddress
  ) {
    if (!ethers.isAddress(configuredToken)) {
      throw new Error(
        "OPENRAILS_SETTLEMENT_TOKEN_ADDRESS is invalid",
      );
    }

    settlementTokenAddress =
      ethers.getAddress(configuredToken);

    const code = await ethers.provider.getCode(
      settlementTokenAddress,
    );

    if (code === "0x") {
      throw new Error(
        "Configured settlement token has no contract code",
      );
    }

    console.log(
      `Using configured settlement token: ${settlementTokenAddress}`,
    );
  } else {
    const token = await ethers.deployContract(
      "OpenRailsTestUSD",
    );

    tokenDeployment = await deploymentRecord(
      "OpenRailsTestUSD",
      token,
    );

    settlementTokenAddress = tokenDeployment.address;
  }

  const master = await ethers.deployContract(
    "OpenRailsHubV2Initializable",
  );

  const masterDeployment = await deploymentRecord(
    "OpenRailsHubV2Initializable master",
    master,
  );

  const factory = await ethers.deployContract(
    "OpenRailsFactoryV1",
    [masterDeployment.address],
  );

  const factoryDeployment = await deploymentRecord(
    "OpenRailsFactoryV1",
    factory,
  );

  const vaultTx = await factory.deployCorporateVault(
    settlementTokenAddress,
  );

  console.log(
    `Canonical vault deployment submitted: ${vaultTx.hash}`,
  );

  const vaultReceipt = await vaultTx.wait();

  if (!vaultReceipt || vaultReceipt.status !== 1) {
    throw new Error("Canonical vault deployment failed");
  }

  const deployedEvent = vaultReceipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(
      (event) =>
        event?.name === "CorporateVaultDeployed",
    );

  if (!deployedEvent) {
    throw new Error(
      "CorporateVaultDeployed event was not found",
    );
  }

  const canonicalVaultAddress = ethers.getAddress(
    deployedEvent.args.vaultAddress,
  );

  await retryRpcRead(
    "Canonical vault bytecode",
    async () => {
      const code = await ethers.provider.getCode(
        canonicalVaultAddress,
      );

      if (code === "0x") {
        throw new Error(
          "Canonical vault bytecode is not readable yet",
        );
      }

      return code;
    },
  );

  const canonicalVault = await ethers.getContractAt(
    "OpenRailsHubV2Initializable",
    canonicalVaultAddress,
  );

  const [
    vaultOwner,
    vaultSettlementToken,
    registeredVault,
  ] = await retryRpcRead(
    "Canonical vault state",
    () =>
      Promise.all([
        canonicalVault.owner(),
        canonicalVault.settlementToken(),
        factory.isDeployedVault(
          canonicalVaultAddress,
        ),
      ]),
  );

  if (
    ethers.getAddress(vaultOwner) !==
    ethers.getAddress(deployer.address)
  ) {
    throw new Error("Canonical vault owner mismatch");
  }

  if (
    ethers.getAddress(vaultSettlementToken) !==
    ethers.getAddress(settlementTokenAddress)
  ) {
    throw new Error(
      "Canonical vault settlement-token mismatch",
    );
  }

  if (!registeredVault) {
    throw new Error(
      "Canonical vault is not registered by the factory",
    );
  }

  const token = new ethers.Contract(
    settlementTokenAddress,
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  );

  const [tokenName, tokenSymbol, tokenDecimals] =
    await Promise.all([
      token.name().catch(() => "Unknown"),
      token.symbol().catch(() => "UNKNOWN"),
      token.decimals().catch(() => 0n),
    ]);

  const registry = {
    schemaVersion: "openrails-deployment-v1",
    network: network.name,
    chainId: actualChainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    explorerBaseUrl,
    settlementToken: {
      address: settlementTokenAddress,
      name: tokenName,
      symbol: tokenSymbol,
      decimals: Number(tokenDecimals),
      deployment: tokenDeployment,
      classification: tokenDeployment
        ? "OpenRails GIWA test token"
        : "Externally configured ERC-20",
    },
    contracts: {
      masterImplementation: masterDeployment.address,
      factory: factoryDeployment.address,
      canonicalVault: canonicalVaultAddress,
    },
    transactions: {
      masterDeployment: masterDeployment.txHash,
      factoryDeployment: factoryDeployment.txHash,
      canonicalVaultDeployment: vaultTx.hash,
      settlementTokenDeployment:
        tokenDeployment?.txHash ?? null,
    },
    blocks: {
      masterDeployment: masterDeployment.blockNumber,
      factoryDeployment: factoryDeployment.blockNumber,
      canonicalVaultDeployment:
        vaultReceipt.blockNumber,
      settlementTokenDeployment:
        tokenDeployment?.blockNumber ?? null,
    },
    explorerLinks: {
      settlementToken: explorerLink(
        explorerBaseUrl,
        "address",
        settlementTokenAddress,
      ),
      masterImplementation: explorerLink(
        explorerBaseUrl,
        "address",
        masterDeployment.address,
      ),
      factory: explorerLink(
        explorerBaseUrl,
        "address",
        factoryDeployment.address,
      ),
      canonicalVault: explorerLink(
        explorerBaseUrl,
        "address",
        canonicalVaultAddress,
      ),
    },
    notes: [
      "Generated by scripts/deploy-giwa-openrails.ts.",
      "No private keys or private RPC credentials are included.",
      "OpenRailsTestUSD/orUSD is a test-only asset and is not USDC.",
    ],
  };

  const registryPath = path.resolve(
    env("GIWA_DEPLOYMENT_REGISTRY_PATH") ??
      DEFAULT_REGISTRY,
  );

  fs.mkdirSync(path.dirname(registryPath), {
    recursive: true,
  });

  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
  );

  console.log(
    `Deployment registry written: ${registryPath}`,
  );

  console.log(JSON.stringify(registry, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
