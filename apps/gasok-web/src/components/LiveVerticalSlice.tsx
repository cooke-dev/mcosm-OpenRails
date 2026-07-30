import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { GIWA } from '../data/giwa';
import {
  api,
  BLOCKED_ALLOCATION,
  claimOrUsd,
  ensureApproval,
  formatNative,
  formatOrUsd,
  LIVE_ALLOCATION,
  LIVE_LIFESPAN_SECONDS,
  LIVE_VELOCITY,
  PLUGIN_ID,
  PLUGIN_VERSION,
  readLiveAccount,
  settledAmount,
  vaultAbi,
  type LiveAccount,
} from '../lib/openrails';
import { useWallet, type TypedDataEnvelope } from '../lib/wallet';
import {
  PaycardInstrument,
  type PaycardPact,
  type PaycardVerificationDecision,
} from './paycard/PaycardInstrument';
import './paycard/paycard.css';

type Phase = 'idle' | 'funded' | 'authority' | 'allowed' | 'pact' | 'opened' | 'proved' | 'settled';
type Activity = { at: string; label: string; source: 'WALLET' | 'KERNEL' | 'BAPHOMET' | 'GIWA' | 'PROOF'; status: 'pending' | 'complete' | 'error' };
type RunMemory = {
  workspaceId: string;
  agentId: string;
  pathId: string;
  proposalId?: string;
  pactId?: string;
  paycardId?: Hex;
  openingTxHash?: Hash;
  settlementTxHash?: Hash;
  genesisTimestamp?: number;
  phase: Phase;
};

type KernelState = {
  workspace?: Record<string, unknown>;
  agents: Array<{ agentId: string }>;
  paths: Array<{ artifact: { pathId: string } }>;
  plugins: Array<{ pluginId: string; pluginVersion: string }>;
  decisions: Array<{
    proposalId: string;
    decisionId: string;
    decisionHash: Hex;
    result: string;
    reasonCodes: string[];
    evaluatedAt: string;
  }>;
  pacts: Pact[];
  verificationDecisions: PaycardVerificationDecision[];
  events: Array<Record<string, unknown>>;
};

type Pact = PaycardPact;

type PaymentDraft = {
  pactId: string;
  metadataHash: Hex;
  paycardId: Hex;
  typedData: TypedDataEnvelope;
  intent: {
    paycardId: Hex;
    metadataHash: Hex;
    recipient: Address;
    totalAllocationPool: string;
    flowVelocityPerSecond: string;
    genesisTimestamp: number;
    lifespanSeconds: number;
    residualDeltaRecipient: Address;
    nonceChannel: number;
    nonceValue: number;
  };
  approval: { token: Address; spender: Address; amountBaseUnits: string };
  validUntil: string;
};

const phaseOrder: Phase[] = ['idle', 'funded', 'authority', 'allowed', 'pact', 'opened', 'proved', 'settled'];
const steps = [
  ['01', 'CONNECT + FUND'], ['02', 'BIND AUTHORITY'], ['03', 'EVALUATE'], ['04', 'SEAL PACT'],
  ['05', 'OPEN PAYCARD'], ['06', 'VERIFY PROOF'], ['07', 'SETTLE'],
] as const;

