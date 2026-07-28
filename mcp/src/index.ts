#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildContext } from './context.js';
import {
  getBalance,
  getNonce,
  getPaycard,
  networkInfo,
  prepareRailsFlow,
  type PrepareRailsFlowArgs,
} from './tools.js';
import { buildAgentTools } from './agent-tools.js';

const ctx = buildContext();
const agent = buildAgentTools(ctx);

const server = new McpServer(
  { name: 'openrails-giwa', version: '0.3.0' },
  {
    instructions:
      'Inspect the canonical OpenRails GIWA Sepolia deployment and operate the non-custodial Agent Kernel. This server accepts no private keys, signs nothing, submits no transactions, and never accepts arbitrary calldata.',
  },
);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function fail(error: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}
async function run(operation: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try { return ok(await operation()); } catch (error) { return fail(error); }
}
const registerTool = server.registerTool.bind(server) as unknown as (
  name: string,
  config: { description?: string; inputSchema: Record<string, unknown> },
  handler: (...args: any[]) => unknown,
) => unknown;

registerTool('openrails_network_info', {
  description: 'Return canonical OpenRails GIWA Sepolia network, deployment, RPC, token, explorer, and safety information.',
  inputSchema: {},
}, async () => run(() => networkInfo(ctx)));

registerTool('openrails_get_balance', {
  description: 'Read an address orUSD balance from the canonical GIWA Sepolia token contract.',
  inputSchema: { address: z.string().describe('EVM address to inspect.') },
}, async (args: { address: string }) => run(() => getBalance(ctx, args)));

registerTool('openrails_get_nonce', {
  description: 'Read the current OpenRails nonce for a payer and nonce channel.',
  inputSchema: {
    payerAddress: z.string(),
    nonceChannel: z.number().int().nonnegative().optional(),
  },
}, async (args: { payerAddress: string; nonceChannel?: number }) => run(() => getNonce(ctx, args)));

registerTool('openrails_get_paycard', {
  description: 'Read canonical OpenRails paycard or stream state by bytes32 paycard ID.',
  inputSchema: { paycardId: z.string() },
}, async (args: { paycardId: string }) => run(() => getPaycard(ctx, args)));

registerTool('openrails_prepare_railsflow', {
  description: 'Prepare unsigned bounded RailsFlow metadata, paycard ID, intent, EIP-712 typed data, approval requirement, and projected economics. Never signs or submits.',
  inputSchema: {
    payerAddress: z.string(),
    recipientAddress: z.string(),
    totalAllocationBaseUnits: z.string().regex(/^[0-9]+$/),
    flowVelocityBaseUnitsPerSecond: z.string().regex(/^[0-9]+$/),
    lifespanSeconds: z.number().int().positive().max(31_536_000),
    nonceChannel: z.number().int().nonnegative().optional(),
    residualDeltaRecipient: z.string().optional(),
    workflowId: z.string().max(128).optional(),
    metadataRef: z.string().max(256).optional(),
    descriptionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    salt: z.string().max(256).optional(),
  },
}, async (args: PrepareRailsFlowArgs) => run(() => prepareRailsFlow(ctx, args)));

