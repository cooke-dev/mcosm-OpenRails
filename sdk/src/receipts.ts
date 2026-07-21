/**
 * @module receipts
 * @description Durable, typed, per-event-kind receipts (`OpenRailsReceipt`) — the richer of
 * OpenRails' two proof vocabularies, meant for durable/user-facing records (e.g. the cockpit's
 * receipt export). Each receipt type carries the full structured fields for that specific event.
 *
 * The other vocabulary, {@link module:proof}'s `ProofOfPayableV1`, is a single flexible shape
 * covering every lifecycle stage with mostly-optional fields — meant for inline API responses
 * where the exact stage isn't known statically (used by the legacy `server/index.ts`). Convert a
 * receipt into that shape with {@link proofFromReceipt} in `./proof` when you need to interop
 * with code expecting the lighter shape; there is no lossless conversion the other direction
 * (`ProofOfPayableV1` doesn't carry the type-specific fields a receipt does).
 *
 * New integrations should generally reach for receipts, not proofs — they're the one with
 * `parseReceipt`'s version/type/metadata-hash validation.
 */
import { type CanonicalMetadataV1, hashOpenRailsMetadata } from './metadata';

export type OpenRailsReceiptType =
  | 'payment_opened'
  | 'settlement_processed'
  | 'residual_recovered';

export interface OpenRailsReceiptBase {
  version: 'openrails-receipt-v1';
  type: OpenRailsReceiptType;
  chainId: number;
  hub: string;
  token: string;
  paycardId: string;
  metadataHash: string;
  payer: string;
  recipient: string;
  txHash: string;
  blockNumber?: number;
  issuedAt: number;
  metadata?: CanonicalMetadataV1;
}

export interface OpenRailsPaymentReceipt extends OpenRailsReceiptBase {
  type: 'payment_opened';
  totalAllocationPool: string;
  flowVelocityPerSecond: string;
  lifespanSeconds: number;
  residualDeltaRecipient: string;
  nonceChannel: number;
  nonceValue: number;
}

export interface OpenRailsSettlementReceipt extends OpenRailsReceiptBase {
  type: 'settlement_processed';
  settledAmount: string;
  remainingAvailableBalance?: string;
}

export interface OpenRailsResidualReceipt extends OpenRailsReceiptBase {
  type: 'residual_recovered';
  recoveredAmount: string;
  recoveryStatus: 'residual_recovered' | 'no_residual_remaining';
  note?: string;
  finalStatus: 'Terminated';
}

export type OpenRailsReceipt =
  | OpenRailsPaymentReceipt
  | OpenRailsSettlementReceipt
  | OpenRailsResidualReceipt;

export interface CreatePaymentReceiptParams {
  chainId: number;
  hub: string;
  token: string;
  paycardId: string;
  metadataHash: string;
  payer: string;
  recipient: string;
  txHash: string;
  blockNumber?: number;
  issuedAt?: number;
  totalAllocationPool: string;
  flowVelocityPerSecond: string;
  lifespanSeconds: number;
  residualDeltaRecipient: string;
  nonceChannel: number;
  nonceValue: number;
  metadata?: CanonicalMetadataV1;
}

export interface CreateSettlementReceiptParams {
  chainId: number;
  hub: string;
  token: string;
  paycardId: string;
  metadataHash: string;
  payer: string;
  recipient: string;
  txHash: string;
  blockNumber?: number;
  issuedAt?: number;
  settledAmount: string;
  remainingAvailableBalance?: string;
  metadata?: CanonicalMetadataV1;
}

export interface CreateResidualRecoveryReceiptParams {
  chainId: number;
  hub: string;
  token: string;
  paycardId: string;
  metadataHash: string;
  payer: string;
  recipient: string;
  txHash: string;
  blockNumber?: number;
  issuedAt?: number;
  recoveredAmount: string;
  recoveryStatus?: 'residual_recovered' | 'no_residual_remaining';
  note?: string;
  metadata?: CanonicalMetadataV1;
}

export function verifyReceiptMetadataHash(
  metadataHash: string,
  metadata?: CanonicalMetadataV1,
): boolean {
  return !metadata || hashOpenRailsMetadata(metadata) === metadataHash;
}

function assertReceiptMetadata(metadataHash: string, metadata?: CanonicalMetadataV1): void {
  if (!verifyReceiptMetadataHash(metadataHash, metadata)) {
    throw new Error('Receipt metadata does not match metadataHash');
  }
}

export function createPaymentReceipt(
  params: CreatePaymentReceiptParams,
): OpenRailsPaymentReceipt {
  assertReceiptMetadata(params.metadataHash, params.metadata);
  return {
    ...params,
    version: 'openrails-receipt-v1',
    type: 'payment_opened',
    issuedAt: params.issuedAt ?? Math.floor(Date.now() / 1000),
  };
}

export function createSettlementReceipt(
  params: CreateSettlementReceiptParams,
): OpenRailsSettlementReceipt {
  assertReceiptMetadata(params.metadataHash, params.metadata);
  return {
    ...params,
    version: 'openrails-receipt-v1',
    type: 'settlement_processed',
    issuedAt: params.issuedAt ?? Math.floor(Date.now() / 1000),
  };
}

export function createResidualRecoveryReceipt(
  params: CreateResidualRecoveryReceiptParams,
): OpenRailsResidualReceipt {
  assertReceiptMetadata(params.metadataHash, params.metadata);
  const recoveryStatus = params.recoveryStatus ??
    (BigInt(params.recoveredAmount) === 0n ? 'no_residual_remaining' : 'residual_recovered');
  return {
    ...params,
    version: 'openrails-receipt-v1',
    type: 'residual_recovered',
    issuedAt: params.issuedAt ?? Math.floor(Date.now() / 1000),
    recoveryStatus,
    note: params.note ??
      (recoveryStatus === 'no_residual_remaining'
        ? 'No STN-Delta residual remained to recover.'
        : undefined),
    finalStatus: 'Terminated',
  };
}

export function serializeReceipt(receipt: OpenRailsReceipt): string {
  return JSON.stringify(receipt, null, 2);
}

export function parseReceipt(serialized: string): OpenRailsReceipt {
  const parsed = JSON.parse(serialized) as OpenRailsReceipt;
  if (parsed.version !== 'openrails-receipt-v1') {
    throw new Error('Unsupported OpenRails receipt version');
  }
  if (
    parsed.type !== 'payment_opened' &&
    parsed.type !== 'settlement_processed' &&
    parsed.type !== 'residual_recovered'
  ) {
    throw new Error('Unsupported OpenRails receipt type');
  }
  if (!verifyReceiptMetadataHash(parsed.metadataHash, parsed.metadata)) {
    throw new Error('Receipt metadata does not match metadataHash');
  }
  return parsed;
}
