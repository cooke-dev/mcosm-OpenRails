import { ethers } from 'ethers';

import {
  type OpenRailsIntentV1,
  OPENRAILS_EIP712_TYPES,
  buildOpenRailsDomain,
  buildSettlementIntentValue,
} from './client';

import {
  type CanonicalMetadataV1,
  buildMetadataBoundPaycardId,
  hashOpenRailsMetadata,
} from './metadata';

import {
  GIWA_SEPOLIA_OPENRAILS,
  type OpenRailsNetworkConfig,
} from './networks';

export interface BuildRailsFlowDraftParams {
  payerAddress: string;
  recipientAddress: string;
  totalAllocationBaseUnits: string;
  flowVelocityBaseUnitsPerSecond: string;
  genesisTimestamp: number;
  lifespanSeconds: number;
  nonceChannel: number;
  nonceValue: number;
  residualDeltaRecipient?: string;
  workflowId?: string;
  metadataRef?: string;
  salt?: string;
}

export interface RailsFlowDraft {
  network: {
    key: string;
    chainId: number;
    clearinghouseAddress: string;
    settlementTokenAddress: string;
  };

  metadata: CanonicalMetadataV1;
  metadataHash: string;
  intent: OpenRailsIntentV1;

  typedData: {
    domain: ethers.TypedDataDomain;
    types: typeof OPENRAILS_EIP712_TYPES;
    value: Record<string, unknown>;
  };

  approval: {
    tokenAddress: string;
    spender: string;
    amountBaseUnits: string;
  };

  economics: {
    totalAllocationBaseUnits: string;
    projectedFullTermAmountBaseUnits: string;
    fullyFundedForLifespan: boolean;
  };
}

function positiveBaseUnits(
  value: string,
  field: string,
): string {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `${field} must be an unsigned base-unit integer`,
    );
  }

  const parsed = BigInt(value);

  if (parsed <= 0n) {
    throw new Error(
      `${field} must be greater than zero`,
    );
  }

  return parsed.toString();
}

function safeInteger(
  value: number,
  field: string,
  allowZero: boolean,
): number {
  const minimum = allowZero ? 0 : 1;

  if (
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(
      `${field} must be a safe ${
        allowZero ? 'non-negative' : 'positive'
      } integer`,
    );
  }

  return value;
}

export function buildRailsFlowDraft(
  params: BuildRailsFlowDraftParams,
  network: OpenRailsNetworkConfig =
    GIWA_SEPOLIA_OPENRAILS,
): RailsFlowDraft {
  const payer = ethers.getAddress(
    params.payerAddress,
  );

  const recipient = ethers.getAddress(
    params.recipientAddress,
  );

  if (payer === ethers.ZeroAddress) {
    throw new Error(
      'payerAddress cannot be zero',
    );
  }

  if (recipient === ethers.ZeroAddress) {
    throw new Error(
      'recipientAddress cannot be zero',
    );
  }

  const recovery = ethers.getAddress(
    params.residualDeltaRecipient ?? payer,
  );

  if (recovery === ethers.ZeroAddress) {
    throw new Error(
      'residualDeltaRecipient cannot be zero',
    );
  }

  const allocation = positiveBaseUnits(
    params.totalAllocationBaseUnits,
    'totalAllocationBaseUnits',
  );

  const velocity = positiveBaseUnits(
    params.flowVelocityBaseUnitsPerSecond,
    'flowVelocityBaseUnitsPerSecond',
  );

  const genesisTimestamp = safeInteger(
    params.genesisTimestamp,
    'genesisTimestamp',
    false,
  );

  const lifespanSeconds = safeInteger(
    params.lifespanSeconds,
    'lifespanSeconds',
    false,
  );

  const nonceChannel = safeInteger(
    params.nonceChannel,
    'nonceChannel',
    true,
  );

  const nonceValue = safeInteger(
    params.nonceValue,
    'nonceValue',
    true,
  );

  const metadata: CanonicalMetadataV1 = {
    version: 'openrails-metadata-v1',
    mode: 'railsflow',
    originator: payer,
    recipient,
    token: network.settlementToken.address,
    amount: allocation,
    flowVelocityPerSecond: velocity,
    lifespanSeconds,
    workflowId: params.workflowId,
    metadataRef: params.metadataRef,
    expiresAt:
      genesisTimestamp + lifespanSeconds,
  };

  const metadataHash =
    hashOpenRailsMetadata(metadata);

  const paycardId =
    buildMetadataBoundPaycardId({
      payer,
      nonceChannel,
      nonceValue,
      metadataHash,
      salt:
        params.salt ??
        params.workflowId ??
        params.metadataRef ??
        network.key,
    });

  const intent: OpenRailsIntentV1 = {
    paycardId,
    metadataHash,
    recipient,
    totalAllocationPool: allocation,
    flowVelocityPerSecond: velocity,
    genesisTimestamp,
    lifespanSeconds,
    residualDeltaRecipient: recovery,
    nonceChannel,
    nonceValue,
  };

  const projectedFullTermAmount =
    BigInt(velocity) *
    BigInt(lifespanSeconds);

  return {
    network: {
      key: network.key,
      chainId: network.chainId,
      clearinghouseAddress:
        network.contracts.canonicalVault,
      settlementTokenAddress:
        network.settlementToken.address,
    },

    metadata,
    metadataHash,
    intent,

    typedData: {
      domain: buildOpenRailsDomain(
        network.chainId,
        network.contracts.canonicalVault,
      ),
      types: OPENRAILS_EIP712_TYPES,
      value:
        buildSettlementIntentValue(intent),
    },

    approval: {
      tokenAddress:
        network.settlementToken.address,
      spender:
        network.contracts.canonicalVault,
      amountBaseUnits: allocation,
    },

    economics: {
      totalAllocationBaseUnits:
        allocation,
      projectedFullTermAmountBaseUnits:
        projectedFullTermAmount.toString(),
      fullyFundedForLifespan:
        BigInt(allocation) >=
        projectedFullTermAmount,
    },
  };
}
