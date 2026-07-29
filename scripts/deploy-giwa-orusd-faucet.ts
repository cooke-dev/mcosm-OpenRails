import * as fs from "fs";
import * as path from "path";

import { ethers } from "ethers";
import { artifacts } from "hardhat";

import {
  loadEncryptedOwnerWallet,
} from "./lib/encrypted-keystore";

const GIWA_CHAIN_ID = 91_342;
const GIWA_RPC =
  process.env.GIWA_SEPOLIA_RPC_URL?.trim() ||
  "https://sepolia-rpc.giwa.io";

const EXPLORER =
  process.env.GIWA_EXPLORER_URL?.trim() ||
  "https://sepolia-explorer.giwa.io";

const ORUSD = ethers.getAddress(
  process.env.OPENRAILS_ORUSD_ADDRESS?.trim() ||
  "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De",
);

const REGISTRY_PATH = path.resolve(
  process.env.GIWA_FAUCET_REGISTRY_PATH?.trim() ||
  "deployments/giwa-orusd-faucet.json",
);

const CLAIM_AMOUNT = ethers.parseUnits("1000", 6);
const TARGET_RESERVE =
  ethers.parseUnits("100000", 6);
const COOLDOWN_SECONDS = 86_400n;

const CONFIRMATION_VALUE =
  "DEPLOY_GIWA_ORUSD_FAUCET";

const TOKEN_ABI = [
  "function owner() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address,uint256)",
];

interface FaucetRegistry {
  schemaVersion: "openrails-giwa-faucet-v1";
  network: "giwaSepolia";
  chainId: number;
  status:
    | "deployed-unfunded"
    | "funded-and-verified";
  deployedAt: string;
  updatedAt: string;
  deployer: string;
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    ownerAtDeployment: string;
  };
  faucet: {
    address: string;
    admin: string;
    claimAmountBaseUnits: string;
    claimAmount: string;
    cooldownSeconds: number;
    targetReserveBaseUnits: string;
    targetReserve: string;
    reserveAtLastVerificationBaseUnits: string;
    reserveAtLastVerification: string;
  };
  transactions: {
    deployment: string;
    funding: string | null;
  };
  blocks: {
    deployment: number;
    funding: number | null;
  };
  explorerLinks: {
    faucet: string;
    token: string;
    deploymentTransaction: string;
    fundingTransaction: string | null;
  };
  notes: string[];
}

function showHelp(): void {
  console.log(`
OpenRails GIWA orUSD faucet deployment

Default behavior:
  Preflight only. No transaction is submitted.

Preflight:
  npm run deploy:giwa-faucet

Deploy after reviewing preflight:
  OPENRAILS_FAUCET_DEPLOY_CONFIRM=${CONFIRMATION_VALUE} \\
    npm run deploy:giwa-faucet

Optional:
  OPENRAILS_KEYSTORE_PATH=/exact/path/to/keystore.json
  GIWA_SEPOLIA_RPC_URL=https://sepolia-rpc.giwa.io
  GIWA_FAUCET_REGISTRY_PATH=deployments/giwa-orusd-faucet.json
`);
}

function explorerLink(
  type: "address" | "tx",
  value: string,
): string {
  return `${EXPLORER.replace(/\/$/, "")}/${type}/${value}`;
}

function writeRegistry(
  registry: FaucetRegistry,
): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), {
    recursive: true,
  });

  const temporaryPath =
    `${REGISTRY_PATH}.tmp-${process.pid}`;

  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
  );

  fs.renameSync(temporaryPath, REGISTRY_PATH);
}

function readRegistry(): FaucetRegistry | null {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(REGISTRY_PATH, "utf8"),
  ) as FaucetRegistry;
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

