import * as fs from "fs";
import * as path from "path";

import { ethers, network } from "hardhat";

const GIWA_CHAIN_ID = 91342;
const EXPLORER = "https://sepolia-explorer.giwa.io";
const REGISTRY_PATH = "deployments/giwa-sepolia.json";

const TOKEN_ADDRESS =
  "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De";

const MASTER_ADDRESS =
  "0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb";

const FACTORY_ADDRESS =
  "0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d";

const TOKEN_TX =
  "0x0fd58b4048fcc7cd3baf5351af599d89bad350edd1bceac36606577eb1d0015c";

const MASTER_TX =
  "0x249668b6f570c35fbaae12d8caf215ef46b4f2de91436c4a0202390f1cf1ce7c";

const FACTORY_TX =
  "0x3a712b3b4226dd8316fe3b6fc922c71d3e83e4d811985eeb2f0f40184beb463b";

const VAULT_TX =
  "0x62b15e164da91ca575de10cb97aa9e31c18ce8ddb4bd09fd4d12e2e88adf2b18";

async function retry<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 30,
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

async function receipt(
  label: string,
  transactionHash: string,
) {
  return retry(label, async () => {
    const result =
      await ethers.provider.getTransactionReceipt(
        transactionHash,
      );

    if (!result) {
      throw new Error(`${label} receipt not found`);
    }

    if (result.status !== 1) {
      throw new Error(`${label} reverted`);
    }

    return result;
  });
}

async function requireCode(
  label: string,
  address: string,
): Promise<void> {
  await retry(`${label} bytecode`, async () => {
    const code = await ethers.provider.getCode(address);

    if (code === "0x") {
      throw new Error(`${label} has no readable code`);
    }

    return code;
  });
}