const json = (description: string) => z.string().describe(description);
const signature = z.string().regex(/^0x[0-9a-fA-F]+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

registerTool('openrails_kernel_info', {
  description: 'Return Agent Kernel mode, safety boundary, supported authority modes, and durable-state counts.',
  inputSchema: {},
}, async () => run(() => agent.kernelInfo()));

registerTool('openrails_prepare_workspace', {
  description: 'Prepare an unsigned Workspace authority artifact. Does not sign or register it.',
  inputSchema: {
    workspaceId: z.string(),
    workspaceType: z.enum(['individual', 'organization']),
    displayName: z.string(),
    principalId: z.string(),
    authorityAccount: address,
    authorityType: z.literal('eoa').describe('Agent Kernel V1 currently supports EOA Workspace authorities only.'),
  },
}, async (args: Record<string, unknown>) => run(() => agent.prepareWorkspace(args)));

registerTool('openrails_register_workspace', {
  description: 'Verify an externally signed Workspace artifact and register it. No private key is accepted.',
  inputSchema: { workspaceJson: json('Prepared Workspace JSON.'), signature },
}, async (args: { workspaceJson: string; signature: `0x${string}` }) => run(() => agent.registerWorkspace(args)));

registerTool('openrails_prepare_workspace_command', {
  description: 'Prepare a nonce-protected, expiring Workspace administrative command for external wallet signature.',
  inputSchema: {
    workspaceId: z.string(),
    operation: z.enum(['set_agent_status', 'install_plugin', 'resolve_gaia', 'pause_path', 'revoke_path']),
    payloadJson: json('Exact command payload JSON.'),
    ttlSeconds: z.number().int().min(30).max(900).optional(),
  },
}, async (args: any) => run(() => agent.prepareWorkspaceCommand(args)));

registerTool('openrails_prepare_agent', {
  description: 'Prepare an unsigned Workspace-scoped Agent registration artifact.',
  inputSchema: { agentJson: json('Agent registration input JSON without generated version/status/revision fields.') },
}, async (args: { agentJson: string }) => run(() => agent.prepareAgent(args)));

registerTool('openrails_register_agent', {
  description: 'Verify Workspace-authority approval and register an Agent identity without granting custody.',
  inputSchema: { agentJson: json('Prepared AgentIdentityV1 JSON.'), authoritySigner: address, signature },
}, async (args: { agentJson: string; authoritySigner: `0x${string}`; signature: `0x${string}` }) => run(() => agent.registerAgent(args)));

registerTool('openrails_set_agent_status', {
  description: 'Apply a signed, nonce-protected Workspace command to pause, activate, or revoke an Agent.',
  inputSchema: {
    workspaceId: z.string(),
    agentId: z.string(),
    status: z.enum(['pending', 'active', 'paused', 'revoked']),
    commandJson: json('Prepared WorkspaceCommandV1 JSON.'),
    signature,
  },
}, async (args: any) => run(() => agent.setAgentStatus(args)));

registerTool('openrails_prepare_path', {
  description: 'Canonicalize, hash, and prepare EIP-712 typed data for a versioned Path.',
  inputSchema: { pathJson: json('Complete PathV1 JSON.') },
}, async (args: { pathJson: string }) => run(() => agent.preparePath(args)));

registerTool('openrails_activate_path', {
  description: 'Verify an externally signed Path and activate or revise it. Agents cannot self-authorize Paths.',
  inputSchema: { pathJson: json('Complete PathV1 JSON.'), signature },
}, async (args: { pathJson: string; signature: `0x${string}` }) => run(() => agent.activatePath(args)));

registerTool('openrails_submit_proposal', {
  description: 'Submit a typed Agent proposal for durable Baphomet evaluation. No calldata or transaction submission is accepted.',
  inputSchema: { proposalJson: json('Complete AgentProposalV1 JSON.') },
}, async (args: { proposalJson: string }) => run(() => agent.submitProposal(args)));

registerTool('openrails_run_next_job', {
  description: 'Run one queued non-custodial Agent Kernel evaluation job.',
  inputSchema: { workerId: z.string().optional() },
}, async (args: { workerId?: string }) => run(() => agent.runNextJob(args)));

registerTool('openrails_get_job', {
  description: 'Read one durable Agent Kernel job.',
  inputSchema: { jobId: z.string() },
}, async (args: { jobId: string }) => run(() => agent.getJob(args)));

registerTool('openrails_create_pact', {
  description: 'Create a Pact from an ALLOW decision. This forms agreement state but does not authorize payment.',
  inputSchema: {
    proposalId: z.string(),
    pactId: z.string(),
    commercialTermsJson: json('Commercial terms JSON.'),
    completionPolicyId: z.string(),
    disputePolicyId: z.string(),
    requiresCounterpartySignature: z.boolean().optional(),
  },
}, async (args: any) => run(() => agent.createPact(args)));

registerTool('openrails_prepare_pact_signature', {
  description: 'Prepare the EIP-712 typed-data artifact for a Pact signature.',
  inputSchema: { pactJson: json('Complete PactV1 JSON.') },
}, async (args: { pactJson: string }) => run(() => agent.preparePactSignature(args)));

registerTool('openrails_sign_pact_record', {
  description: 'Verify and record an externally produced Pact signature. This server never creates the signature.',
  inputSchema: { pactId: z.string(), signer: address, signature },
}, async (args: { pactId: string; signer: `0x${string}`; signature: `0x${string}` }) => run(() => agent.signPact(args)));

registerTool('openrails_prepare_pact_railsflow', {
  description: 'Prepare an unsigned RailsFlow bound to an accepted Pact and its signed Path revision.',
  inputSchema: { pactId: z.string(), nonceChannel: z.number().int().nonnegative().optional() },
}, async (args: { pactId: string; nonceChannel?: number }) => run(() => agent.preparePactRailsFlow(args)));

registerTool('openrails_bind_pact_payment', {
  description: 'Verify a canonically confirmed GIWA opening transaction against the prepared Pact payment and activate the Pact.',
  inputSchema: { pactId: z.string(), metadataHash: bytes32, paycardId: bytes32, actor: address, openingTxHash: bytes32 },
}, async (args: any) => run(() => agent.bindPactPayment(args)));

registerTool('openrails_record_pact_settlement', {
  description: 'Verify a canonical GIWA SettlementFlushed event and record the observed settlement on its Pact.',
  inputSchema: {
    pactId: z.string(),
    actor: z.string(),
    txHash: bytes32,
    settledAmountBaseUnits: z.string().regex(/^[0-9]+$/),
    final: z.boolean(),
  },
}, async (args: { pactId: string; actor: string; txHash: `0x${string}`; settledAmountBaseUnits: string; final: boolean }) => run(() => agent.recordPactSettlement(args)));

registerTool('openrails_install_verification_plugin', {
  description: 'Install a versioned verification manifest in a Workspace. Plugins receive no custody or signing authority.',
  inputSchema: { manifestJson: json('VerificationPluginManifestV1 JSON.'), commandJson: json('Prepared install_plugin WorkspaceCommandV1 JSON.'), signature },
}, async (args: { manifestJson: string; commandJson: string; signature: `0x${string}` }) => run(() => agent.installPlugin(args)));

registerTool('openrails_submit_checkpoint', {
  description: 'Submit an unverified checkpoint claim bound to a Pact terms hash for later signature and evidence verification.',
  inputSchema: { checkpointJson: json('ExecutionCheckpointV1 JSON.') },
}, async (args: { checkpointJson: string }) => run(() => agent.submitCheckpoint(args)));

registerTool('openrails_verify_checkpoint', {
  description: 'Run a Path-approved verification plugin and record approved, rejected, or review output.',
  inputSchema: { checkpointId: z.string(), pluginId: z.string(), pluginVersion: z.string() },
}, async (args: { checkpointId: string; pluginId: string; pluginVersion: string }) => run(() => agent.verifyCheckpoint(args)));

registerTool('openrails_open_gaia_case', {
  description: 'Open a runtime Gaia case. This does not reverse finalized transfers.',
  inputSchema: { gaiaCaseJson: json('Gaia case input JSON without generated version/status/timestamps.') },
}, async (args: { gaiaCaseJson: string }) => run(() => agent.openGaiaCase(args)));

registerTool('openrails_resolve_gaia_case', {
  description: 'Resolve a Gaia case through dismissal, residual closure, replacement Pact, compensation, or manual review.',
  inputSchema: {
    caseId: z.string(),
    resolver: address,
    decision: z.enum(['dismiss', 'close_and_return_residual', 'replacement_pact', 'compensating_pact', 'manual_review']),
    resolutionSummary: z.string(),
    rectificationTermsJson: json('Optional rectification terms JSON.').optional(),
    commandJson: json('Prepared resolve_gaia WorkspaceCommandV1 JSON.'),
    signature,
  },
}, async (args: any) => run(() => agent.resolveGaiaCase(args)));

registerTool('openrails_get_workspace', { description: 'Read a Workspace.', inputSchema: { workspaceId: z.string() } }, async (args: { workspaceId: string }) => run(() => agent.getWorkspace(args)));
registerTool('openrails_get_agent', { description: 'Read an Agent identity.', inputSchema: { agentId: z.string() } }, async (args: { agentId: string }) => run(() => agent.getAgent(args)));
registerTool('openrails_get_path', { description: 'Read the active signed Path artifact.', inputSchema: { pathId: z.string() } }, async (args: { pathId: string }) => run(() => agent.getPath(args)));
registerTool('openrails_get_pact', { description: 'Read Pact state.', inputSchema: { pactId: z.string() } }, async (args: { pactId: string }) => run(() => agent.getPact(args)));
registerTool('openrails_list_blocked_actions', { description: 'List policy-blocked Agent proposals for a Workspace.', inputSchema: { workspaceId: z.string() } }, async (args: { workspaceId: string }) => run(() => agent.listBlocked(args)));
registerTool('openrails_export_audit_bundle', { description: 'Export a canonical Workspace audit bundle and integrity hash.', inputSchema: { workspaceId: z.string() } }, async (args: { workspaceId: string }) => run(() => agent.exportAudit(args)));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('openrails-giwa ready · agent-kernel · read/propose/prepare/confirmed-external-wallet · no signer · no transaction submission');
}

main().catch((error: unknown) => {
  console.error('openrails-giwa failed to start:', error);
  process.exit(1);
});
