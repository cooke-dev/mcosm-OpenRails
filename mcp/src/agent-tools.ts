import { ethers } from 'ethers';
import type { OpenRailsContext } from './context.js';
import { prepareRailsFlow } from './tools.js';
import { bindBuiltinPlugin, buildAgentKernel } from './agent-kernel.js';
import type {
  AgentIdentityV1,
  AgentProposalV1,
  ExecutionCheckpointV1,
  GaiaCaseV1,
  PactV1,
  PathV1,
  VerificationPluginManifestV1,
  WorkspaceV1,
} from '../../agent-kernel/dist/index.js';


const paycardEvents = new ethers.Interface([
  'event PaycardProvisioned(bytes32 indexed paycardId,address indexed payer,address indexed recipient,bytes32 metadataHash,uint256 poolAllocation,uint256 flowVelocityPerSecond,uint256 genesisTimestamp,uint256 lifespanSeconds)',
]);

async function verifyOpeningTransaction(ctx: OpenRailsContext, pact: PactV1, input: { metadataHash: `0x${string}`; paycardId: `0x${string}`; openingTxHash: `0x${string}` }): Promise<void> {
  const receipt = await ctx.provider.getTransactionReceipt(input.openingTxHash);
  if (!receipt) throw new Error('opening transaction is not canonically confirmed on GIWA');
  if (receipt.status !== 1) throw new Error('opening transaction reverted');
  if (!receipt.to || ethers.getAddress(receipt.to) !== ethers.getAddress(ctx.config.vaultAddress)) throw new Error('opening transaction target is not the canonical OpenRails vault');
  let matched = false;
  for (const log of receipt.logs) {
    if (ethers.getAddress(log.address) !== ethers.getAddress(ctx.config.vaultAddress)) continue;
    try {
      const parsed = paycardEvents.parseLog(log);
      if (!parsed || parsed.name !== 'PaycardProvisioned') continue;
      matched =
        parsed.args.paycardId === input.paycardId &&
        parsed.args.metadataHash === input.metadataHash &&
        ethers.getAddress(parsed.args.payer) === ethers.getAddress(pact.paymentTerms.payer) &&
        ethers.getAddress(parsed.args.recipient) === ethers.getAddress(pact.paymentTerms.recipient);
      if (matched) break;
    } catch {
      // Ignore unrelated logs.
    }
  }
  if (!matched) throw new Error('opening transaction does not contain the Pact-bound PaycardProvisioned event');
}