function addressLink(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

async function main(): Promise<void> {
  const providerNetwork =
    await ethers.provider.getNetwork();

  const chainId = Number(providerNetwork.chainId);

  if (chainId !== GIWA_CHAIN_ID) {
    throw new Error(
      `Expected GIWA chain ${GIWA_CHAIN_ID}, received ${chainId}`,
    );
  }

  const [
    tokenReceipt,
    masterReceipt,
    factoryReceipt,
    vaultReceipt,
  ] = await Promise.all([
    receipt("orUSD deployment", TOKEN_TX),
    receipt("Master deployment", MASTER_TX),
    receipt("Factory deployment", FACTORY_TX),
    receipt("Canonical vault deployment", VAULT_TX),
  ]);

  if (
    ethers.getAddress(
      tokenReceipt.contractAddress ?? ethers.ZeroAddress,
    ) !== ethers.getAddress(TOKEN_ADDRESS)
  ) {
    throw new Error("orUSD deployment address mismatch");
  }

  if (
    ethers.getAddress(
      masterReceipt.contractAddress ?? ethers.ZeroAddress,
    ) !== ethers.getAddress(MASTER_ADDRESS)
  ) {
    throw new Error("Master deployment address mismatch");
  }

  if (
    ethers.getAddress(
      factoryReceipt.contractAddress ?? ethers.ZeroAddress,
    ) !== ethers.getAddress(FACTORY_ADDRESS)
  ) {
    throw new Error("Factory deployment address mismatch");
  }

  await Promise.all([
    requireCode("orUSD", TOKEN_ADDRESS),
    requireCode("Master implementation", MASTER_ADDRESS),
    requireCode("Factory", FACTORY_ADDRESS),
  ]);

  const factory = await ethers.getContractAt(
    "OpenRailsFactoryV1",
    FACTORY_ADDRESS,
  );

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
      "CorporateVaultDeployed event not found in vault transaction",
    );
  }

  const canonicalVaultAddress = ethers.getAddress(
    deployedEvent.args.vaultAddress,
  );

  await requireCode(
    "Canonical vault",
    canonicalVaultAddress,
  );

  const vault = await ethers.getContractAt(
    "OpenRailsHubV2Initializable",
    canonicalVaultAddress,
  );

  const token = new ethers.Contract(
    TOKEN_ADDRESS,
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  );

  const vaultTransaction =
    await ethers.provider.getTransaction(VAULT_TX);

  if (!vaultTransaction) {
    throw new Error(
      "Canonical vault transaction is unavailable",
    );
  }

  const deployer = ethers.getAddress(
    vaultTransaction.from,
  );

  const [
    configuredMaster,
    registeredVault,
    vaultOwner,
    vaultToken,
    tokenName,
    tokenSymbol,
    tokenDecimals,
  ] = await retry(
    "Recovered deployment state",
    () =>
      Promise.all([
        factory.masterLogicHub(),
        factory.isDeployedVault(
          canonicalVaultAddress,
        ),
        vault.owner(),
        vault.settlementToken(),
        token.name(),
        token.symbol(),
        token.decimals(),
      ]),
  );

  if (
    ethers.getAddress(configuredMaster) !==
    ethers.getAddress(MASTER_ADDRESS)
  ) {
    throw new Error(
      "Factory master implementation mismatch",
    );
  }

  if (!registeredVault) {
    throw new Error(
      "Canonical vault is not registered by factory",
    );
  }

  if (
    ethers.getAddress(vaultOwner) !== deployer
  ) {
    throw new Error("Canonical vault owner mismatch");
  }

  if (
    ethers.getAddress(vaultToken) !==
    ethers.getAddress(TOKEN_ADDRESS)
  ) {
    throw new Error(
      "Canonical vault settlement-token mismatch",
    );
  }

  const registry = {
    schemaVersion: "openrails-deployment-v1",
    network: network.name,
    chainId,
    deployer,
    deployedAt: new Date(
      Number(vaultReceipt.blockNumber) * 0 +
        Date.now(),
    ).toISOString(),
    explorerBaseUrl: EXPLORER,
    settlementToken: {
      address: TOKEN_ADDRESS,
      name: tokenName,
      symbol: tokenSymbol,
      decimals: Number(tokenDecimals),
      classification:
        "OpenRails GIWA test token",
      deployment: {
        address: TOKEN_ADDRESS,
        txHash: TOKEN_TX,
        blockNumber: tokenReceipt.blockNumber,
      },
    },
    contracts: {
      masterImplementation: MASTER_ADDRESS,
      factory: FACTORY_ADDRESS,
      canonicalVault: canonicalVaultAddress,
    },
    transactions: {
      settlementTokenDeployment: TOKEN_TX,
      masterDeployment: MASTER_TX,
      factoryDeployment: FACTORY_TX,
      canonicalVaultDeployment: VAULT_TX,
    },
    blocks: {
      settlementTokenDeployment:
        tokenReceipt.blockNumber,
      masterDeployment: masterReceipt.blockNumber,
      factoryDeployment:
        factoryReceipt.blockNumber,
      canonicalVaultDeployment:
        vaultReceipt.blockNumber,
    },
    explorerLinks: {
      settlementToken: addressLink(TOKEN_ADDRESS),
      masterImplementation:
        addressLink(MASTER_ADDRESS),
      factory: addressLink(FACTORY_ADDRESS),
      canonicalVault:
        addressLink(canonicalVaultAddress),
    },
    notes: [
      "Recovered from confirmed GIWA Sepolia transactions.",
      "No private keys or private RPC credentials are included.",
      "OpenRailsTestUSD/orUSD is test-only and is not USDC.",
    ],
  };

  const registryPath = path.resolve(
    process.env.GIWA_DEPLOYMENT_REGISTRY_PATH?.trim() ||
      REGISTRY_PATH,
  );

  fs.mkdirSync(path.dirname(registryPath), {
    recursive: true,
  });

  fs.writeFileSync(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
  );

  console.log(
    "Existing OpenRails GIWA deployment recovered",
  );

  console.log({
    chainId,
    deployer,
    token: TOKEN_ADDRESS,
    master: MASTER_ADDRESS,
    factory: FACTORY_ADDRESS,
    canonicalVault: canonicalVaultAddress,
    vaultTransaction: VAULT_TX,
    registryPath,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
