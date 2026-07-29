import * as fs from "fs";
import * as path from "path";

import { ethers } from "ethers";
import { artifacts } from "hardhat";

const GIWA_CHAIN_ID = 91_342;

const RPC =
  process.env.GIWA_SEPOLIA_RPC_URL?.trim() ||
  "https://sepolia-rpc.giwa.io";

const REGISTRY_PATH = path.resolve(
  process.env.GIWA_FAUCET_REGISTRY_PATH?.trim() ||
  "deployments/giwa-orusd-faucet.json",
);

interface FaucetRegistry {
  chainId: number;
  status: string;
  token: {
    address: string;
    symbol: string;
    decimals: number;
  };
  faucet: {
    address: string;
    admin: string;
    claimAmountBaseUnits: string;
    cooldownSeconds: number;
  };
  transactions: {
    deployment: string;
    funding: string | null;
  };
}

function showHelp(): void {
  console.log(`
Verify the canonical GIWA Sepolia orUSD faucet.

Usage:
  npm run verify:giwa-faucet

Optional:
  GIWA_SEPOLIA_RPC_URL=https://sepolia-rpc.giwa.io
  GIWA_FAUCET_REGISTRY_PATH=deployments/giwa-orusd-faucet.json
`);
}

async function requireContract(
  provider: ethers.Provider,
  label: string,
  address: string,
): Promise<void> {
  if (!ethers.isAddress(address)) {
    throw new Error(`${label} has an invalid address`);
  }

  const code = await provider.getCode(address);

  if (code === "0x") {
    throw new Error(`${label} has no contract code`);
  }
}

async function requireSuccessfulTransaction(
  provider: ethers.Provider,
  label: string,
  transactionHash: string | null,
): Promise<void> {
  if (!transactionHash) {
    return;
  }

  const receipt =
    await provider.getTransactionReceipt(
      transactionHash,
    );

  if (!receipt || receipt.status !== 1) {
    throw new Error(
      `${label} transaction is missing or failed`,
    );
  }
}

async function main(): Promise<void> {
  if (
    process.argv.includes("--help") ||
    process.argv.includes("-h")
  ) {
    showHelp();
    return;
  }

  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(
      `Faucet registry does not exist: ${REGISTRY_PATH}`,
    );
  }

  const registry = JSON.parse(
    fs.readFileSync(REGISTRY_PATH, "utf8"),
  ) as FaucetRegistry;

  const provider =
    new ethers.JsonRpcProvider(RPC);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  if (
    chainId !== GIWA_CHAIN_ID ||
    registry.chainId !== GIWA_CHAIN_ID
  ) {
    throw new Error(
      `GIWA chain mismatch: provider=${chainId} ` +
      `registry=${registry.chainId}`,
    );
  }

  const tokenAddress =
    ethers.getAddress(
      registry.token.address,
    );

  const faucetAddress =
    ethers.getAddress(
      registry.faucet.address,
    );

  await Promise.all([
    requireContract(
      provider,
      "orUSD",
      tokenAddress,
    ),
    requireContract(
      provider,
      "orUSD faucet",
      faucetAddress,
    ),
    requireSuccessfulTransaction(
      provider,
      "Deployment",
      registry.transactions.deployment,
    ),
    requireSuccessfulTransaction(
      provider,
      "Funding",
      registry.transactions.funding,
    ),
  ]);

  const artifact =
    await artifacts.readArtifact("OrUsdFaucet");

  const faucet = new ethers.Contract(
    faucetAddress,
    artifact.abi,
    provider,
  );

  const token = new ethers.Contract(
    tokenAddress,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function balanceOf(address) view returns (uint256)",
    ],
    provider,
  );

  const [
    configuredTokenRaw,
    configuredOwnerRaw,
    claimAmount,
    cooldown,
    paused,
    symbol,
    decimalsRaw,
    reserve,
  ] = await Promise.all([
    faucet.token(),
    faucet.owner(),
    faucet.claimAmount(),
    faucet.cooldown(),
    faucet.paused(),
    token.symbol(),
    token.decimals(),
    token.balanceOf(faucetAddress),
  ]);

  const configuredToken =
    ethers.getAddress(configuredTokenRaw);

  const configuredOwner =
    ethers.getAddress(configuredOwnerRaw);

  const decimals = Number(decimalsRaw);

  if (configuredToken !== tokenAddress) {
    throw new Error(
      "Faucet settlement-token mismatch",
    );
  }

  if (
    configuredOwner !==
    ethers.getAddress(
      registry.faucet.admin,
    )
  ) {
    throw new Error(
      "Faucet admin mismatch",
    );
  }

  if (
    claimAmount.toString() !==
    registry.faucet.claimAmountBaseUnits
  ) {
    throw new Error(
      "Faucet claim amount mismatch",
    );
  }

  if (
    Number(cooldown) !==
    registry.faucet.cooldownSeconds
  ) {
    throw new Error(
      "Faucet cooldown mismatch",
    );
  }

  if (
    symbol !== registry.token.symbol ||
    decimals !== registry.token.decimals
  ) {
    throw new Error(
      "orUSD metadata mismatch",
    );
  }

  const remainingClaims =
    claimAmount === 0n
      ? 0n
      : reserve / claimAmount;

  const operational =
    !paused &&
    reserve >= claimAmount;

  console.log(
    "GIWA orUSD faucet verified",
  );

  console.log({
    chainId,
    registryStatus: registry.status,
    faucet: faucetAddress,
    token: tokenAddress,
    symbol,
    decimals,
    admin: configuredOwner,
    claimAmount:
      ethers.formatUnits(
        claimAmount,
        decimals,
      ),
    cooldownSeconds: Number(cooldown),
    reserve:
      ethers.formatUnits(
        reserve,
        decimals,
      ),
    remainingClaims:
      remainingClaims.toString(),
    paused,
    operational,
    registry: REGISTRY_PATH,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