function parseJson<T>(value: string, field: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${field} must be valid JSON`); }
}

export function buildAgentTools(ctx: OpenRailsContext) {
  const { kernel, plugins } = buildAgentKernel(ctx);

  return {
    async kernelInfo() {
      const state = await kernel.state();
      return {
        version: state.version,
        mode: 'workspace-owned-eoa-confirmed',
        authorityModes: ['observe', 'propose', 'prepare', 'confirmed_execution'],
        safety: {
          acceptsPrivateKeys: false,
          signs: false,
          broadcasts: false,
          arbitraryCalldata: false,
          autonomousSpendingAdvertised: false,
          frontendIncluded: false,
        },
        counts: {
          workspaces: Object.keys(state.workspaces).length,
          agents: Object.keys(state.agents).length,
          paths: Object.keys(state.paths).length,
          pacts: Object.keys(state.pacts).length,
          blockedActions: state.blockedActions.length,
          gaiaCases: Object.keys(state.gaiaCases).length,
        },
      };
    },
    prepareWorkspace: (args: Record<string, unknown>) => kernel.prepareWorkspace(args as any),
    registerWorkspace: (args: { workspaceJson: string; signature: `0x${string}` }) =>
      kernel.registerWorkspace({ workspace: parseJson<WorkspaceV1>(args.workspaceJson, 'workspaceJson'), signature: args.signature }),
    prepareAgent: (args: { agentJson: string }) => kernel.prepareAgentRegistration(parseJson<any>(args.agentJson, 'agentJson')),
    registerAgent: (args: { agentJson: string; authoritySigner: `0x${string}`; signature: `0x${string}` }) =>
      kernel.registerAgent({ agent: parseJson<AgentIdentityV1>(args.agentJson, 'agentJson'), authoritySigner: args.authoritySigner, signature: args.signature }),
    preparePath: (args: { pathJson: string }) => kernel.preparePath(parseJson<PathV1>(args.pathJson, 'pathJson')),
    activatePath: (args: { pathJson: string; signature: `0x${string}` }) =>
      kernel.activatePath({ path: parseJson<PathV1>(args.pathJson, 'pathJson'), signature: args.signature }),
    submitProposal: (args: { proposalJson: string }) => kernel.submitProposal(parseJson<AgentProposalV1>(args.proposalJson, 'proposalJson')),
    runNextJob: (args: { workerId?: string }) => kernel.runNextJob(args.workerId),
    getJob: (args: { jobId: string }) => kernel.getJob(args.jobId),
    createPact: (args: {
      proposalId: string;
      pactId: string;
      counterparty: `0x${string}`;
      initiator: `0x${string}`;
      commercialTermsJson: string;
      completionPolicyId: string;
      disputePolicyId: string;
      requiresCounterpartySignature?: boolean;
    }) => kernel.createPactFromProposal({
      proposalId: args.proposalId,
      pactId: args.pactId,
      counterparty: args.counterparty,
      initiator: args.initiator,
      commercialTerms: parseJson<Record<string, unknown>>(args.commercialTermsJson, 'commercialTermsJson'),
      completionPolicyId: args.completionPolicyId,
      disputePolicyId: args.disputePolicyId,
      ...(args.requiresCounterpartySignature !== undefined ? { requiresCounterpartySignature: args.requiresCounterpartySignature } : {}),
    }),
    preparePactSignature: (args: { pactJson: string }) => kernel.preparePactSignature(parseJson<PactV1>(args.pactJson, 'pactJson')),
    signPact: (args: { pactId: string; signer: `0x${string}`; signature: `0x${string}` }) => kernel.signPact(args),
    async preparePactRailsFlow(args: { pactId: string; nonceChannel?: number }) {
      const pact = await kernel.getPact(args.pactId);
      if (!pact) throw new Error('Pact not found');
      if (pact.status !== 'accepted') throw new Error('Pact must be accepted before payment preparation');
      const binding = await kernel.openRailsMetadataBinding(pact.pactId);
      return prepareRailsFlow(ctx, {
        payerAddress: pact.paymentTerms.payer,
        recipientAddress: pact.paymentTerms.recipient,
        totalAllocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
        flowVelocityBaseUnitsPerSecond: pact.paymentTerms.velocityBaseUnitsPerSecond,
        lifespanSeconds: pact.paymentTerms.lifespanSeconds,
        nonceChannel: args.nonceChannel,
        residualDeltaRecipient: pact.paymentTerms.residualRecipient,
        workflowId: binding.workflowId,
        metadataRef: binding.metadataRef,
        descriptionHash: binding.descriptionHash,
        salt: binding.salt,
      });
    },
    bindPactPayment: async (args: { pactId: string; metadataHash: `0x${string}`; paycardId: `0x${string}`; actor: `0x${string}`; openingTxHash?: `0x${string}` }) => {
      const pact = await kernel.getPact(args.pactId);
      if (!pact) throw new Error('Pact not found');
      if (args.openingTxHash) await verifyOpeningTransaction(ctx, pact, { metadataHash: args.metadataHash, paycardId: args.paycardId, openingTxHash: args.openingTxHash });
      return kernel.bindOpenRailsPayment(args);
    },
    installPlugin: async (args: { manifestJson: string; authoritySigner: `0x${string}` }) => {
      const manifest = parseJson<VerificationPluginManifestV1>(args.manifestJson, 'manifestJson');
      bindBuiltinPlugin(plugins, manifest);
      return kernel.installPlugin(manifest, args.authoritySigner);
    },
    submitCheckpoint: (args: { checkpointJson: string }) => kernel.submitCheckpoint(parseJson<ExecutionCheckpointV1>(args.checkpointJson, 'checkpointJson')),
    verifyCheckpoint: (args: { checkpointId: string; pluginId: string; pluginVersion: string }) => kernel.verifyCheckpoint(args),
    openGaiaCase: (args: { gaiaCaseJson: string }) => kernel.openGaiaCase(parseJson<any>(args.gaiaCaseJson, 'gaiaCaseJson')),
    resolveGaiaCase: (args: { caseId: string; resolver: `0x${string}`; decision: NonNullable<GaiaCaseV1['decision']>; resolutionSummary: string; rectificationTermsJson?: string }) => kernel.resolveGaiaCase({
      caseId: args.caseId,
      resolver: args.resolver,
      decision: args.decision,
      resolutionSummary: args.resolutionSummary,
      ...(args.rectificationTermsJson ? { rectificationTerms: parseJson<Record<string, unknown>>(args.rectificationTermsJson, 'rectificationTermsJson') } : {}),
    }),
    getWorkspace: (args: { workspaceId: string }) => kernel.getWorkspace(args.workspaceId),
    getAgent: (args: { agentId: string }) => kernel.getAgent(args.agentId),
    getPath: (args: { pathId: string }) => kernel.getPath(args.pathId),
    getPact: (args: { pactId: string }) => kernel.getPact(args.pactId),
    listBlocked: (args: { workspaceId: string }) => kernel.listBlockedActions(args.workspaceId),
    exportAudit: (args: { workspaceId: string }) => kernel.exportAuditBundle(args.workspaceId),
  };
}
