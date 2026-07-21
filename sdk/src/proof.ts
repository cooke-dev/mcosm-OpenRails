/**
 * @module proof
 * @description Lightweight, multi-stage proof shape (`ProofOfPayableV1`) — meant for inline API
 * responses where the exact lifecycle stage isn't known statically (used by the legacy
 * `server/index.ts`). Most fields are optional; unlike {@link module:receipts}' `OpenRailsReceipt`,
 * there's no per-stage typed variant.
 *
 * See {@link module:receipts}'s module doc for when to reach for a receipt instead — new
 * integrations generally should. {@link proofFromReceipt} converts a receipt into this shape when
 * you need to interop with proof-shaped code; there's no lossless conversion back (a receipt's
 * type-specific fields, e.g. `flowVelocityPerSecond` on a payment receipt, have no home here).
 */
import { ethers } from 'ethers';
import {
  buildOpenRailsDomain,
  buildSettlementIntentValue,
  hashSettlementIntent,
  inferEnvelopeModeFromIntent,
  OPENRAILS_EIP712_TYPES,
  type CryptographicEnvelopeV1,
  type OpenRailsIntentV1,
} from './client';
import type { OpenRailsEnvelopeMode } from './metadata';
import type { OpenRailsReceipt } from './receipts';

export type ProofOfPayableStage =
  | 'signed_intent'
  | 'submitted_transaction'
  | 'opened_escrow'
  | 'settlement'
  | 'residual_reclaim';

export interface ProofOfPayableV1 {
  version: 'openrails-proof-v1';
  stage: ProofOfPayableStage;
  paycardId: string;
  payer?: string;
  recipient?: string;
  intentDigest?: string;
  metadataHash?: string;
  workflowId?: string;
  mode?: OpenRailsEnvelopeMode;
  txHash?: string;
  blockNumber?: number;
  amount?: string;
  createdAt: number;
}

export function hashIntent(
  intent: OpenRailsIntentV1,
  domain: { chainId: number; verifyingContract: string },
): string {
  return hashSettlementIntent(intent, domain.chainId, domain.verifyingContract);
}

export function inferEnvelopeMode(intent: OpenRailsIntentV1): OpenRailsEnvelopeMode {
  return inferEnvelopeModeFromIntent(intent);
}

export function buildIntentProof(
  envelope: CryptographicEnvelopeV1,
  domain?: { chainId: number; verifyingContract: string },
  mode: OpenRailsEnvelopeMode =
    envelope.metadata?.mode ?? envelope.mode ?? inferEnvelopeMode(envelope.intent),
): ProofOfPayableV1 {
  const payer = domain
    ? ethers.verifyTypedData(
        buildOpenRailsDomain(domain.chainId, domain.verifyingContract),
        OPENRAILS_EIP712_TYPES,
        buildSettlementIntentValue(envelope.intent),
        envelope.envelopeSignature,
      )
    : envelope.payerAddress;

  return {
    version: 'openrails-proof-v1',
    stage: 'signed_intent',
    paycardId: envelope.intent.paycardId,
    payer,
    recipient: envelope.intent.recipient,
    metadataHash: envelope.intent.metadataHash,
    workflowId: envelope.metadata?.workflowId,
    intentDigest: domain
      ? hashSettlementIntent(envelope.intent, domain.chainId, domain.verifyingContract)
      : undefined,
    mode,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

const RECEIPT_TYPE_TO_STAGE: Record<OpenRailsReceipt['type'], Exclude<ProofOfPayableStage, 'signed_intent'>> = {
  payment_opened: 'opened_escrow',
  settlement_processed: 'settlement',
  residual_recovered: 'residual_reclaim',
};

function receiptAmount(receipt: OpenRailsReceipt): string | undefined {
  switch (receipt.type) {
    case 'payment_opened':
      return receipt.totalAllocationPool;
    case 'settlement_processed':
      return receipt.settledAmount;
    case 'residual_recovered':
      return receipt.recoveredAmount;
  }
}

/**
 * Converts a durable {@link OpenRailsReceipt} into the lighter {@link ProofOfPayableV1} shape —
 * one direction only; see this module's doc comment for why the reverse isn't lossless.
 */
export function proofFromReceipt(receipt: OpenRailsReceipt): ProofOfPayableV1 {
  return {
    version: 'openrails-proof-v1',
    stage: RECEIPT_TYPE_TO_STAGE[receipt.type],
    paycardId: receipt.paycardId,
    payer: receipt.payer,
    recipient: receipt.recipient,
    metadataHash: receipt.metadataHash,
    mode: receipt.metadata?.mode,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber,
    amount: receiptAmount(receipt),
    createdAt: receipt.issuedAt,
  };
}

export function buildTransactionProof(params: {
  stage: Exclude<ProofOfPayableStage, 'signed_intent'>;
  paycardId: string;
  txHash: string;
  blockNumber?: number;
  payer?: string;
  recipient?: string;
  amount?: string;
  metadataHash?: string;
  workflowId?: string;
  mode?: OpenRailsEnvelopeMode;
  intentDigest?: string;
}): ProofOfPayableV1 {
  return {
    version: 'openrails-proof-v1',
    createdAt: Math.floor(Date.now() / 1000),
    ...params,
  };
}
