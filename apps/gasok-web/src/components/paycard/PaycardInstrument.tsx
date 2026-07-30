import { motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import type { Address, Hash, Hex } from 'viem';

import {
  PaycardInspector,
  type InspectorRow,
} from './PaycardInspector';
import { PaycardProgressRail } from './PaycardProgressRail';
import { PaycardReceipt } from './PaycardReceipt';

export type PaycardVerificationDecision = {
  pactId: string;
  decision: string;
  decisionHash?: Hex;
  reasonCodes?: string[];
  evaluatedAt?: string;
};

export type PaycardPact = {
  pactId: string;
  proposalId?: string;
  decisionId?: string;
  decisionHash?: Hex;
  workspaceId: string;
  pathId: string;
  pathRevision?: number;
  termsHash: Hex;
  counterparty: Address;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  paymentTerms: {
    chainId?: number;
    vault?: Address;
    token?: Address;
    payer?: Address;
    recipient?: Address;
    residualRecipient?: Address;
    maximumAllocationBaseUnits: string;
    velocityBaseUnitsPerSecond: string;
    lifespanSeconds: number;
  };
  openRails?: {
    metadataHash: Hex;
    paycardId: Hex;
    genesisTimestamp?: number;
    nonceChannel?: number;
    nonceValue?: number;
    preparedAt?: string;
    openingTxHash?: Hash;
    openingObservation?: {
      transactionHash: Hash;
      blockNumber: number;
      observedAt?: string;
      payer?: Address;
      recipient?: Address;
      availableBalanceBaseUnits?: string;
      operationalStatus?: number;
    };
    settlements?: Array<{
      transactionHash: Hash;
      blockNumber: number;
      settledAmountBaseUnits: string;
      final: boolean;
      observedAt?: string;
    }>;
  };
};

type PaycardInstrumentProps = {
  pact: PaycardPact;
  remaining: number;
  verificationDecision?: PaycardVerificationDecision;
  explorerUrl: string;
};

const SCALE = 1_000_000n;

function minimum(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function formatBaseUnits(value: bigint, precision = 2) {
  const whole = value / SCALE;
  const fractional = (value % SCALE)
    .toString()
    .padStart(6, '0')
    .slice(0, precision);

  return `${whole.toLocaleString()}${precision ? `.${fractional}` : ''}`;
}

function short(value?: string) {
  return value
    ? `${value.slice(0, 10)}…${value.slice(-8)}`
    : '—';
}

function instrumentState(
  pact: PaycardPact,
  remaining: number,
  proofApproved: boolean,
) {
  if (
    ['disputed', 'rectification_required', 'held'].includes(
      pact.status,
    )
  ) {
    return {
      label: 'HELD',
      key: 'held',
      note: 'GAIA EXCEPTION ACTIVE',
    };
  }

  if (pact.status === 'settled') {
    return {
      label: 'SETTLED',
      key: 'settled',
      note: 'RECORDED ON GIWA',
    };
  }

  if (
    ['performing', 'completed'].includes(pact.status) ||
    proofApproved
  ) {
    if (remaining > 0) {
      return {
        label: 'EARNING',
        key: 'earning',
        note: `${remaining}s TO FINAL HORIZON`,
      };
    }

    return {
      label: 'SETTLEMENT ELIGIBLE',
      key: 'eligible',
      note: 'WALLET CONFIRMATION REQUIRED',
    };
  }

  if (pact.openRails?.openingTxHash || pact.status === 'active') {
    return {
      label: remaining > 0 ? 'EARNING' : 'OPEN',
      key: remaining > 0 ? 'earning' : 'open',
      note:
        remaining > 0
          ? `${remaining}s TO FINAL HORIZON`
          : 'CANONICAL OPENING VERIFIED',
    };
  }

  if (
    pact.openRails?.paycardId ||
    ['payment_prepared', 'awaiting_wallet'].includes(pact.status)
  ) {
    return {
      label: 'OPENING',
      key: 'opening',
      note: 'GIWA CONFIRMATION PENDING',
    };
  }

  return {
    label: 'PREPARED',
    key: 'prepared',
    note: 'PACT ACCEPTED',
  };
}

export function PaycardInstrument({
  pact,
  remaining,
  verificationDecision,
  explorerUrl,
}: PaycardInstrumentProps) {
  const [inspecting, setInspecting] = useState(false);

  const allocation = BigInt(
    pact.paymentTerms.maximumAllocationBaseUnits,
  );
  const velocity = BigInt(
    pact.paymentTerms.velocityBaseUnitsPerSecond,
  );
  const lifespan = pact.paymentTerms.lifespanSeconds;
  const proofApproved =
    verificationDecision?.decision === 'approved' ||
    ['performing', 'completed', 'settled'].includes(pact.status);

  const state = instrumentState(
    pact,
    remaining,
    proofApproved,
  );

  const settlements = pact.openRails?.settlements ?? [];
  const settlement = settlements.at(-1);
  const settledAmount = settlements.reduce(
    (total, observation) =>
      total + BigInt(observation.settledAmountBaseUnits),
    0n,
  );

  const elapsed =
    pact.openRails?.genesisTimestamp
      ? Math.max(0, lifespan - remaining)
      : 0;

  const projectedAccrued =
    pact.status === 'settled'
      ? allocation
      : minimum(
          allocation,
          velocity * BigInt(elapsed),
        );

  const accrued =
    settledAmount > projectedAccrued
      ? settledAmount
      : projectedAccrued;

  const available =
    allocation > accrued ? allocation - accrued : 0n;

  const progress =
    allocation === 0n
      ? 0
      : Number((accrued * 10_000n) / allocation) / 100;

  const payer =
    pact.paymentTerms.payer ?? pact.counterparty;
  const recipient =
    pact.paymentTerms.recipient ?? pact.counterparty;

  const openingHash =
    pact.openRails?.openingObservation?.transactionHash ??
    pact.openRails?.openingTxHash;

  const openingBlock =
    pact.openRails?.openingObservation?.blockNumber;

  const primaryValue =
    pact.status === 'settled' ? allocation : available;

  const inspectorRows = useMemo<InspectorRow[]>(
    () => [
      {
        label: 'PAYCARD ID',
        value: pact.openRails?.paycardId ?? 'NOT ISSUED',
      },
      {
        label: 'PACT ID',
        value: pact.pactId,
      },
      {
        label: 'PROPOSAL ID',
        value: pact.proposalId ?? '—',
      },
      {
        label: 'PATH',
        value: `${pact.pathId} / REVISION ${
          pact.pathRevision ?? '—'
        }`,
      },
      {
        label: 'PACT TERMS HASH',
        value: pact.termsHash,
      },
      {
        label: 'BAPHOMET DECISION',
        value: pact.decisionHash ?? pact.decisionId ?? '—',
      },
      {
        label: 'METADATA HASH',
        value: pact.openRails?.metadataHash ?? '—',
      },
      {
        label: 'PAYER',
        value: payer,
      },
      {
        label: 'RECIPIENT',
        value: recipient,
      },
      {
        label: 'RESIDUAL RECIPIENT',
        value:
          pact.paymentTerms.residualRecipient ?? payer,
      },
      {
        label: 'ALLOCATION',
        value: `${formatBaseUnits(allocation)} orUSD`,
      },
      {
        label: 'VELOCITY',
        value: `${formatBaseUnits(velocity)} orUSD / SECOND`,
      },
      {
        label: 'LIFESPAN',
        value: `${lifespan} SECONDS`,
      },
      {
        label: 'NONCE LANE',
        value: `${pact.openRails?.nonceChannel ?? '—'} / ${
          pact.openRails?.nonceValue ?? '—'
        }`,
      },
      {
        label: 'VAULT',
        value: pact.paymentTerms.vault ?? '—',
        href: pact.paymentTerms.vault
          ? `${explorerUrl}/address/${pact.paymentTerms.vault}`
          : undefined,
      },
      {
        label: 'OPENING TRANSACTION',
        value: openingHash ?? '—',
        href: openingHash
          ? `${explorerUrl}/tx/${openingHash}`
          : undefined,
      },
      {
        label: 'OPENING BLOCK',
        value: openingBlock?.toString() ?? '—',
      },
      {
        label: 'PROOF',
        value: verificationDecision
          ? `${verificationDecision.decision.toUpperCase()} ${
              verificationDecision.decisionHash ?? ''
            }`.trim()
          : proofApproved
            ? 'APPROVED'
            : 'PENDING',
      },
      {
        label: 'SETTLEMENT TRANSACTION',
        value: settlement?.transactionHash ?? '—',
        href: settlement
          ? `${explorerUrl}/tx/${settlement.transactionHash}`
          : undefined,
      },
      {
        label: 'SETTLEMENT BLOCK',
        value: settlement?.blockNumber.toString() ?? '—',
      },
    ],
    [
      allocation,
      explorerUrl,
      lifespan,
      openingBlock,
      openingHash,
      pact,
      payer,
      proofApproved,
      recipient,
      settlement,
      velocity,
      verificationDecision,
    ],
  );

  return (
    <section
      className="paycard-stage"
      aria-labelledby="paycard-instrument-title"
    >
      <header className="paycard-stage-header">
        <div>
          <span>CANONICAL PAYCARD INSTRUMENT</span>
          <h4 id="paycard-instrument-title">
            Programmable settlement, made visible.
          </h4>
        </div>

        <button
          type="button"
          onClick={() => setInspecting(true)}
        >
          INSPECT INSTRUMENT
        </button>
      </header>

      <motion.article
        className={`paycard-instrument is-${state.key}`}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        {['opening', 'earning'].includes(state.key) && (
          <i className="paycard-live-signal" />
        )}

        <div className="paycard-topline">
          <div>
            <span className="paycard-mark">OR</span>
            <strong>OPENRAILS PAYCARD</strong>
          </div>

          <div className="paycard-state">
            <span>{state.label}</span>
            <small>{state.note}</small>
          </div>
        </div>

        <div className="paycard-balance">
          <strong>{formatBaseUnits(primaryValue)}</strong>
          <span>orUSD</span>
          <small>
            {pact.status === 'settled'
              ? 'SETTLED VALUE'
              : 'AVAILABLE'}
          </small>
        </div>

        <PaycardProgressRail
          progress={progress}
          state={state.label}
        />

        <div className="paycard-value-row">
          <div>
            <span>ACCRUED</span>
            <strong>{formatBaseUnits(accrued)} orUSD</strong>
          </div>
          <div>
            <span>RESIDUAL</span>
            <strong>{formatBaseUnits(available)} orUSD</strong>
          </div>
        </div>

        <div className="paycard-metrics">
          <div>
            <span>FLOW VELOCITY</span>
            <strong>
              {formatBaseUnits(velocity)} orUSD / SEC
            </strong>
          </div>
          <div>
            <span>LIFESPAN</span>
            <strong>{lifespan} SEC</strong>
          </div>
          <div>
            <span>NONCE LANE</span>
            <strong>
              {pact.openRails?.nonceChannel ?? '—'} /{' '}
              {pact.openRails?.nonceValue ?? '—'}
            </strong>
          </div>
        </div>

        <div className="paycard-parties">
          <div>
            <span>PAYER</span>
            <strong>{short(payer)}</strong>
          </div>
          <i>→</i>
          <div>
            <span>RECIPIENT</span>
            <strong>{short(recipient)}</strong>
          </div>
        </div>

        <footer>
          <span>GIWA / SEPOLIA</span>
          <code>
            {short(pact.openRails?.paycardId)}
          </code>
          <strong>
            {openingBlock
              ? `OPENED AT BLOCK ${openingBlock.toLocaleString()}`
              : state.note}
          </strong>
        </footer>
      </motion.article>

      <div className="paycard-receipts">
        <PaycardReceipt
          label="OPENING RECEIPT"
          status={openingHash ? 'CONFIRMED' : 'PENDING'}
          hash={openingHash}
          blockNumber={openingBlock}
          href={
            openingHash
              ? `${explorerUrl}/tx/${openingHash}`
              : undefined
          }
        />

        <PaycardReceipt
          label="ACTIVATION PROOF"
          status={proofApproved ? 'APPROVED' : 'PENDING'}
          hash={verificationDecision?.decisionHash}
        />

        <PaycardReceipt
          label="SETTLEMENT RECEIPT"
          status={settlement ? 'CONFIRMED' : 'PENDING'}
          hash={settlement?.transactionHash}
          blockNumber={settlement?.blockNumber}
          href={
            settlement
              ? `${explorerUrl}/tx/${settlement.transactionHash}`
              : undefined
          }
        />
      </div>

      <PaycardInspector
        open={inspecting}
        title={`PAYCARD ${short(pact.openRails?.paycardId)}`}
        rows={inspectorRows}
        onClose={() => setInspecting(false)}
      />
    </section>
  );
}