function nowLabel() { return new Date().toLocaleTimeString([], { hour12: false }); }
function short(value?: string) { return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—'; }
function deterministicIds(address: Address) {
  const stem = address.slice(2, 10).toLowerCase();
  return { workspaceId: `gasok-${stem}`, agentId: `agent-${stem}`, pathId: `path-${stem}` };
}

function phaseFromPact(
  pact: Pact,
  proof?: PaycardVerificationDecision,
): Phase {
  if (pact.status === 'settled') return 'settled';

  if (
    proof?.decision === 'approved' ||
    ['performing', 'completed'].includes(pact.status)
  ) {
    return 'proved';
  }

  if (
    pact.openRails?.openingTxHash ||
    ['active'].includes(pact.status)
  ) {
    return 'opened';
  }

  return 'pact';
}

export function LiveVerticalSlice() {
  const { address, chainId, connecting, authenticating, sessionAddress, connect, ensureSession, publicClient, signTypedData, walletClient } = useWallet();
  const [account, setAccount] = useState<LiveAccount>();
  const [memory, setMemory] = useState<RunMemory>();
  const [pact, setPact] = useState<Pact>();
  const [decision, setDecision] = useState<Record<string, unknown>>();
  const [blockedDecision, setBlockedDecision] = useState<Record<string, unknown>>();
  const [proofDecision, setProofDecision] =
    useState<PaycardVerificationDecision>();
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(0);

  const add = useCallback((label: string, source: Activity['source'], status: Activity['status'] = 'complete') => {
    setActivity((current) => [{ at: nowLabel(), label, source, status }, ...current].slice(0, 14));
  }, []);

  const setFailure = useCallback((value: unknown) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    add(message, 'KERNEL', 'error');
  }, [add]);

  const refreshAccount = useCallback(async () => {
    if (!address) { setAccount(undefined); return; }
    try { setAccount(await readLiveAccount(publicClient, address)); }
    catch (value) { console.error(value); }
  }, [address, publicClient]);

  useEffect(() => { void refreshAccount(); }, [refreshAccount]);
  useEffect(() => {
    if (!address) { setMemory(undefined); setPact(undefined); return; }
    const ids = deterministicIds(address);
    const saved = localStorage.getItem(`openrails-live-${address.toLowerCase()}`);
    const restored = saved ? JSON.parse(saved) as Partial<RunMemory> : {};
    const next: RunMemory = { ...ids, ...restored, phase: restored.phase ?? 'idle' };
    setMemory(next);
  }, [address]);
  useEffect(() => {
    if (!address || !memory) return;
    localStorage.setItem(`openrails-live-${address.toLowerCase()}`, JSON.stringify(memory));
  }, [address, memory]);

  useEffect(() => {
    if (
      !sessionAddress ||
      !memory?.workspaceId ||
      !memory.pactId
    ) {
      return;
    }

    let cancelled = false;

    const restoreCanonicalRun = async () => {
      const state = await api<KernelState>(
        `/api/live/state/${memory.workspaceId}`
      );

      const restoredPact = state.pacts.find(
        (item) => item.pactId === memory.pactId
      );

      if (!restoredPact || cancelled) return;

      const restoredDecision = state.decisions.find(
        (item) =>
          item.decisionId === restoredPact.decisionId ||
          item.proposalId === restoredPact.proposalId
      );

      const restoredBlockedDecision = [...state.decisions]
        .filter((item) => item.result === 'BLOCK')
        .sort(
          (left, right) =>
            Date.parse(left.evaluatedAt) -
            Date.parse(right.evaluatedAt)
        )
        .at(-1);

      const restoredProof =
        state.verificationDecisions.find(
          (item) => item.pactId === restoredPact.pactId
        );

      const latestSettlement =
        restoredPact.openRails?.settlements?.at(-1);

      setPact(restoredPact);
      setDecision(restoredDecision);
      setBlockedDecision(restoredBlockedDecision);
      setProofDecision(restoredProof);

      setMemory((current) =>
        current
          ? {
              ...current,
              proposalId:
                restoredPact.proposalId ??
                current.proposalId,
              pactId: restoredPact.pactId,
              paycardId:
                restoredPact.openRails?.paycardId ??
                current.paycardId,
              openingTxHash:
                restoredPact.openRails?.openingTxHash ??
                current.openingTxHash,
              settlementTxHash:
                latestSettlement?.transactionHash ??
                current.settlementTxHash,
              genesisTimestamp:
                restoredPact.openRails?.genesisTimestamp ??
                current.genesisTimestamp,
              phase: phaseFromPact(
                restoredPact,
                restoredProof,
              ),
            }
          : current
      );
    };

    void restoreCanonicalRun().catch((value) => {
      if (!cancelled) {
        console.error(
          'Could not restore canonical Paycard state',
          value,
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    memory?.pactId,
    memory?.workspaceId,
    sessionAddress,
  ]);

  useEffect(() => {
    const update = () => {
      const end = memory?.genesisTimestamp ? memory.genesisTimestamp + LIVE_LIFESPAN_SECONDS : 0;
      setRemaining(Math.max(0, end - Math.floor(Date.now() / 1000)));
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [memory?.genesisTimestamp]);

  const currentPhase = memory?.phase ?? 'idle';
  const phaseIndex = phaseOrder.indexOf(currentPhase);
  const canOperate = Boolean(address && chainId === GIWA.chainId && memory);

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError('');
    try { await action(); }
    catch (value) { setFailure(value); }
    finally { setBusy(''); }
  }

  async function waitForCanonicalReceipt(hash: Hash) {
    const deadline = Date.now() + 120_000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const receipt =
          await publicClient.getTransactionReceipt({ hash });

        if (receipt.status !== 'success') {
          throw new Error(
            `Transaction ${hash} reverted on GIWA`
          );
        }

        return receipt;
      } catch (value) {
        lastError = value;
        await new Promise((resolve) =>
          window.setTimeout(resolve, 1_500)
        );
      }
    }

    const reason =
      lastError instanceof Error
        ? lastError.message
        : String(lastError);

    throw new Error(
      `GIWA receipt was not consistently available after 120 seconds: ${reason}`
    );
  }

  const claim = () => run('claim', async () => {
    const accountAddress = address ?? await connect();
    const client = await walletClient();
    add('Faucet claim submitted', 'WALLET', 'pending');
    const hash = await claimOrUsd(client, publicClient, accountAddress);
    add(`1,000 orUSD received · ${short(hash)}`, 'GIWA');
    setMemory((current) => current ? { ...current, phase: phaseOrder.indexOf(current.phase) < 1 ? 'funded' : current.phase } : current);
    await refreshAccount();
  });

  const bootstrap = () => run('bootstrap', async () => {
    if (!address || !memory) throw new Error('Connect a wallet first.');
    await ensureSession();
    add('Wallet-authenticated live API session opened', 'WALLET');
    const existing = await api<KernelState>(`/api/live/state/${memory.workspaceId}`);

    if (!existing.workspace) {
      add('Workspace authority requested', 'KERNEL', 'pending');
      const prepared = await api<{ workspace: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/workspaces/prepare', {
        method: 'POST', body: JSON.stringify({ workspaceId: memory.workspaceId, workspaceType: 'individual', displayName: 'GIWA Live Demonstration Workspace', principalId: `principal:${address.toLowerCase()}`, authorityAccount: address, authorityType: 'eoa' }),
      });
      const signature = await signTypedData(prepared.typedData);
      await api('/api/live/workspaces/register', { method: 'POST', body: JSON.stringify({ workspace: prepared.workspace, signature }) });
      add(`Workspace ${memory.workspaceId} registered`, 'KERNEL');
    } else add('Existing Workspace authority loaded', 'KERNEL');

    if (!existing.agents.some((item) => item.agentId === memory.agentId)) {
      const prepared = await api<{ agent: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/agents/prepare', {
        method: 'POST', body: JSON.stringify({ agentId: memory.agentId, workspaceId: memory.workspaceId, displayName: 'Execution Agent 03', description: 'Wallet-confirmed GASOK execution agent', operator: address, identityKey: `eoa:${address.toLowerCase()}`, runtimeCredentialHash: keccak256(stringToHex(`gasok:${address.toLowerCase()}`)), capabilities: ['propose', 'prepare', 'checkpoint'], permittedActionTypes: ['open_payment', 'submit_checkpoint'] }),
      });
      const signature = await signTypedData(prepared.typedData);
      await api('/api/live/agents/register', { method: 'POST', body: JSON.stringify({ agent: prepared.agent, authoritySigner: address, signature }) });
      add(`Agent ${memory.agentId} registered`, 'KERNEL');
    } else add('Existing registered Agent loaded', 'KERNEL');

    if (!existing.plugins.some((item) => item.pluginId === PLUGIN_ID && item.pluginVersion === PLUGIN_VERSION)) {
      const plugin = await api<{ manifest: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/plugins/prepare', { method: 'POST', body: JSON.stringify({ workspaceId: memory.workspaceId, publisher: address }) });
      const publisherSignature = await signTypedData(plugin.typedData);
      const command = await api<{ command: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/plugins/prepare-command', { method: 'POST', body: JSON.stringify({ workspaceId: memory.workspaceId }) });
      const commandSignature = await signTypedData(command.typedData);
      await api('/api/live/plugins/install', { method: 'POST', body: JSON.stringify({ manifest: { ...plugin.manifest, publisherSignature }, command: command.command, signature: commandSignature }) });
      add('GIWA receipt verifier installed', 'PROOF');
    } else add('GIWA receipt verifier already installed', 'PROOF');

    if (!existing.paths.some((item) => item.artifact.pathId === memory.pathId)) {
      const at = new Date();
      const path = {
        version: 'openrails-path-v1', pathId: memory.pathId, workspaceId: memory.workspaceId, owner: address, authorityAccount: address,
        authorizedAgentIds: [memory.agentId], permittedActions: ['open_payment', 'submit_checkpoint'], permittedAssets: [GIWA.contracts.orUSD], permittedCounterparties: [address],
        identityRequirements: [{ provider: 'none', requirement: 'self-settlement test route', required: false }], approvedVerificationPlugins: [{ pluginId: PLUGIN_ID, version: PLUGIN_VERSION }],
        limits: { maxPerPactBaseUnits: parseUnits('1000', 6).toString(), maxActiveExposureBaseUnits: parseUnits('1000', 6).toString(), maxPerPeriodBaseUnits: parseUnits('2500', 6).toString(), periodSeconds: 86400, maxVelocityBaseUnitsPerSecond: parseUnits('50', 6).toString(), maxDurationSeconds: 90, maxConcurrentPacts: 1 },
        authorityMode: 'confirmed_execution', validFrom: new Date(at.getTime() - 60_000).toISOString(), expiresAt: new Date(at.getTime() + 86_400_000).toISOString(), status: 'active', revision: 1, createdAt: at.toISOString(), updatedAt: at.toISOString(),
      };
      const prepared = await api<{ path: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/paths/prepare', { method: 'POST', body: JSON.stringify(path) });
      const signature = await signTypedData(prepared.typedData);
      await api('/api/live/paths/activate', { method: 'POST', body: JSON.stringify({ path: prepared.path, signature }) });
      add(`Path ${memory.pathId} signed and activated`, 'KERNEL');
    } else add('Existing signed Path loaded', 'KERNEL');

    setMemory((current) => current ? { ...current, phase: 'authority' } : current);
  });

  const evaluate = (blocked = false) => run(blocked ? 'blocked' : 'evaluate', async () => {
    if (!address || !memory) throw new Error('Initialize the live Workspace first.');
    await ensureSession();
    const stamp = Date.now();
    const proposalId = `proposal-${blocked ? 'block' : 'allow'}-${stamp}`;
    const proposal = {
      version: 'openrails-agent-proposal-v1', proposalId, workspaceId: memory.workspaceId, pathId: memory.pathId, agentId: memory.agentId,
      actionType: 'open_payment', counterparty: address, asset: GIWA.contracts.orUSD,
      requestedAllocationBaseUnits: (blocked ? BLOCKED_ALLOCATION : LIVE_ALLOCATION).toString(), requestedVelocityBaseUnitsPerSecond: LIVE_VELOCITY.toString(), requestedDurationSeconds: LIVE_LIFESPAN_SECONDS,
      specification: { route: 'gasok-live-self-settlement', checkpoint: 'giwa_transaction_receipt' }, evidencePolicyId: PLUGIN_ID,
      requestedAt: new Date().toISOString(), idempotencyKey: `${proposalId}:v1`,
    };
    add(`${blocked ? 'Over-limit' : '420 orUSD'} proposal submitted`, 'KERNEL', 'pending');
    const result = await api<{ decision: Record<string, unknown>; job: { state: string }; blockedAction?: Record<string, unknown>; pactFormed: boolean; financialEffect: string }>('/api/live/proposals/evaluate', { method: 'POST', body: JSON.stringify(proposal) });
    if (!result.decision) throw new Error('Baphomet did not return a decision.');
    const verdict = String(result.decision.result);
    add(`Baphomet recorded ${verdict}`, 'BAPHOMET', verdict === 'BLOCK' && !blocked ? 'error' : 'complete');
    if (blocked) {
      if (result.pactFormed || result.financialEffect !== 'none') throw new Error('Blocked control invariant failed: a Pact or financial effect was recorded.');
      setBlockedDecision(result.decision);
      add('No Pact formed and no wallet transaction was requested', 'BAPHOMET');
      return;
    }
    if (verdict !== 'ALLOW') throw new Error(`Proposal was not allowed: ${String(result.decision.reasonCodes)}`);
    setDecision(result.decision);
    setMemory((current) => current ? { ...current, proposalId, phase: 'allowed' } : current);
  });

  const createPact = () => run('pact', async () => {
    if (!address || !memory?.proposalId) throw new Error('Run an allowed proposal first.');
    await ensureSession();
    const pactId = `pact-${Date.now()}`;
    const created = await api<{ pact: Pact; typedData: TypedDataEnvelope }>('/api/live/pacts/create', {
      method: 'POST', body: JSON.stringify({ proposalId: memory.proposalId, pactId, commercialTerms: { title: 'Accelerated GIWA settlement demonstration', amount: '420 orUSD', durationSeconds: LIVE_LIFESPAN_SECONDS, recipientMode: 'self-settlement test route', proofRule: 'canonical Paycard activation milestone' }, completionPolicyId: 'receipt-gated-settlement-v1', disputePolicyId: 'gaia-v1', requiresCounterpartySignature: false }),
    });
    add('Pact terms prepared', 'KERNEL', 'pending');
    const signature = await signTypedData(created.typedData);
    await api('/api/live/pacts/sign', { method: 'POST', body: JSON.stringify({ pactId, signer: address, signature }) });
    const accepted = await api<Pact>(`/api/live/pacts/${pactId}`);
    setPact(accepted);
    setMemory((current) => current ? { ...current, pactId, phase: 'pact' } : current);
    add(`Pact ${pactId} accepted`, 'WALLET');
  });

  const openPayment = () => run('open', async () => {
    if (!address || !memory?.pactId) throw new Error('Create and sign a Pact first.');
    await ensureSession();
    const currentPact = await api<Pact>(
      `/api/live/pacts/${memory.pactId}`
    );
    if (!currentPact) throw new Error('The Pact could not be loaded.');
    if (!['accepted', 'payment_prepared', 'awaiting_wallet'].includes(currentPact.status)) throw new Error(`Pact is not ready for payment opening (${currentPact.status}).`);
    setPact(currentPact);

    if (
      ['payment_prepared', 'awaiting_wallet'].includes(
        currentPact.status
      ) &&
      currentPact.openRails?.paycardId
    ) {
      add(
        'Checking GIWA for a previously submitted Paycard opening',
        'GIWA',
        'pending',
      );

      try {
        const recovered = await api<{
          pact: Pact;
          openingTxHash: Hash;
          paycardId: Hex;
          genesisTimestamp: number;
        }>('/api/live/payments/recover-opening', {
          method: 'POST',
          body: JSON.stringify({
            pactId: memory.pactId,
          }),
        });

        setPact(recovered.pact);

        setMemory((current) =>
          current
            ? {
                ...current,
                paycardId: recovered.paycardId,
                openingTxHash:
                  recovered.openingTxHash,
                genesisTimestamp:
                  recovered.genesisTimestamp,
                phase: 'opened',
              }
            : current
        );

        add(
          `Canonical opening recovered · ${short(
            recovered.openingTxHash
          )}`,
          'GIWA',
        );

        await refreshAccount();
        return;
      } catch (value) {
        const message =
          value instanceof Error
            ? value.message
            : String(value);

        if (
          !message.includes(
            'No canonical Paycard opening was found'
          )
        ) {
          throw value;
        }

        add(
          'No prior canonical opening found; preparing a new wallet action',
          'KERNEL',
          'pending',
        );
      }
    }

    if (
      !account ||
      account.orUsdBalance < LIVE_ALLOCATION
    ) {
      throw new Error(
        'Claim test orUSD before opening the Paycard.'
      );
    }
    const client = await walletClient();
    add('Checking orUSD allowance', 'WALLET', 'pending');
    const approval = await ensureApproval(client, publicClient, address, LIVE_ALLOCATION);
    if (approval) add(`Vault approval confirmed · ${short(approval)}`, 'GIWA');

    const draft = await api<PaymentDraft>('/api/live/payments/draft', { method: 'POST', body: JSON.stringify({ pactId: memory.pactId }) });
    add(`Server-issued RailsFlow draft valid until ${new Date(draft.validUntil).toLocaleTimeString([], { hour12: false })}`, 'KERNEL');
    const envelopeSignature = await signTypedData(draft.typedData);
    await api('/api/live/payments/prepare', { method: 'POST', body: JSON.stringify({ pactId: memory.pactId, metadataHash: draft.metadataHash, paycardId: draft.paycardId, actor: address, genesisTimestamp: draft.intent.genesisTimestamp, nonceChannel: draft.intent.nonceChannel, nonceValue: draft.intent.nonceValue }) });
    add('RailsFlow prepared; wallet confirmation required', 'KERNEL');
    const hash = await client.writeContract({ account: address, address: GIWA.contracts.vault, abi: vaultAbi, functionName: 'openPaycardChannel', args: [draft.paycardId, draft.metadataHash, draft.intent.recipient, BigInt(draft.intent.totalAllocationPool), BigInt(draft.intent.flowVelocityPerSecond), BigInt(draft.intent.genesisTimestamp), BigInt(draft.intent.lifespanSeconds), draft.intent.residualDeltaRecipient, envelopeSignature, BigInt(draft.intent.nonceChannel), BigInt(draft.intent.nonceValue), address] });
    add(`Paycard opening submitted · ${short(hash)}`, 'WALLET', 'pending');
    await waitForCanonicalReceipt(hash);
    const activePact = await api<Pact>('/api/live/payments/confirm-opening', { method: 'POST', body: JSON.stringify({ pactId: memory.pactId, metadataHash: draft.metadataHash, paycardId: draft.paycardId, actor: address, openingTxHash: hash }) });
    setPact(activePact);
    setMemory((current) => current ? { ...current, paycardId: draft.paycardId, openingTxHash: hash, genesisTimestamp: draft.intent.genesisTimestamp, phase: 'opened' } : current);
    add(`Canonical opening verified · ${short(hash)}`, 'GIWA');
    await refreshAccount();
  });

  const prove = () => run('proof', async () => {
    if (!address || !memory?.pactId || !memory.openingTxHash || !memory.paycardId) throw new Error('Open the Paycard before submitting Proof.');
    await ensureSession();
    const currentPact = pact ?? await api<Pact>(`/api/live/pacts/${memory.pactId}`);
    if (!currentPact) throw new Error('The Pact could not be loaded.');
    if (!['active', 'performing'].includes(currentPact.status)) throw new Error(`Pact is not accepting Proof checkpoints (${currentPact.status}).`);
    setPact(currentPact);
    const checkpointId = `checkpoint-${Date.now()}`;
    const prepared = await api<{ checkpoint: Record<string, unknown>; typedData: TypedDataEnvelope }>('/api/live/checkpoints/prepare', {
      method: 'POST', body: JSON.stringify({ version: 'openrails-work-checkpoint-v1', checkpointId, workspaceId: memory.workspaceId, pactId: memory.pactId, pathId: memory.pathId, paycardId: memory.paycardId, termsHash: currentPact.termsHash, actor: address, counterparty: address, checkpointIndex: 1, checkpointType: 'milestone', evidenceType: 'giwa_transaction_receipt', evidenceHash: memory.openingTxHash, evidenceUri: `${GIWA.explorerUrl}/tx/${memory.openingTxHash}`, observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 10 * 60_000).toISOString(), submittedBy: address }),
    });
    const signature = await signTypedData(prepared.typedData);
    add('Signed Proof checkpoint submitted', 'PROOF', 'pending');
    const result = await api<{ decision: { decision: string; decisionHash: Hex; reasonCodes: string[] }; pact: Pact }>('/api/live/checkpoints/submit-and-verify', { method: 'POST', body: JSON.stringify({ checkpoint: { ...prepared.checkpoint, signature } }) });
    if (result.decision.decision !== 'approved') throw new Error(`Proof was not approved: ${result.decision.reasonCodes.join(', ')}`);
    setPact(result.pact);
    setProofDecision({
      pactId: result.pact.pactId,
      ...result.decision,
    });
    setMemory((current) => current ? { ...current, phase: 'proved' } : current);
    add(`GIWA activation Proof approved · ${short(result.decision.decisionHash)}`, 'PROOF');
  });

  const settle = () => run('settle', async () => {
    if (
      !address ||
      !memory?.pactId ||
      !memory.paycardId
    ) {
      throw new Error(
        'Complete the opening and Proof steps first.'
      );
    }

    await ensureSession();

    if (remaining > 0) {
      throw new Error(
        `The accelerated flow becomes fully earned in ${remaining}s.`
      );
    }

    add(
      'Checking GIWA for a previously submitted settlement',
      'GIWA',
      'pending',
    );

    const recovery = await api<{
      pact: Pact;
      recovered: Array<{
        transactionHash: Hash;
        settledAmountBaseUnits: string;
        final: boolean;
        alreadyRecorded: boolean;
      }>;
      chainFinal: boolean;
      broadcastAllowed: boolean;
    }>('/api/live/settlements/recover', {
      method: 'POST',
      body: JSON.stringify({
        pactId: memory.pactId,
      }),
    });

    const recoveredSettlement =
      recovery.recovered.at(-1);

    if (recoveredSettlement) {
      const final =
        recovery.pact.status === 'settled' ||
        recoveredSettlement.final;

      setPact(recovery.pact);

      setMemory((current) =>
        current
          ? {
              ...current,
              settlementTxHash:
                recoveredSettlement.transactionHash,
              phase: final ? 'settled' : 'proved',
            }
          : current
      );

      add(
        `${formatOrUsd(
          BigInt(
            recoveredSettlement.settledAmountBaseUnits
          )
        )} settlement recovered and canonically observed${
          final ? ' · FINAL' : ' · PARTIAL'
        }`,
        'GIWA',
      );

      await refreshAccount();
      return;
    }

    if (!recovery.broadcastAllowed) {
      setPact(recovery.pact);

      throw new Error(
        recovery.chainFinal
          ? 'The Paycard is already final on GIWA. No additional settlement transaction was submitted.'
          : 'Settlement broadcasting is currently blocked.'
      );
    }

    const client = await walletClient();

    add(
      'Settlement transaction submitted',
      'WALLET',
      'pending',
    );

    const hash = await client.writeContract({
      account: address,
      address: GIWA.contracts.vault,
      abi: vaultAbi,
      functionName: 'processDripSettle',
      args: [memory.paycardId],
    });

    const receipt =
      await waitForCanonicalReceipt(hash);

    const amount =
      settledAmount(receipt, memory.paycardId);

    if (amount === 0n) {
      throw new Error(
        'No settlement amount was emitted. Wait for the flow window and retry.'
      );
    }

    const settledPact = await api<Pact>(
      '/api/live/settlements/record',
      {
        method: 'POST',
        body: JSON.stringify({
          pactId: memory.pactId,
          actor: address,
          txHash: hash,
          settledAmountBaseUnits:
            amount.toString(),
        }),
      }
    );

    const final =
      settledPact.status === 'settled';

    setPact(settledPact);

    setMemory((current) =>
      current
        ? {
            ...current,
            settlementTxHash: hash,
            phase: final ? 'settled' : 'proved',
          }
        : current
    );

    add(
      `${formatOrUsd(
        amount
      )} settled and canonically observed${
        final ? ' · FINAL' : ' · PARTIAL'
      }`,
      'GIWA',
    );

    if (!final) {
      add(
        'Paycard remains active; settle again after the final horizon',
        'GIWA',
        'pending',
      );
    }

    await refreshAccount();
  });

  const reset = () => {
    if (!address) return;
    const ids = deterministicIds(address);
    const next: RunMemory = { ...ids, phase: 'authority' };
    setMemory(next); setPact(undefined); setDecision(undefined); setBlockedDecision(undefined); setProofDecision(undefined); setActivity([]); setError('');
  };

  const accountSummary = useMemo(() => account ? [
    ['orUSD', formatOrUsd(account.orUsdBalance)], ['GIWA GAS', formatNative(account.nativeBalance)], ['FAUCET', account.canClaim ? 'AVAILABLE' : 'COOLDOWN'], ['BLOCK', account.blockNumber.toString()],
  ] : [], [account]);

  const paycardRecordStatus =
    pact?.status === 'settled'
      ? 'SETTLED'
      : memory?.openingTxHash
        ? 'OPEN'
        : pact
          ? 'PREPARED'
          : 'NOT OPEN';

  return (
    <section className="live-slice" aria-labelledby="live-slice-title">
      <div className="live-slice-heading">
        <div><span className="tech-label">LIVE VERTICAL SLICE / GIWA SEPOLIA</span><h2 id="live-slice-title">Run one complete OpenRails lifecycle.</h2></div>
        <p>Testnet-only, wallet-confirmed and self-recipient by default. The Runtime never receives a private key and every financial transition is confirmed through the connected wallet.</p>
      </div>

      <div className="live-account-strip">
        <div className="live-account-identity"><span>CONNECTED AUTHORITY</span><strong>{address ? short(address) : 'NOT CONNECTED'}</strong><small>{chainId !== GIWA.chainId ? 'WALLET CONNECTION REQUIRED' : sessionAddress ? 'GIWA / LIVE API AUTHENTICATED' : 'GIWA / SIGN SESSION ON FIRST ACTION'}</small></div>
        {accountSummary.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
        <button onClick={() => void (address ? refreshAccount() : connect())}>{connecting ? 'CONNECTING' : authenticating ? 'AUTHENTICATING' : address ? 'REFRESH' : 'CONNECT WALLET'}</button>
      </div>

      <div className="live-step-rail">
        {steps.map(([index, label], position) => {
          const complete = position < phaseIndex;
          const active = position === Math.max(0, phaseIndex);
          return <div key={index} className={`${complete ? 'complete' : ''} ${active ? 'active' : ''}`}><span>{index}</span><strong>{label}</strong><i /></div>;
        })}
      </div>

      <div className="live-console">
        <div className="live-actions">
          <div className="live-action-copy"><span>CURRENT STATE</span><h3>{currentPhase === 'idle' ? 'Connect and fund the test account.' : currentPhase === 'funded' ? 'Bind a signed Workspace, Agent, plugin and Path.' : currentPhase === 'authority' ? 'Submit a bounded commercial proposal.' : currentPhase === 'allowed' ? 'Turn the allowed proposal into a signed Pact.' : currentPhase === 'pact' ? 'Prepare and open the canonical Paycard.' : currentPhase === 'opened' ? 'Bind one signed activation milestone to the GIWA receipt.' : currentPhase === 'proved' ? `Settle after the accelerated ${LIVE_LIFESPAN_SECONDS}s earning window.` : 'Lifecycle settled and recorded.'}</h3><p>Live allocation: 420 orUSD. Path ceiling: 1,000 orUSD. Accelerated duration: {LIVE_LIFESPAN_SECONDS} seconds.</p></div>
          <div className="live-action-buttons">
            {!address && <button className="primary" onClick={() => void connect()}>Connect wallet</button>}
            {address && account?.canClaim && account.orUsdBalance < LIVE_ALLOCATION && <button className="primary" disabled={Boolean(busy)} onClick={claim}>{busy === 'claim' ? 'Claiming…' : 'Claim 1,000 orUSD'}</button>}
            {canOperate && phaseIndex < 2 && <button className="primary" disabled={Boolean(busy)} onClick={bootstrap}>{busy === 'bootstrap' ? 'Signing authority…' : 'Initialize live authority'}</button>}
            {canOperate && currentPhase === 'authority' && <button className="primary" disabled={Boolean(busy)} onClick={() => evaluate(false)}>{busy === 'evaluate' ? 'Evaluating…' : 'Submit 420 orUSD proposal'}</button>}
            {canOperate && phaseIndex >= 2 && <button disabled={Boolean(busy)} onClick={() => evaluate(true)}>{busy === 'blocked' ? 'Testing…' : 'Test 1,420 orUSD block'}</button>}
            {currentPhase === 'allowed' && <button className="primary" disabled={Boolean(busy)} onClick={createPact}>{busy === 'pact' ? 'Signing Pact…' : 'Create and sign Pact'}</button>}
            {currentPhase === 'pact' && <button className="primary" disabled={Boolean(busy)} onClick={openPayment}>{busy === 'open' ? 'Opening on GIWA…' : 'Open 420 orUSD Paycard'}</button>}
            {currentPhase === 'opened' && <button className="primary" disabled={Boolean(busy)} onClick={prove}>{busy === 'proof' ? 'Verifying…' : 'Submit receipt Proof'}</button>}
            {currentPhase === 'proved' && <button className="primary" disabled={Boolean(busy) || remaining > 0} onClick={settle}>{busy === 'settle' ? 'Settling…' : remaining > 0 ? `Eligible in ${remaining}s` : 'Settle on GIWA'}</button>}
            {currentPhase === 'settled' && <button onClick={reset}>Start another run</button>}
          </div>

          <AnimatePresence>{error && <motion.div className="live-error" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><span>EXECUTION STOPPED</span><strong>{error}</strong><button onClick={() => setError('')}>Dismiss</button></motion.div>}</AnimatePresence>

          {pact && phaseIndex >= 3 && (
            <PaycardInstrument
              pact={pact}
              remaining={remaining}
              verificationDecision={proofDecision}
              explorerUrl={GIWA.explorerUrl}
            />
          )}

          <div className="live-records">
            <article><span>BAPHOMET DECISION</span><strong>{decision ? String(decision.result) : 'NOT RUN'}</strong><code>{decision ? short(String(decision.decisionHash)) : '—'}</code></article>
            <article><span>BLOCKED CONTROL</span><strong>{blockedDecision ? String(blockedDecision.result) : 'READY'}</strong><code>{blockedDecision ? String(blockedDecision.reasonCodes) : 'MAX 1,000 orUSD'}</code></article>
            <article><span>PACT</span><strong>{pact?.status?.toUpperCase() ?? 'NOT FORMED'}</strong><code>{pact ? short(pact.termsHash) : '—'}</code></article>
            <article><span>PAYCARD</span><strong>{paycardRecordStatus}</strong><code>{short(memory?.paycardId)}</code></article>
            <article><span>OPENING RECEIPT</span><strong>{memory?.openingTxHash ? 'CONFIRMED' : 'PENDING'}</strong>{memory?.openingTxHash ? <a href={`${GIWA.explorerUrl}/tx/${memory.openingTxHash}`} target="_blank" rel="noreferrer">{short(memory.openingTxHash)} ↗</a> : <code>—</code>}</article>
            <article><span>SETTLEMENT RECEIPT</span><strong>{memory?.settlementTxHash ? 'CONFIRMED' : 'PENDING'}</strong>{memory?.settlementTxHash ? <a href={`${GIWA.explorerUrl}/tx/${memory.settlementTxHash}`} target="_blank" rel="noreferrer">{short(memory.settlementTxHash)} ↗</a> : <code>—</code>}</article>
          </div>
        </div>

        <aside className="live-activity">
          <div><span>LIVE ACTIVITY</span><strong>{activity.length.toString().padStart(2, '0')} EVENTS</strong></div>
          <ol>{activity.length ? activity.map((item, index) => <motion.li key={`${item.at}-${item.label}-${index}`} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} className={item.status}><time>{item.at}</time><span>{item.source}</span><strong>{item.label}</strong></motion.li>) : <li className="empty"><strong>Connect a wallet to begin the canonical run.</strong></li>}</ol>
        </aside>
      </div>

      <div className="live-boundary"><span>AUTHORIZATION BOUNDARY</span><strong>Kernel prepares and verifies</strong><i>→</i><strong>Wallet signs and broadcasts</strong><i>→</i><strong>GIWA finalises</strong></div>
    </section>
  );
}