async function main(): Promise<void> {
  if (
    process.argv.includes("--help") ||
    process.argv.includes("-h")
  ) {
    showHelp();
    return;
  }

  const provider =
    new ethers.JsonRpcProvider(GIWA_RPC);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== GIWA_CHAIN_ID) {
    throw new Error(
      `Expected GIWA Sepolia ${GIWA_CHAIN_ID}, received ${chainId}`,
    );
  }

  await requireContract(
    provider,
    "orUSD",
    ORUSD,
  );

  const readOnlyToken = new ethers.Contract(
    ORUSD,
    TOKEN_ABI,
    provider,
  );

  const [
    tokenOwnerRaw,
    tokenName,
    tokenSymbol,
    tokenDecimalsRaw,
  ] = await Promise.all([
    readOnlyToken.owner(),
    readOnlyToken.name(),
    readOnlyToken.symbol(),
    readOnlyToken.decimals(),
  ]);

  const tokenOwner =
    ethers.getAddress(tokenOwnerRaw);
  const tokenDecimals =
    Number(tokenDecimalsRaw);

  if (
    tokenSymbol !== "orUSD" ||
    tokenDecimals !== 6
  ) {
    throw new Error(
      `Unexpected settlement token: ${tokenSymbol}/${tokenDecimals}`,
    );
  }

  const {
    wallet,
    keystorePath,
  } = await loadEncryptedOwnerWallet(
    provider,
    tokenOwner,
  );

  if (
    ethers.getAddress(wallet.address) !==
    tokenOwner
  ) {
    throw new Error(
      "Unlocked wallet is not the current orUSD owner",
    );
  }

  const token = new ethers.Contract(
    ORUSD,
    TOKEN_ABI,
    wallet,
  );

  const artifact =
    await artifacts.readArtifact("OrUsdFaucet");

  let registry = readRegistry();
  let faucetAddress: string;
  let deploymentGas = 0n;
  let predictedAddress: string | null = null;

  if (registry) {
    if (
      registry.chainId !== GIWA_CHAIN_ID ||
      ethers.getAddress(
        registry.token.address,
      ) !== ORUSD
    ) {
      throw new Error(
        "Existing faucet registry does not match canonical GIWA/orUSD",
      );
    }

    faucetAddress = ethers.getAddress(
      registry.faucet.address,
    );

    await requireContract(
      provider,
      "Existing faucet",
      faucetAddress,
    );
  } else {
    const pendingNonce =
      await provider.getTransactionCount(
        wallet.address,
        "pending",
      );

    predictedAddress = ethers.getCreateAddress({
      from: wallet.address,
      nonce: pendingNonce,
    });

    faucetAddress = predictedAddress;

    const factory = new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode,
      wallet,
    );

    const deploymentRequest =
      await factory.getDeployTransaction(
        ORUSD,
        wallet.address,
        CLAIM_AMOUNT,
        COOLDOWN_SECONDS,
      );

    deploymentGas = await provider.estimateGas({
      ...deploymentRequest,
      from: wallet.address,
    });
  }

  const currentReserve =
    registry
      ? await readOnlyToken.balanceOf(faucetAddress)
      : 0n;

  const fundingRequired =
    currentReserve >= TARGET_RESERVE
      ? 0n
      : TARGET_RESERVE - currentReserve;

  const fundingGas =
    fundingRequired === 0n
      ? 0n
      : await token.mint.estimateGas(
          faucetAddress,
          fundingRequired,
        );

  const [
    walletBalance,
    feeData,
  ] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getFeeData(),
  ]);

  const feePerGas =
    feeData.maxFeePerGas ??
    feeData.gasPrice ??
    1_000_000_000n;

  const estimatedGasCost =
    (
      (deploymentGas + fundingGas) *
      feePerGas *
      150n
    ) / 100n;

  console.log("\nGIWA orUSD faucet preflight");
  console.log({
    chainId,
    rpc: GIWA_RPC,
    token: ORUSD,
    tokenOwner,
    wallet: wallet.address,
    keystore: keystorePath,
    existingRegistry: Boolean(registry),
    faucet: faucetAddress,
    predictedAddress,
    claimAmount: ethers.formatUnits(
      CLAIM_AMOUNT,
      6,
    ),
    cooldownSeconds:
      Number(COOLDOWN_SECONDS),
    targetReserve: ethers.formatUnits(
      TARGET_RESERVE,
      6,
    ),
    currentReserve: ethers.formatUnits(
      currentReserve,
      6,
    ),
    fundingRequired: ethers.formatUnits(
      fundingRequired,
      6,
    ),
    walletEth: ethers.formatEther(
      walletBalance,
    ),
    estimatedGasCostEth:
      ethers.formatEther(estimatedGasCost),
    registryPath: REGISTRY_PATH,
  });

  if (walletBalance < estimatedGasCost) {
    throw new Error(
      `Insufficient GIWA ETH: wallet has ` +
      `${ethers.formatEther(walletBalance)}, ` +
      `estimated requirement is ` +
      `${ethers.formatEther(estimatedGasCost)}`,
    );
  }

  const confirmed =
    process.env
      .OPENRAILS_FAUCET_DEPLOY_CONFIRM ===
    CONFIRMATION_VALUE;

  delete process.env
    .OPENRAILS_FAUCET_DEPLOY_CONFIRM;

  if (!confirmed) {
    console.log(
      "\nPreflight passed. No transaction was submitted.",
    );

    console.log(
      `To deploy, run:\n` +
      `OPENRAILS_FAUCET_DEPLOY_CONFIRM=` +
      `${CONFIRMATION_VALUE} ` +
      `npm run deploy:giwa-faucet`,
    );

    return;
  }

  if (!registry) {
    console.log("\nDeploying OrUsdFaucet...");

    const factory = new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode,
      wallet,
    );

    const faucet = await factory.deploy(
      ORUSD,
      wallet.address,
      CLAIM_AMOUNT,
      COOLDOWN_SECONDS,
    );

    const deploymentTransaction =
      faucet.deploymentTransaction();

    if (!deploymentTransaction) {
      throw new Error(
        "Faucet deployment has no transaction",
      );
    }

    const deploymentReceipt =
      await deploymentTransaction.wait();

    if (
      !deploymentReceipt ||
      deploymentReceipt.status !== 1
    ) {
      throw new Error(
        "Faucet deployment transaction failed",
      );
    }

    faucetAddress = ethers.getAddress(
      await faucet.getAddress(),
    );

    if (
      predictedAddress &&
      faucetAddress !== predictedAddress
    ) {
      throw new Error(
        `Predicted faucet ${predictedAddress}, ` +
        `deployed ${faucetAddress}`,
      );
    }

    await requireContract(
      provider,
      "Deployed faucet",
      faucetAddress,
    );

    const now = new Date().toISOString();

    registry = {
      schemaVersion:
        "openrails-giwa-faucet-v1",
      network: "giwaSepolia",
      chainId,
      status: "deployed-unfunded",
      deployedAt: now,
      updatedAt: now,
      deployer: wallet.address,
      token: {
        address: ORUSD,
        name: tokenName,
        symbol: tokenSymbol,
        decimals: tokenDecimals,
        ownerAtDeployment: tokenOwner,
      },
      faucet: {
        address: faucetAddress,
        admin: wallet.address,
        claimAmountBaseUnits:
          CLAIM_AMOUNT.toString(),
        claimAmount:
          ethers.formatUnits(
            CLAIM_AMOUNT,
            tokenDecimals,
          ),
        cooldownSeconds:
          Number(COOLDOWN_SECONDS),
        targetReserveBaseUnits:
          TARGET_RESERVE.toString(),
        targetReserve:
          ethers.formatUnits(
            TARGET_RESERVE,
            tokenDecimals,
          ),
        reserveAtLastVerificationBaseUnits:
          "0",
        reserveAtLastVerification: "0.0",
      },
      transactions: {
        deployment:
          deploymentTransaction.hash,
        funding: null,
      },
      blocks: {
        deployment:
          deploymentReceipt.blockNumber,
        funding: null,
      },
      explorerLinks: {
        faucet: explorerLink(
          "address",
          faucetAddress,
        ),
        token: explorerLink(
          "address",
          ORUSD,
        ),
        deploymentTransaction:
          explorerLink(
            "tx",
            deploymentTransaction.hash,
          ),
        fundingTransaction: null,
      },
      notes: [
        "The faucet has no mint authority.",
        "The faucet distributes only its pre-funded orUSD reserve.",
        "orUSD is test-only and is not USDC.",
        "Native GIWA ETH is not distributed by this faucet.",
      ],
    };

    writeRegistry(registry);

    console.log(
      `Faucet deployed: ${registry.explorerLinks.faucet}`,
    );
  }

  const reserveBefore =
    await readOnlyToken.balanceOf(
      faucetAddress,
    );

  const amountToFund =
    reserveBefore >= TARGET_RESERVE
      ? 0n
      : TARGET_RESERVE - reserveBefore;

  if (amountToFund > 0n) {
    console.log(
      `\nMinting ${ethers.formatUnits(
        amountToFund,
        tokenDecimals,
      )} orUSD into the faucet...`,
    );

    const fundingTransaction =
      await token.mint(
        faucetAddress,
        amountToFund,
      );

    const fundingReceipt =
      await fundingTransaction.wait();

    if (
      !fundingReceipt ||
      fundingReceipt.status !== 1
    ) {
      throw new Error(
        "Faucet funding transaction failed",
      );
    }

    registry.transactions.funding =
      fundingTransaction.hash;
    registry.blocks.funding =
      fundingReceipt.blockNumber;
    registry.explorerLinks.fundingTransaction =
      explorerLink(
        "tx",
        fundingTransaction.hash,
      );
  }

  const faucet = new ethers.Contract(
    faucetAddress,
    artifact.abi,
    provider,
  );

  const [
    configuredTokenRaw,
    configuredOwnerRaw,
    configuredClaim,
    configuredCooldown,
    finalReserve,
    paused,
  ] = await Promise.all([
    faucet.token(),
    faucet.owner(),
    faucet.claimAmount(),
    faucet.cooldown(),
    readOnlyToken.balanceOf(faucetAddress),
    faucet.paused(),
  ]);

  if (
    ethers.getAddress(configuredTokenRaw) !==
    ORUSD
  ) {
    throw new Error(
      "Faucet token configuration mismatch",
    );
  }

  if (
    ethers.getAddress(configuredOwnerRaw) !==
    ethers.getAddress(
      registry.faucet.admin,
    )
  ) {
    throw new Error(
      "Faucet admin configuration mismatch",
    );
  }

  if (configuredClaim !== CLAIM_AMOUNT) {
    throw new Error(
      "Faucet claim amount mismatch",
    );
  }

  if (
    configuredCooldown !== COOLDOWN_SECONDS
  ) {
    throw new Error(
      "Faucet cooldown mismatch",
    );
  }

  if (finalReserve < TARGET_RESERVE) {
    throw new Error(
      "Faucet reserve is below its deployment target",
    );
  }

  if (paused) {
    throw new Error(
      "Newly deployed faucet is unexpectedly paused",
    );
  }

  registry.status = "funded-and-verified";
  registry.updatedAt =
    new Date().toISOString();

  registry.faucet
    .reserveAtLastVerificationBaseUnits =
      finalReserve.toString();

  registry.faucet
    .reserveAtLastVerification =
      ethers.formatUnits(
        finalReserve,
        tokenDecimals,
      );

  writeRegistry(registry);

  console.log(
    "\nGIWA orUSD faucet deployed and verified",
  );

  console.log({
    faucet: faucetAddress,
    admin: configuredOwnerRaw,
    token: configuredTokenRaw,
    claimAmount: ethers.formatUnits(
      configuredClaim,
      tokenDecimals,
    ),
    cooldownSeconds:
      Number(configuredCooldown),
    reserve: ethers.formatUnits(
      finalReserve,
      tokenDecimals,
    ),
    remainingClaims:
      (
        finalReserve /
        configuredClaim
      ).toString(),
    registry: REGISTRY_PATH,
    explorer:
      registry.explorerLinks.faucet,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
