import { ethers } from 'ethers';
import {
  buildMetadataBoundPaycardId,
  hashOpenRailsMetadata,
  readNonce,
  readPaycard,
  readTokenBalance,
  type CanonicalMetadataV1,
  type OpenRailsIntentV1,
} from 'openrails-sdk';
import type { OpenRailsContext } from './context.js';

const EIP712_TYPES = {
  SettlementIntent: [
    { name: 'paycardId', type: 'bytes32' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'totalAllocationPool', type: 'uint256' },
    { name: 'flowVelocityPerSecond', type: 'uint256' },
    { name: 'genesisTimestamp', type: 'uint256' },
    { name: 'lifespanSeconds', type: 'uint256' },
    { name: 'residualDeltaRecipient', type: 'address' },
    { name: 'nonceChannel', type: 'uint256' },
    { name: 'nonceValue', type: 'uint256' },
  ],
} as const;

const asProvider = (ctx: OpenRailsContext): any => ctx.provider;

function positiveIntegerString(value: string, field: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${field} must be an unsigned base-unit integer`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`${field} must be greater than zero`);
  }
  return parsed;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function bytes32(value: string, field: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`${field} must be a bytes32 hex string`);
  }
  return value;
}

function explorerAddress(ctx: OpenRailsContext, address: string): string {
  return `${ctx.config.explorerBaseUrl}/address/${address}`;
}

function explorerTransaction(ctx: OpenRailsContext, hash: string): string {
  return `${ctx.config.explorerBaseUrl}/tx/${hash}`;
}

export async function networkInfo(ctx: OpenRailsContext) {
  return {
    network: {
      ...ctx.config,
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
    },
    deployment: {
      token: explorerAddress(ctx, ctx.config.tokenAddress),
      vault: explorerAddress(ctx, ctx.config.vaultAddress),
      factory: explorerAddress(ctx, ctx.config.factoryAddress),
      master: explorerAddress(ctx, ctx.config.masterAddress),
    },
    safety: {
      settlementTokenIsTestOnly: true,
      settlementTokenIsUsdc: false,
      acceptsPrivateKeys: false,
      signsIntents: false,
      submitsTransactions: false,
      holdsFunds: false,
      canonicalReadsUseStandardRpc: true,
      flashblocksRpcIsUxOnly: true,
    },
  };
}

export async function getBalance(
  ctx: OpenRailsContext,
  args: { address: string },
) {
  const address = ethers.getAddress(args.address);
  const balance = await readTokenBalance(
    asProvider(ctx),
    ctx.config.tokenAddress,
    address,
  );

  return {
    address,
    token: ctx.config.tokenAddress,
    symbol: ctx.config.tokenSymbol,
    decimals: ctx.config.tokenDecimals,
    balanceBaseUnits: balance.toString(),
    balanceFormatted: ethers.formatUnits(
      balance,
      ctx.config.tokenDecimals,
    ),
  };
}

export async function getNonce(
  ctx: OpenRailsContext,
  args: { payerAddress: string; nonceChannel?: number },
) {
  const payerAddress = ethers.getAddress(args.payerAddress);
  const nonceChannel = nonNegativeSafeInteger(
    args.nonceChannel ?? 0,
    'nonceChannel',
  );
  const nonceValue = await readNonce(
    asProvider(ctx),
    ctx.config.vaultAddress,
    payerAddress,
    nonceChannel,
  );

  return {
    payerAddress,
    nonceChannel,
    nonceValue,
    vaultAddress: ctx.config.vaultAddress,
  };
}

export async function getPaycard(
  ctx: OpenRailsContext,
  args: { paycardId: string },
) {
  const paycardId = bytes32(args.paycardId, 'paycardId');
  const card = await readPaycard(
    asProvider(ctx),
    ctx.config.vaultAddress,
    paycardId,
  );

  return {
    paycardId,
    ...card,
    totalAllocationFormatted: ethers.formatUnits(
      card.totalAllocationPool,
      ctx.config.tokenDecimals,
    ),
    availableBalanceFormatted: ethers.formatUnits(
      card.availableBalance,
      ctx.config.tokenDecimals,
    ),
    explorer: {
      payer: explorerAddress(ctx, card.payer),
      recipient: explorerAddress(ctx, card.recipient),
    },
  };
}

export interface PrepareRailsFlowArgs {
  payerAddress: string;
  recipientAddress: string;
  totalAllocationBaseUnits: string;
  flowVelocityBaseUnitsPerSecond: string;
  lifespanSeconds: number;
  nonceChannel?: number;
  residualDeltaRecipient?: string;
  workflowId?: string;
  metadataRef?: string;
  salt?: string;
}

export async function prepareRailsFlow(
  ctx: OpenRailsContext,
  args: PrepareRailsFlowArgs,
) {
  const payerAddress = ethers.getAddress(args.payerAddress);
  const recipientAddress = ethers.getAddress(args.recipientAddress);
  const residualDeltaRecipient = ethers.getAddress(
    args.residualDeltaRecipient ?? payerAddress,
  );

  const totalAllocation = positiveIntegerString(
    args.totalAllocationBaseUnits,
    'totalAllocationBaseUnits',
  );
  const flowVelocity = positiveIntegerString(
    args.flowVelocityBaseUnitsPerSecond,
    'flowVelocityBaseUnitsPerSecond',
  );

  const lifespanSeconds = nonNegativeSafeInteger(
    args.lifespanSeconds,
    'lifespanSeconds',
  );
  if (lifespanSeconds === 0) {
    throw new Error(
      'lifespanSeconds must be greater than zero for a RailsFlow stream',
    );
  }

  const nonceChannel = nonNegativeSafeInteger(
    args.nonceChannel ?? 0,
    'nonceChannel',
  );

  const [nonceValue, latestBlock] = await Promise.all([
    readNonce(
      asProvider(ctx),
      ctx.config.vaultAddress,
      payerAddress,
      nonceChannel,
    ),
    ctx.provider.getBlock('latest'),
  ]);

  if (!latestBlock) {
    throw new Error('Unable to read the latest GIWA block');
  }

  const genesisTimestamp = latestBlock.timestamp;
  const expiresAt = genesisTimestamp + lifespanSeconds;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('genesisTimestamp + lifespanSeconds exceeds safe integer range');
  }

  const metadata: CanonicalMetadataV1 = {
    version: 'openrails-metadata-v1',
    mode: 'railsflow',
    originator: payerAddress,
    recipient: recipientAddress,
    token: ctx.config.tokenAddress,
    amount: totalAllocation.toString(),
    flowVelocityPerSecond: flowVelocity.toString(),
    lifespanSeconds,
    workflowId: args.workflowId,
    metadataRef: args.metadataRef ?? 'openrails-giwa-mcp',
    expiresAt,
  };

  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({
    payer: payerAddress,
    nonceChannel,
    nonceValue,
    metadataHash,
    salt: args.salt,
  });

  const intent: OpenRailsIntentV1 = {
    paycardId,
    metadataHash,
    recipient: recipientAddress,
    totalAllocationPool: totalAllocation.toString(),
    flowVelocityPerSecond: flowVelocity.toString(),
    genesisTimestamp,
    lifespanSeconds,
    residualDeltaRecipient,
    nonceChannel,
    nonceValue,
  };

  const projectedStreamedAmount =
    flowVelocity * BigInt(lifespanSeconds);
  const fundingSufficient =
    totalAllocation >= projectedStreamedAmount;
  const projectedResidual =
    fundingSufficient
      ? totalAllocation - projectedStreamedAmount
      : 0n;

  return {
    mode: 'railsflow',
    network: {
      chainId: ctx.config.chainId,
      name: ctx.config.chainName,
      rpcUrl: ctx.config.rpcUrl,
    },
    metadata,
    metadataHash,
    paycardId,
    intent,
    typedData: {
      domain: {
        name: 'OpenRails Network',
        version: '2.0.0',
        chainId: ctx.config.chainId,
        verifyingContract: ctx.config.vaultAddress,
      },
      types: EIP712_TYPES,
      primaryType: 'SettlementIntent',
      message: intent,
    },
    approval: {
      token: ctx.config.tokenAddress,
      spender: ctx.config.vaultAddress,
      amountBaseUnits: totalAllocation.toString(),
    },
    economics: {
      projectedStreamedAmountBaseUnits:
        projectedStreamedAmount.toString(),
      projectedResidualBaseUnits:
        projectedResidual.toString(),
      fundingSufficient,
      warning: fundingSufficient
        ? null
        : 'Total allocation is lower than velocity multiplied by lifespan.',
    },
    safety: {
      unsigned: true,
      signerRequiredExternally: true,
      transactionSubmitted: false,
      privateKeyAccepted: false,
    },
  };
}

export function transactionExplorerUrl(
  ctx: OpenRailsContext,
  transactionHash: string,
): string {
  return explorerTransaction(ctx, transactionHash);
}
