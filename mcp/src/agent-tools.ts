import type { OpenRailsContext } from './context.js';
import { prepareRailsFlow } from './tools.js';
import { buildAgentKernel, createBuiltinPlugin } from './agent-kernel.js';
import type {
  AgentIdentityV1,
  AgentProposalV1,
  ExecutionCheckpointV1,
  GaiaCaseV1,
  PactV1,
  PathV1,
  VerificationPluginManifestV1,
  WorkspaceCommandV1,
  WorkspaceV1,
} from '../../agent-kernel/dist/index.js';

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
          canonicalChainEvidenceRequiredForFinancialState: true,
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
    prepareWorkspaceCommand: (args: { workspaceId: string; operation: WorkspaceCommandV1['operation']; payloadJson: string; ttlSeconds?: number }) =>
      kernel.prepareWorkspaceCommand({ workspaceId: args.workspaceId, operation: args.operation, payload: parseJson<unknown>(args.payloadJson, 'payloadJson'), ...(args.ttlSeconds !== undefined ? { ttlSeconds: args.ttlSeconds } : {}) }),
    prepareAgent: (args: { agentJson: string }) => kernel.prepareAgentRegistration(parseJson<any>(args.agentJson, 'agentJson')),
    registerAgent: (args: { agentJson: string; authoritySigner: `0x${string}`; signature: `0x${string}` }) =>
      kernel.registerAgent({ agent: parseJson<AgentIdentityV1>(args.agentJson, 'agentJson'), authoritySigner: args.authoritySigner, signature: args.signature }),
    setAgentStatus: (args: { workspaceId: string; agentId: string; status: AgentIdentityV1['status']; commandJson: string; signature: `0x${string}` }) =>
      kernel.setAgentStatus({ workspaceId: args.workspaceId, agentId: args.agentId, status: args.status, command: parseJson<WorkspaceCommandV1>(args.commandJson, 'commandJson'), signature: args.signature }),
    preparePath: (args: { pathJson: string }) => kernel.preparePath(parseJson<PathV1>(args.pathJson, 'pathJson')),
    activatePath: (args: { pathJson: string; signature: `0x${string}` }) =>
      kernel.activatePath({ path: parseJson<PathV1>(args.pathJson, 'pathJson'), signature: args.signature }),
    submitProposal: (args: { proposalJson: string }) => kernel.submitProposal(parseJson<AgentProposalV1>(args.proposalJson, 'proposalJson')),
    runNextJob: (args: { workerId?: string }) => kernel.runNextJob(args.workerId),
    getJob: (args: { jobId: string }) => kernel.getJob(args.jobId),
    createPact: (args: {
      proposalId: string;
      pactId: string;
      commercialTermsJson: string;
      completionPolicyId: string;
      disputePolicyId: string;
      requiresCounterpartySignature?: boolean;
    }) => kernel.createPactFromProposal({
      proposalId: args.proposalId,
      pactId: args.pactId,
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
      const draft = await prepareRailsFlow(ctx, {
        payerAddress: pact.paymentTerms.payer,
        recipientAddress: pact.paymentTerms.recipient,
        totalAllocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
        flowVelocityBaseUnitsPerSecond: pact.paymentTerms.velocityBaseUnitsPerSecond,
        lifespanSeconds: pact.paymentTerms.lifespanSeconds,
        ...(args.nonceChannel !== undefined ? { nonceChannel: args.nonceChannel } : {}),
        residualDeltaRecipient: pact.paymentTerms.residualRecipient,
        workflowId: binding.workflowId,
        metadataRef: binding.metadataRef,
        descriptionHash: binding.descriptionHash,
        salt: binding.salt,
      });
      await kernel.bindOpenRailsPayment({
        pactId: pact.pactId,
        metadataHash: draft.metadataHash as `0x${string}`,
        paycardId: draft.paycardId as `0x${string}`,
        actor: pact.paymentTerms.payer,
        genesisTimestamp: draft.intent.genesisTimestamp,
        nonceChannel: draft.intent.nonceChannel,
        nonceValue: draft.intent.nonceValue,
      });
      return draft;
    },
    bindPactPayment: (args: { pactId: string; metadataHash: `0x${string}`; paycardId: `0x${string}`; actor: `0x${string}`; openingTxHash: `0x${string}` }) =>
      kernel.bindOpenRailsPayment(args),
    recordPactSettlement: (args: { pactId: string; actor: string; txHash: `0x${string}`; settledAmountBaseUnits: string; final: boolean }) =>
      kernel.recordPactSettlement(args),
    installPlugin: async (args: { manifestJson: string; commandJson: string; signature: `0x${string}` }) => {
      const manifest = parseJson<VerificationPluginManifestV1>(args.manifestJson, 'manifestJson');
      const implementation = createBuiltinPlugin(manifest);
      if (!implementation) throw new Error('This MCP only binds explicitly trusted built-in verification implementations');
      const installed = await kernel.installPlugin({ manifest, command: parseJson<WorkspaceCommandV1>(args.commandJson, 'commandJson'), signature: args.signature });
      plugins.bind(implementation);
      return installed;
    },
    submitCheckpoint: (args: { checkpointJson: string }) => kernel.submitCheckpoint(parseJson<ExecutionCheckpointV1>(args.checkpointJson, 'checkpointJson')),
    verifyCheckpoint: (args: { checkpointId: string; pluginId: string; pluginVersion: string }) => kernel.verifyCheckpoint(args),
    openGaiaCase: (args: { gaiaCaseJson: string }) => kernel.openGaiaCase(parseJson<any>(args.gaiaCaseJson, 'gaiaCaseJson')),
    resolveGaiaCase: (args: { caseId: string; resolver: `0x${string}`; decision: NonNullable<GaiaCaseV1['decision']>; resolutionSummary: string; rectificationTermsJson?: string; commandJson: string; signature: `0x${string}` }) => kernel.resolveGaiaCase({
      caseId: args.caseId,
      resolver: args.resolver,
      decision: args.decision,
      resolutionSummary: args.resolutionSummary,
      ...(args.rectificationTermsJson ? { rectificationTerms: parseJson<Record<string, unknown>>(args.rectificationTermsJson, 'rectificationTermsJson') } : {}),
      command: parseJson<WorkspaceCommandV1>(args.commandJson, 'commandJson'),
      signature: args.signature,
    }),
    getWorkspace: (args: { workspaceId: string }) => kernel.getWorkspace(args.workspaceId),
    getAgent: (args: { agentId: string }) => kernel.getAgent(args.agentId),
    getPath: (args: { pathId: string }) => kernel.getPath(args.pathId),
    getPact: (args: { pactId: string }) => kernel.getPact(args.pactId),
    listBlocked: (args: { workspaceId: string }) => kernel.listBlockedActions(args.workspaceId),
    exportAudit: (args: { workspaceId: string }) => kernel.exportAuditBundle(args.workspaceId),
  };
}
