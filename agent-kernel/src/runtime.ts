import {
  assertAddress,
  assertHex32,
  canonicalJson,
  clone,
  hashCanonical,
  nowIso,
  parseBaseUnits,
  parseIso,
  sha256Hex,
  stableId,
} from "./canonical.js";
import { ActionRegistry } from "./actionRegistry.js";
import { evaluateProposal, type CounterpartyIdentityResolver } from "./evaluator.js";
import { VerificationPluginRegistry } from "./plugins.js";
import { GIWA_SEPOLIA } from "./giwa.js";
import type { KernelStore } from "./store.js";
import {
  agentRegistrationTypedData,
  assertPactTermsIntegrity,
  checkpointTypedData,
  gaiaCaseClaimHash,
  gaiaCaseClaimTypedData,
  pactTermsHash,
  pactTypedData,
  pathTypedData,
  workspaceTypedData,
  verificationPluginTypedData,
  workspaceCommandTypedData,
  type AuthoritySignatureVerifier,
} from "./typedData.js";
import type {
  Address,
  AgentIdentityV1,
  AgentProposalV1,
  BaphometDecisionV1,
  BlockedActionV1,
  ExecutionCheckpointV1,
  GaiaCaseV1,
  Hex,
  KernelEventV1,
  KernelStateV1,
  OpenRailsOpeningObservationV1,
  OpenRailsSettlementObservationV1,
  PactEventV1,
  PactV1,
  PathV1,
  RectificationObligationV1,
  RuntimeJobV1,
  SignedArtifactV1,
  VerificationDecisionV1,
  VerificationPluginManifestV1,
  WorkspaceCommandV1,
  WorkspaceV1,
} from "./types.js";

export interface OpenRailsChainVerifier {
  verifyOpening(input: {
    pact: PactV1;
    metadataHash: Hex;
    paycardId: Hex;
    openingTxHash: Hex;
  }): Promise<OpenRailsOpeningObservationV1>;
  verifySettlement(input: {
    pact: PactV1;
    txHash: Hex;
    settledAmountBaseUnits: string;
    final: boolean;
  }): Promise<OpenRailsSettlementObservationV1>;
}

export interface KernelOptions {
  store: KernelStore;
  signatureVerifier: AuthoritySignatureVerifier;
  actionRegistry?: ActionRegistry;
  pluginRegistry?: VerificationPluginRegistry;
  identityResolver?: CounterpartyIdentityResolver;
  chainVerifier?: OpenRailsChainVerifier;
  now?: () => Date;
}

function requireWorkspace(state: KernelStateV1, workspaceId: string): WorkspaceV1 {
  const workspace = state.workspaces[workspaceId];
  if (!workspace) throw new Error("Workspace not found");
  return workspace;
}

function requireAgent(state: KernelStateV1, agentId: string): AgentIdentityV1 {
  const agent = state.agents[agentId];
  if (!agent) throw new Error("Agent not found");
  return agent;
}

function requirePath(state: KernelStateV1, pathId: string): SignedArtifactV1<PathV1> {
  const path = state.paths[pathId];
  if (!path) throw new Error("Path not found");
  return path;
}

function requirePact(state: KernelStateV1, pactId: string): PactV1 {
  const pact = state.pacts[pactId];
  if (!pact) throw new Error("Pact not found");
  return pact;
}

function assertAuthority(workspace: WorkspaceV1, signer: Address): void {
  if (workspace.authorityAccount.toLowerCase() !== signer.toLowerCase()) throw new Error("Workspace authority mismatch");
}

function assertRevision(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label} revision conflict: expected ${expected}, found ${actual}`);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertPactExecutionEligible(state: KernelStateV1, pact: PactV1, nowMs: number): SignedArtifactV1<PathV1> {
  assertPact(pact);
  const workspace = requireWorkspace(state, pact.workspaceId);
  if (workspace.status !== "active") throw new Error("Pact Workspace is not active");
  const agent = requireAgent(state, pact.agentId);
  if (agent.workspaceId !== workspace.workspaceId || agent.status !== "active") throw new Error("Pact Agent is not active in the Workspace");
  const signedPath = requirePath(state, pact.pathId);
  const path = signedPath.artifact;
  if (signedPath.hash !== pact.pathHash || path.revision !== pact.pathRevision) throw new Error("Pact is bound to a stale Path revision");
  if (path.status !== "active") throw new Error("Pact Path is not active");
  if (parseIso(path.validFrom, "Path validFrom") > nowMs) throw new Error("Pact Path is not yet valid");
  if (parseIso(path.expiresAt, "Path expiresAt") <= nowMs) throw new Error("Pact Path has expired");
  if (!path.authorizedAgentIds.includes(pact.agentId)) throw new Error("Pact Agent is no longer authorized by the Path");
  if (!path.permittedActions.includes(pact.actionType)) throw new Error("Pact action is no longer authorized by the Path");
  if (!path.permittedAssets.some((asset) => sameAddress(asset, pact.paymentTerms.token))) throw new Error("Pact asset is no longer authorized by the Path");
  if (path.permittedCounterparties?.length && !path.permittedCounterparties.some((entry) => sameAddress(entry, pact.counterparty))) {
    throw new Error("Pact counterparty is no longer authorized by the Path");
  }
  return signedPath;
}

function assertOpeningObservationMatchesPact(
  pact: PactV1,
  metadataHash: Hex,
  paycardId: Hex,
  openingTxHash: Hex,
  observation: OpenRailsOpeningObservationV1,
): void {
  if (observation.transactionHash.toLowerCase() !== openingTxHash.toLowerCase()) throw new Error("Opening observation transaction hash mismatch");
  if (observation.chainId !== pact.paymentTerms.chainId) throw new Error("Opening observation chain mismatch");
  if (!sameAddress(observation.vault, pact.paymentTerms.vault)) throw new Error("Opening observation vault mismatch");
  if (observation.paycardId !== paycardId || observation.metadataHash !== metadataHash) throw new Error("Opening observation payment binding mismatch");
  if (!sameAddress(observation.payer, pact.paymentTerms.payer)) throw new Error("Opening observation payer mismatch");
  if (!sameAddress(observation.recipient, pact.paymentTerms.recipient)) throw new Error("Opening observation recipient mismatch");
  if (!sameAddress(observation.residualRecipient, pact.paymentTerms.residualRecipient)) throw new Error("Opening observation residual recipient mismatch");
  if (observation.poolAllocationBaseUnits !== pact.paymentTerms.maximumAllocationBaseUnits) throw new Error("Opening observation allocation mismatch");
  if (observation.flowVelocityBaseUnitsPerSecond !== pact.paymentTerms.velocityBaseUnitsPerSecond) throw new Error("Opening observation velocity mismatch");
  if (observation.lifespanSeconds !== pact.paymentTerms.lifespanSeconds) throw new Error("Opening observation lifespan mismatch");
  if (observation.operationalStatus !== 0) throw new Error("Canonical Paycard is not active");
  if (parseBaseUnits(observation.availableBalanceBaseUnits, "opening available balance") === 0n) throw new Error("Canonical Paycard has no available balance");
}

function assertSettlementObservationMatchesPact(
  pact: PactV1,
  txHash: Hex,
  amount: string,
  observation: OpenRailsSettlementObservationV1,
): void {
  if (!pact.openRails) throw new Error("Pact has no prepared OpenRails payment");
  if (observation.transactionHash.toLowerCase() !== txHash.toLowerCase()) throw new Error("Settlement observation transaction hash mismatch");
  if (observation.chainId !== pact.paymentTerms.chainId) throw new Error("Settlement observation chain mismatch");
  if (!sameAddress(observation.vault, pact.paymentTerms.vault)) throw new Error("Settlement observation vault mismatch");
  if (observation.paycardId !== pact.openRails.paycardId) throw new Error("Settlement observation Paycard mismatch");
  if (!sameAddress(observation.recipient, pact.paymentTerms.recipient)) throw new Error("Settlement observation recipient mismatch");
  if (observation.settledAmountBaseUnits !== amount) throw new Error("Settlement observation amount mismatch");
}

async function authorizeWorkspaceCommand(input: {
  state: KernelStateV1;
  command: WorkspaceCommandV1;
  signature: Hex;
  operation: WorkspaceCommandV1["operation"];
  payload: unknown;
  verifier: AuthoritySignatureVerifier;
  now: () => Date;
}): Promise<WorkspaceV1> {
  const workspace = requireWorkspace(input.state, input.command.workspaceId);
  if (workspace.status !== "active") throw new Error("Workspace is not active");
  if (input.command.operation !== input.operation) throw new Error("Workspace command operation mismatch");
  if (input.command.payloadHash !== hashCanonical(input.payload)) throw new Error("Workspace command payload hash mismatch");
  if (input.command.workspaceRevision !== workspace.revision) throw new Error("Workspace command revision is stale");
  const expectedNonce = input.state.workspaceCommandNonces[workspace.workspaceId] ?? 0;
  if (!Number.isSafeInteger(input.command.nonce) || input.command.nonce !== expectedNonce) throw new Error(`Workspace command nonce mismatch: expected ${expectedNonce}`);
  const nowMs = input.now().getTime();
  const issuedAt = parseIso(input.command.issuedAt, "command issuedAt");
  const expiresAt = parseIso(input.command.expiresAt, "command expiresAt");
  if (issuedAt > nowMs + 30_000) throw new Error("Workspace command issuedAt is in the future");
  if (expiresAt <= nowMs) throw new Error("Workspace command expired");
  if (expiresAt - issuedAt > 15 * 60_000) throw new Error("Workspace command lifetime exceeds 15 minutes");
  const valid = await input.verifier.verify({ typedData: workspaceCommandTypedData(input.command), signature: input.signature, expectedSigner: workspace.authorityAccount });
  if (!valid) throw new Error("Workspace command signature is invalid");
  input.state.workspaceCommandNonces[workspace.workspaceId] = expectedNonce + 1;
  return workspace;
}

function event(state: KernelStateV1, input: Omit<KernelEventV1, "version" | "eventId">): void {
  state.events.push({
    version: "openrails-kernel-event-v1",
    eventId: stableId("event", { ...input, sequence: state.events.length }),
    ...input,
  });
}

function pactEvent(state: KernelStateV1, pact: PactV1, type: string, actor: string, data: Record<string, unknown>, at: string): PactEventV1 {
  const sequence = state.pactEvents.filter((entry) => entry.pactId === pact.pactId).length;
  const value: PactEventV1 = {
    version: "openrails-pact-event-v1",
    eventId: stableId("pactevt", { pactId: pact.pactId, sequence, type, at }),
    pactId: pact.pactId,
    workspaceId: pact.workspaceId,
    sequence,
    type,
    actor,
    at,
    data,
  };
  state.pactEvents.push(value);
  return value;
}

function assertWorkspaceId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{3,96}$/.test(value)) throw new Error("invalid Workspace ID");
}

function assertWorkspace(workspace: WorkspaceV1): void {
  if (workspace.version !== "openrails-workspace-v1") throw new Error("unsupported Workspace version");
  assertWorkspaceId(workspace.workspaceId);
  assertDomainId(workspace.principalId, "Principal ID");
  assertAddress(workspace.authorityAccount, "Workspace authority");
  if (workspace.authorityType !== "eoa") throw new Error("Agent Kernel V1 supports EOA Workspace authorities only");
  if (!Number.isSafeInteger(workspace.revision) || workspace.revision < 1) throw new Error("Workspace revision must be positive");
  if (!Array.isArray(workspace.members) || workspace.members.length === 0) throw new Error("Workspace requires at least one member");
  if (!workspace.members.some((member) => member.status === "active" && member.roles.includes("owner") && member.address.toLowerCase() === workspace.authorityAccount.toLowerCase())) throw new Error("Workspace authority must be an active owner member");
  for (const member of workspace.members) assertAddress(member.address, "Workspace member");
}

function assertAgent(agent: AgentIdentityV1): void {
  if (agent.version !== "openrails-agent-identity-v1") throw new Error("unsupported Agent version");
  assertDomainId(agent.agentId, "Agent ID");
  assertWorkspaceId(agent.workspaceId);
  assertAddress(agent.operator, "Agent operator");
  assertHex32(agent.runtimeCredentialHash, "Agent runtimeCredentialHash");
  if (!Number.isSafeInteger(agent.revision) || agent.revision < 1) throw new Error("Agent revision must be positive");
  if (!Array.isArray(agent.capabilities) || !Array.isArray(agent.permittedActionTypes) || !Array.isArray(agent.assignedPathIds)) throw new Error("Agent capability and assignment fields must be arrays");
  if (agent.expiresAt && parseIso(agent.expiresAt, "Agent expiresAt") <= parseIso(agent.createdAt, "Agent createdAt")) throw new Error("Agent expiry must be after creation");
}

function assertProposal(proposal: AgentProposalV1): void {
  if (proposal.version !== "openrails-agent-proposal-v1") throw new Error("unsupported Proposal version");
  assertDomainId(proposal.proposalId, "Proposal ID");
  assertWorkspaceId(proposal.workspaceId);
  assertDomainId(proposal.pathId, "Path ID");
  assertDomainId(proposal.agentId, "Agent ID");
  assertAddress(proposal.asset, "Proposal asset");
  if (proposal.counterparty) assertAddress(proposal.counterparty, "Proposal counterparty");
  parseBaseUnits(proposal.requestedAllocationBaseUnits, "requested allocation", false);
  parseBaseUnits(proposal.requestedVelocityBaseUnitsPerSecond, "requested velocity", false);
  if (!Number.isSafeInteger(proposal.requestedDurationSeconds) || proposal.requestedDurationSeconds <= 0) throw new Error("Proposal duration must be positive");
  parseIso(proposal.requestedAt, "Proposal requestedAt");
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(proposal.idempotencyKey)) throw new Error("invalid Proposal idempotency key");
}

function assertDomainId(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{3,128}$/.test(value)) throw new Error(`invalid ${label}`);
}

function assertPath(path: PathV1): void {
  assertDomainId(path.pathId, "Path ID");
  assertWorkspaceId(path.workspaceId);
  assertAddress(path.owner, "Path owner");
  assertAddress(path.authorityAccount, "Path authority");
  if (path.revision < 1 || !Number.isSafeInteger(path.revision)) throw new Error("Path revision must be positive");
  if (parseIso(path.validFrom, "Path validFrom") >= parseIso(path.expiresAt, "Path expiresAt")) throw new Error("Path validity window is invalid");
  parseBaseUnits(path.limits.maxPerPactBaseUnits, "maxPerPactBaseUnits", false);
  parseBaseUnits(path.limits.maxActiveExposureBaseUnits, "maxActiveExposureBaseUnits", false);
  parseBaseUnits(path.limits.maxPerPeriodBaseUnits, "maxPerPeriodBaseUnits", false);
  parseBaseUnits(path.limits.maxVelocityBaseUnitsPerSecond, "maxVelocityBaseUnitsPerSecond", false);
  if (!Number.isSafeInteger(path.limits.periodSeconds) || path.limits.periodSeconds <= 0) throw new Error("periodSeconds must be positive");
  if (!Number.isSafeInteger(path.limits.maxDurationSeconds) || path.limits.maxDurationSeconds <= 0) throw new Error("maxDurationSeconds must be positive");
  if (!Number.isSafeInteger(path.limits.maxConcurrentPacts) || path.limits.maxConcurrentPacts <= 0) throw new Error("maxConcurrentPacts must be positive");
  if (path.authorizedAgentIds.length === 0) throw new Error("Path requires at least one authorized Agent");
  if (path.permittedActions.length === 0) throw new Error("Path requires permitted actions");
  if (path.permittedAssets.length === 0) throw new Error("Path requires permitted assets");
}

function assertPact(pact: PactV1): void {
  assertDomainId(pact.pactId, "Pact ID");
  assertAddress(pact.initiator, "Pact initiator");
  assertAddress(pact.counterparty, "Pact counterparty");
  assertAddress(pact.paymentTerms.payer, "Pact payer");
  assertAddress(pact.paymentTerms.recipient, "Pact recipient");
  assertAddress(pact.paymentTerms.token, "Pact token");
  assertAddress(pact.paymentTerms.vault, "Pact vault");
  assertAddress(pact.paymentTerms.residualRecipient, "Pact residual recipient");
  parseBaseUnits(pact.paymentTerms.maximumAllocationBaseUnits, "Pact allocation", false);
  parseBaseUnits(pact.paymentTerms.velocityBaseUnitsPerSecond, "Pact velocity", false);
  if (!Number.isSafeInteger(pact.paymentTerms.lifespanSeconds) || pact.paymentTerms.lifespanSeconds <= 0) throw new Error("Pact lifespan must be positive");
  assertPactTermsIntegrity(pact);
}

export class OpenRailsAgentKernel {
  readonly actions: ActionRegistry;
  readonly plugins: VerificationPluginRegistry;
  private readonly now: () => Date;

  constructor(private readonly options: KernelOptions) {
    this.actions = options.actionRegistry ?? new ActionRegistry();
    this.plugins = options.pluginRegistry ?? new VerificationPluginRegistry();
    this.now = options.now ?? (() => new Date());
  }

  async state(): Promise<KernelStateV1> { return this.options.store.load(); }

  async prepareWorkspaceCommand(input: { workspaceId: string; operation: WorkspaceCommandV1["operation"]; payload: unknown; ttlSeconds?: number }): Promise<{ command: WorkspaceCommandV1; typedData: ReturnType<typeof workspaceCommandTypedData> }> {
    const state = await this.state();
    const workspace = requireWorkspace(state, input.workspaceId);
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) throw new Error("Workspace command ttlSeconds must be between 30 and 900");
    const issuedAt = nowIso(this.now);
    const commandCore = {
      workspaceId: workspace.workspaceId,
      operation: input.operation,
      payloadHash: hashCanonical(input.payload),
      workspaceRevision: workspace.revision,
      nonce: state.workspaceCommandNonces[workspace.workspaceId] ?? 0,
      issuedAt,
      expiresAt: new Date(this.now().getTime() + ttlSeconds * 1000).toISOString(),
    };
    const command: WorkspaceCommandV1 = {
      version: "openrails-workspace-command-v1",
      commandId: stableId("command", commandCore),
      ...commandCore,
    };
    return { command, typedData: workspaceCommandTypedData(command) };
  }

  prepareWorkspace(input: Omit<WorkspaceV1, "version" | "revision" | "createdAt" | "updatedAt" | "members" | "status"> & { members?: WorkspaceV1["members"] }) {
    assertWorkspaceId(input.workspaceId);
    assertAddress(input.authorityAccount, "Workspace authority");
    if (input.authorityType !== "eoa") throw new Error("Agent Kernel V1 supports EOA Workspace authorities only");
    const at = nowIso(this.now);
    const workspace: WorkspaceV1 = {
      version: "openrails-workspace-v1",
      ...input,
      members: input.members ?? [{ address: input.authorityAccount, roles: ["owner"], status: "active", addedAt: at }],
      status: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    const hash = hashCanonical(workspace);
    return { workspace, hash, typedData: workspaceTypedData(workspace) };
  }

  async registerWorkspace(input: { workspace: WorkspaceV1; signature: Hex }): Promise<SignedArtifactV1<WorkspaceV1>> {
    assertWorkspace(input.workspace);
    const typedData = workspaceTypedData(input.workspace);
    const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.workspace.authorityAccount });
    if (!valid) throw new Error("Workspace authority signature is invalid");
    return this.options.store.transact((state) => {
      if (state.workspaces[input.workspace.workspaceId]) throw new Error("Workspace already exists");
      state.workspaces[input.workspace.workspaceId] = clone(input.workspace);
      const artifact: SignedArtifactV1<WorkspaceV1> = {
        artifact: clone(input.workspace),
        hash: hashCanonical(input.workspace),
        typedData,
        signer: input.workspace.authorityAccount,
        signature: input.signature,
        signedAt: nowIso(this.now),
      };
      state.workspaceArtifacts[input.workspace.workspaceId] = artifact;
      event(state, { workspaceId: input.workspace.workspaceId, subjectType: "workspace", subjectId: input.workspace.workspaceId, type: "WORKSPACE_REGISTERED", actor: input.workspace.authorityAccount, at: artifact.signedAt, data: { hash: artifact.hash } });
      return artifact;
    });
  }

  prepareAgentRegistration(input: Omit<AgentIdentityV1, "version" | "status" | "createdAt" | "revision" | "assignedPathIds"> & { assignedPathIds?: string[] }): { agent: AgentIdentityV1; hash: Hex; typedData: ReturnType<typeof agentRegistrationTypedData> } {
    assertDomainId(input.agentId, "Agent ID");
    assertAddress(input.operator, "Agent operator");
    const agent: AgentIdentityV1 = {
      version: "openrails-agent-identity-v1",
      ...input,
      assignedPathIds: input.assignedPathIds ?? [],
      status: "active",
      createdAt: nowIso(this.now),
      revision: 1,
    };
    return { agent, hash: hashCanonical(agent), typedData: agentRegistrationTypedData(agent) };
  }

  async registerAgent(input: { agent: AgentIdentityV1; authoritySigner: Address; signature: Hex }): Promise<AgentIdentityV1> {
    assertAgent(input.agent);
    return this.options.store.transact(async (state) => {
      const workspace = requireWorkspace(state, input.agent.workspaceId);
      assertAuthority(workspace, input.authoritySigner);
      if (state.agents[input.agent.agentId]) throw new Error("Agent already exists");
      const typedData = agentRegistrationTypedData(input.agent);
      const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.authoritySigner });
      if (!valid) throw new Error("Agent registration signature is invalid");
      state.agents[input.agent.agentId] = clone(input.agent);
      const signedAt = nowIso(this.now);
      state.agentArtifacts[input.agent.agentId] = {
        artifact: clone(input.agent),
        hash: hashCanonical(input.agent),
        typedData,
        signer: input.authoritySigner,
        signature: input.signature,
        signedAt,
      };
      event(state, { workspaceId: workspace.workspaceId, subjectType: "agent", subjectId: input.agent.agentId, type: "AGENT_REGISTERED", actor: input.authoritySigner, at: signedAt, data: { agentHash: hashCanonical(input.agent) } });
      return input.agent;
    });
  }

  async setAgentStatus(input: {
    workspaceId: string;
    agentId: string;
    status: AgentIdentityV1["status"];
    command: WorkspaceCommandV1;
    signature: Hex;
  }): Promise<AgentIdentityV1> {
    return this.options.store.transact(async (state) => {
      const payload = { workspaceId: input.workspaceId, agentId: input.agentId, status: input.status };
      const workspace = await authorizeWorkspaceCommand({
        state, command: input.command, signature: input.signature, operation: "set_agent_status", payload, verifier: this.options.signatureVerifier, now: this.now,
      });
      if (workspace.workspaceId !== input.workspaceId) throw new Error("Workspace command target mismatch");
      const agent = requireAgent(state, input.agentId);
      if (agent.workspaceId !== workspace.workspaceId) throw new Error("Agent Workspace mismatch");
      agent.status = input.status;
      agent.revision += 1;
      event(state, { workspaceId: workspace.workspaceId, subjectType: "agent", subjectId: agent.agentId, type: `AGENT_${input.status.toUpperCase()}`, actor: workspace.authorityAccount, at: nowIso(this.now), data: { revision: agent.revision, commandId: input.command.commandId } });
      return agent;
    });
  }

  preparePath(path: PathV1): { path: PathV1; hash: Hex; typedData: ReturnType<typeof pathTypedData> } {
    assertPath(path);
    return { path: clone(path), hash: hashCanonical(path), typedData: pathTypedData(path) };
  }

  async activatePath(input: { path: PathV1; signature: Hex }): Promise<SignedArtifactV1<PathV1>> {
    assertPath(input.path);
    const typedData = pathTypedData(input.path);
    const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.path.authorityAccount });
    if (!valid) throw new Error("Path authority signature is invalid");
    return this.options.store.transact((state) => {
      const workspace = requireWorkspace(state, input.path.workspaceId);
      assertAuthority(workspace, input.path.authorityAccount);
      const ownerMember = workspace.members.find((member) =>
        member.address.toLowerCase() === input.path.owner.toLowerCase() &&
        member.status === "active" &&
        member.roles.includes("owner"),
      );
      if (!ownerMember) throw new Error("Path owner must be an active Workspace owner");
      for (const agentId of input.path.authorizedAgentIds) {
        const agent = requireAgent(state, agentId);
        if (agent.workspaceId !== workspace.workspaceId || agent.status !== "active") throw new Error(`Agent ${agentId} is not active in this Workspace`);
      }
      const existing = state.paths[input.path.pathId];
      if (existing) {
        assertRevision(input.path.revision, existing.artifact.revision + 1, "Path");
        if (input.path.previousPathHash !== existing.hash) throw new Error("Path previous hash mismatch");
        if (input.path.workspaceId !== existing.artifact.workspaceId) throw new Error("Path Workspace cannot change across revisions");
        if (!sameAddress(input.path.owner, existing.artifact.owner)) throw new Error("Path owner cannot change across revisions");
        if (!sameAddress(input.path.authorityAccount, existing.artifact.authorityAccount)) throw new Error("Path authority cannot change across revisions");
      } else if (input.path.revision !== 1) throw new Error("New Path revision must be 1");
      const signed: SignedArtifactV1<PathV1> = {
        artifact: clone(input.path),
        hash: hashCanonical(input.path),
        typedData,
        signer: input.path.authorityAccount,
        signature: input.signature,
        signedAt: nowIso(this.now),
      };
      state.paths[input.path.pathId] = signed;
      for (const agentId of input.path.authorizedAgentIds) {
        const agent = state.agents[agentId]!;
        if (!agent.assignedPathIds.includes(input.path.pathId)) agent.assignedPathIds.push(input.path.pathId);
      }
      event(state, { workspaceId: workspace.workspaceId, subjectType: "path", subjectId: input.path.pathId, type: existing ? "PATH_REVISED" : "PATH_ACTIVATED", actor: input.path.authorityAccount, at: signed.signedAt, data: { revision: input.path.revision, pathHash: signed.hash } });
      return signed;
    });
  }

  async submitProposal(proposal: AgentProposalV1): Promise<{ proposal: AgentProposalV1; job: RuntimeJobV1 }> {
    assertProposal(proposal);
    const fingerprint = hashCanonical(proposal);
    return this.options.store.transact((state) => {
      const idempotencyKey = `${proposal.workspaceId}:proposal:${proposal.idempotencyKey}`;
      const previous = state.idempotency[idempotencyKey];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("idempotency conflict");
        const previousProposal = state.proposals[proposal.proposalId];
        const previousJob = Object.values(state.jobs).find((entry) => entry.proposalId === proposal.proposalId);
        if (!previousProposal || !previousJob) throw new Error("idempotency record is inconsistent");
        return { proposal: previousProposal, job: previousJob };
      }
      const existingProposal = state.proposals[proposal.proposalId];
      if (existingProposal && hashCanonical(existingProposal) !== fingerprint) throw new Error("Proposal ID already exists with different payload");
      if (existingProposal) throw new Error("Proposal ID already exists");
      state.proposals[proposal.proposalId] = clone(proposal);
      const at = nowIso(this.now);
      const job: RuntimeJobV1 = {
        version: "openrails-runtime-job-v1",
        jobId: stableId("job", { proposalId: proposal.proposalId, kind: "evaluate_proposal" }),
        workspaceId: proposal.workspaceId,
        proposalId: proposal.proposalId,
        kind: "evaluate_proposal",
        state: "queued",
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      };
      state.jobs[job.jobId] = job;
      state.idempotency[idempotencyKey] = { fingerprint, result: { proposalId: proposal.proposalId, jobId: job.jobId } };
      event(state, { workspaceId: proposal.workspaceId, subjectType: "proposal", subjectId: proposal.proposalId, type: "PROPOSAL_SUBMITTED", actor: proposal.agentId, at, data: { actionType: proposal.actionType, jobId: job.jobId } });
      return { proposal, job };
    });
  }

  async runNextJob(workerId = "openrails-kernel-worker"): Promise<RuntimeJobV1 | undefined> {
    const state = await this.options.store.load();
    const candidate = Object.values(state.jobs).find((job) => job.state === "queued");
    if (!candidate) return undefined;
    return this.options.store.transact(async (draft) => {
      const job = draft.jobs[candidate.jobId];
      if (!job || job.state !== "queued") return job;
      job.state = "running";
      job.attempts += 1;
      job.lockedBy = workerId;
      job.lockUntil = new Date(this.now().getTime() + 60_000).toISOString();
      job.updatedAt = nowIso(this.now);
      try {
        if (job.kind !== "evaluate_proposal") throw new Error(`unsupported job kind ${job.kind}`);
        const proposal = draft.proposals[job.proposalId];
        if (!proposal) throw new Error("proposal is missing");
        const evaluatorOptions = {
          actionRegistry: this.actions,
          now: this.now,
          ...(this.options.identityResolver ? { identityResolver: this.options.identityResolver } : {}),
        };
        const { decision, identity } = await evaluateProposal(draft, proposal, evaluatorOptions);
        draft.decisions[decision.decisionId] = decision;
        if (decision.result === "BLOCK") {
          const blocked: BlockedActionV1 = {
            version: "openrails-blocked-action-v1",
            blockedActionId: stableId("blocked", decision),
            workspaceId: proposal.workspaceId,
            pathId: proposal.pathId,
            agentId: proposal.agentId,
            proposalId: proposal.proposalId,
            actionType: proposal.actionType,
            requestedAllocationBaseUnits: proposal.requestedAllocationBaseUnits,
            reasonCodes: decision.reasonCodes,
            decisionHash: decision.decisionHash,
            at: decision.evaluatedAt,
          };
          draft.blockedActions.push(blocked);
          job.state = "blocked";
          job.result = { decisionId: decision.decisionId, blockedActionId: blocked.blockedActionId };
        } else if (decision.result === "REVIEW") {
          job.state = "review";
          job.result = { decisionId: decision.decisionId };
        } else {
          job.state = "completed";
          job.result = { decisionId: decision.decisionId, ...(identity ? { identity } : {}) };
        }
        job.updatedAt = nowIso(this.now);
        event(draft, { workspaceId: proposal.workspaceId, subjectType: "proposal", subjectId: proposal.proposalId, type: `BAPHOMET_${decision.result}`, actor: "baphomet", at: decision.evaluatedAt, data: { decisionId: decision.decisionId, reasonCodes: decision.reasonCodes } });
      } catch (error) {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = nowIso(this.now);
      }
      return job;
    });
  }

  async createPactFromProposal(input: {
    proposalId: string;
    pactId: string;
    commercialTerms: Record<string, unknown>;
    completionPolicyId: string;
    disputePolicyId: string;
    requiresCounterpartySignature?: boolean;
  }): Promise<PactV1> {
    return this.options.store.transact(async (state) => {
      const proposal = state.proposals[input.proposalId];
      if (!proposal) throw new Error("Proposal not found");
      if (!proposal.counterparty) throw new Error("Payable Pact requires the approved proposal counterparty");
      if (state.pacts[input.pactId]) throw new Error("Pact already exists");

      const workspace = requireWorkspace(state, proposal.workspaceId);
      if (workspace.status !== "active") throw new Error("Workspace is not active");
      const agent = requireAgent(state, proposal.agentId);
      if (agent.workspaceId !== workspace.workspaceId || agent.status !== "active") throw new Error("Agent is not active in the Workspace");

      const evaluatorOptions = {
        actionRegistry: this.actions,
        now: this.now,
        ...(this.options.identityResolver ? { identityResolver: this.options.identityResolver } : {}),
      };
      const { decision } = await evaluateProposal(state, proposal, evaluatorOptions);
      state.decisions[decision.decisionId] = decision;
      if (decision.result !== "ALLOW") throw new Error(`Proposal is not currently allowed by Baphomet: ${decision.reasonCodes.join(", ")}`);

      const signedPath = requirePath(state, proposal.pathId);
      if (decision.pathHash !== signedPath.hash) throw new Error("Baphomet decision is stale for the active Path revision");
      const proposalHash = hashCanonical(proposal);
      if (decision.proposalHash !== proposalHash) throw new Error("Baphomet decision proposal hash mismatch");

      const approvedPlugin = signedPath.artifact.approvedVerificationPlugins.find((entry) => entry.pluginId === proposal.evidencePolicyId);
      if (!approvedPlugin) throw new Error("Proposal evidence policy is not approved by the active Path");
      const pluginKey = this.plugins.key(approvedPlugin.pluginId, approvedPlugin.version);
      const pluginManifest = state.plugins[pluginKey];
      if (!pluginManifest || pluginManifest.status !== "active") throw new Error("Pact evidence plugin is not active");
      if (!pluginManifest.installedWorkspaceIds.includes(workspace.workspaceId)) throw new Error("Pact evidence plugin is not installed in the Workspace");
      const pluginImplementation = this.plugins.get(approvedPlugin.pluginId, approvedPlugin.version);
      if (!pluginImplementation || pluginImplementation.manifest.codeDigest !== pluginManifest.codeDigest) {
        throw new Error("Pact evidence plugin implementation does not match its installed manifest");
      }

      const at = nowIso(this.now);
      const pact: PactV1 = {
        version: "openrails-pact-v1",
        pactId: input.pactId,
        workspaceId: proposal.workspaceId,
        pathId: proposal.pathId,
        pathRevision: signedPath.artifact.revision,
        pathHash: signedPath.hash,
        proposalId: proposal.proposalId,
        proposalHash,
        decisionId: decision.decisionId,
        decisionHash: decision.decisionHash,
        termsHash: ("0x" + "00".repeat(32)) as Hex,
        initiator: workspace.authorityAccount,
        agentId: proposal.agentId,
        counterparty: proposal.counterparty,
        actionType: proposal.actionType,
        specification: clone(proposal.specification),
        commercialTerms: clone(input.commercialTerms),
        paymentTerms: {
          chainId: GIWA_SEPOLIA.chainId,
          vault: GIWA_SEPOLIA.vaultAddress,
          token: proposal.asset,
          payer: workspace.authorityAccount,
          recipient: proposal.counterparty,
          maximumAllocationBaseUnits: proposal.requestedAllocationBaseUnits,
          velocityBaseUnitsPerSecond: proposal.requestedVelocityBaseUnitsPerSecond,
          lifespanSeconds: proposal.requestedDurationSeconds,
          residualRecipient: workspace.authorityAccount,
        },
        evidencePolicyId: approvedPlugin.pluginId,
        evidencePolicyVersion: approvedPlugin.version,
        evidencePolicyCodeDigest: pluginManifest.codeDigest,
        completionPolicyId: input.completionPolicyId,
        disputePolicyId: input.disputePolicyId,
        requiresCounterpartySignature: input.requiresCounterpartySignature ?? true,
        status: "awaiting_signatures",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      pact.termsHash = pactTermsHash(pact);
      assertPact(pact);
      state.pacts[pact.pactId] = pact;
      state.pactSignatures[pact.pactId] = [];
      pactEvent(state, pact, "PACT_CREATED", proposal.agentId, {
        proposalId: proposal.proposalId,
        proposalHash,
        decisionId: decision.decisionId,
        decisionHash: decision.decisionHash,
        termsHash: pact.termsHash,
      }, at);
      return pact;
    });
  }

  preparePactSignature(pact: PactV1) {
    assertPact(pact);
    return { pact: clone(pact), hash: pact.termsHash, typedData: pactTypedData(pact) };
  }

  async signPact(input: { pactId: string; signer: Address; signature: Hex }): Promise<SignedArtifactV1<PactV1>> {
    return this.options.store.transact(async (state) => {
      const pact = requirePact(state, input.pactId);
      const workspace = requireWorkspace(state, pact.workspaceId);
      const allowed = input.signer.toLowerCase() === workspace.authorityAccount.toLowerCase() || input.signer.toLowerCase() === pact.counterparty.toLowerCase();
      if (!allowed) throw new Error("Pact signer is neither Workspace authority nor counterparty");
      const signatures = state.pactSignatures[pact.pactId] ?? [];
      const existing = signatures.find((entry) => entry.signer.toLowerCase() === input.signer.toLowerCase());
      if (existing) {
        if (existing.hash !== pact.termsHash || existing.signature !== input.signature) throw new Error("Pact signer already recorded a different signature");
        return existing;
      }
      if (pact.status !== "awaiting_signatures") throw new Error("Pact is no longer accepting signatures");
      const typedData = pactTypedData(pact);
      const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.signer });
      if (!valid) throw new Error("Pact signature is invalid");
      const signed: SignedArtifactV1<PactV1> = { artifact: clone(pact), hash: pact.termsHash, typedData, signer: input.signer, signature: input.signature, signedAt: nowIso(this.now) };
      signatures.push(signed);
      state.pactSignatures[pact.pactId] = signatures;
      const authoritySigned = signatures.some((entry) => entry.signer.toLowerCase() === workspace.authorityAccount.toLowerCase());
      const counterpartySigned = signatures.some((entry) => entry.signer.toLowerCase() === pact.counterparty.toLowerCase());
      if (authoritySigned && (!pact.requiresCounterpartySignature || counterpartySigned)) {
        pact.status = "accepted";
        pact.revision += 1;
        pact.updatedAt = nowIso(this.now);
        pactEvent(state, pact, "PACT_ACCEPTED", input.signer, { termsHash: signed.hash, signers: signatures.map((entry) => entry.signer) }, pact.updatedAt);
      } else {
        pactEvent(state, pact, "PACT_SIGNATURE_ADDED", input.signer, { termsHash: signed.hash }, signed.signedAt);
      }
      return signed;
    });
  }

  async bindOpenRailsPayment(input: {
    pactId: string;
    metadataHash: Hex;
    paycardId: Hex;
    actor: Address;
    genesisTimestamp?: number;
    nonceChannel?: number;
    nonceValue?: number;
    openingTxHash?: Hex;
  }): Promise<PactV1> {
    assertHex32(input.metadataHash, "metadataHash");
    assertHex32(input.paycardId, "paycardId");
    if (input.openingTxHash) assertHex32(input.openingTxHash, "openingTxHash");

    if (!input.openingTxHash) {
      if (!Number.isSafeInteger(input.genesisTimestamp) || (input.genesisTimestamp ?? -1) < 0) throw new Error("genesisTimestamp is required for payment preparation");
      if (!Number.isSafeInteger(input.nonceChannel) || (input.nonceChannel ?? -1) < 0) throw new Error("nonceChannel is required for payment preparation");
      if (!Number.isSafeInteger(input.nonceValue) || (input.nonceValue ?? -1) < 0) throw new Error("nonceValue is required for payment preparation");
      return this.options.store.transact((state) => {
        const pact = requirePact(state, input.pactId);
        assertPactExecutionEligible(state, pact, this.now().getTime());
        if (!["accepted", "payment_prepared", "awaiting_wallet"].includes(pact.status)) throw new Error("Pact is not ready for OpenRails preparation");
        pact.openRails = {
          metadataHash: input.metadataHash,
          paycardId: input.paycardId,
          genesisTimestamp: input.genesisTimestamp!,
          nonceChannel: input.nonceChannel!,
          nonceValue: input.nonceValue!,
          preparedAt: nowIso(this.now),
          settlements: [],
        };
        pact.status = "payment_prepared";
        pact.revision += 1;
        pact.updatedAt = pact.openRails.preparedAt;
        pactEvent(state, pact, "PAYMENT_PREPARED", input.actor, {
          termsHash: pact.termsHash,
          metadataHash: input.metadataHash,
          paycardId: input.paycardId,
          genesisTimestamp: input.genesisTimestamp,
          nonceChannel: input.nonceChannel,
          nonceValue: input.nonceValue,
          allocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
        }, pact.updatedAt);
        return pact;
      });
    }

    if (!this.options.chainVerifier) throw new Error("Canonical OpenRails chain verifier is required to activate a Pact");
    const beforeState = await this.state();
    const before = requirePact(beforeState, input.pactId);
    assertPactExecutionEligible(beforeState, before, this.now().getTime());
    if (!before.openRails) throw new Error("Payment must be prepared before canonical opening verification");
    if (before.openRails.metadataHash !== input.metadataHash || before.openRails.paycardId !== input.paycardId) throw new Error("Opening transaction does not match the prepared Pact payment");
    const observation = await this.options.chainVerifier.verifyOpening({
      pact: clone(before),
      metadataHash: input.metadataHash,
      paycardId: input.paycardId,
      openingTxHash: input.openingTxHash,
    });
    assertOpeningObservationMatchesPact(before, input.metadataHash, input.paycardId, input.openingTxHash, observation);

    return this.options.store.transact((state) => {
      const pact = requirePact(state, input.pactId);
      assertPactExecutionEligible(state, pact, this.now().getTime());
      if (!pact.openRails) throw new Error("Payment preparation disappeared before opening verification");
      if (!['payment_prepared', 'awaiting_wallet'].includes(pact.status)) throw new Error("Pact is not awaiting canonical OpenRails opening");
      if (pact.openRails.metadataHash !== input.metadataHash || pact.openRails.paycardId !== input.paycardId) throw new Error("Prepared payment changed during opening verification");
      assertOpeningObservationMatchesPact(pact, input.metadataHash, input.paycardId, input.openingTxHash!, observation);
      pact.openRails.openingTxHash = input.openingTxHash!;
      pact.openRails.openingObservation = observation;
      pact.status = "active";
      pact.revision += 1;
      pact.updatedAt = nowIso(this.now);
      pactEvent(state, pact, "PAYMENT_OPENED_CANONICAL", input.actor, {
        termsHash: pact.termsHash,
        metadataHash: input.metadataHash,
        paycardId: input.paycardId,
        openingTxHash: input.openingTxHash,
        blockNumber: observation.blockNumber,
        allocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
      }, pact.updatedAt);
      return pact;
    });
  }

  async installPlugin(input: { manifest: VerificationPluginManifestV1; command: WorkspaceCommandV1; signature: Hex }): Promise<VerificationPluginManifestV1> {
    const manifest = input.manifest;
    if (manifest.version !== "openrails-verification-plugin-v1") throw new Error("unsupported verification plugin manifest version");
    assertDomainId(manifest.pluginId, "plugin ID");
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.pluginVersion)) throw new Error("pluginVersion must be semver-like");
    assertAddress(manifest.publisher, "plugin publisher");
    assertHex32(manifest.codeDigest, "plugin codeDigest");
    if (manifest.installedWorkspaceIds.length !== 1) throw new Error("V1 plugin installation must target exactly one Workspace");
    const publisherValid = await this.options.signatureVerifier.verify({
      typedData: verificationPluginTypedData(manifest),
      signature: manifest.publisherSignature,
      expectedSigner: manifest.publisher,
    });
    if (!publisherValid) throw new Error("plugin publisher signature is invalid");
    return this.options.store.transact(async (state) => {
      const workspaceId = manifest.installedWorkspaceIds[0]!;
      const payload = { workspaceId, pluginId: manifest.pluginId, pluginVersion: manifest.pluginVersion, codeDigest: manifest.codeDigest };
      const workspace = await authorizeWorkspaceCommand({
        state, command: input.command, signature: input.signature, operation: "install_plugin", payload, verifier: this.options.signatureVerifier, now: this.now,
      });
      if (workspace.workspaceId !== workspaceId) throw new Error("Workspace command target mismatch");
      const key = this.plugins.key(manifest.pluginId, manifest.pluginVersion);
      const existing = state.plugins[key];
      if (existing && existing.codeDigest !== manifest.codeDigest) throw new Error("plugin version digest conflict");
      state.plugins[key] = clone(manifest);
      event(state, { workspaceId: workspace.workspaceId, subjectType: "plugin", subjectId: key, type: "PLUGIN_INSTALLED", actor: workspace.authorityAccount, at: nowIso(this.now), data: { codeDigest: manifest.codeDigest, publisher: manifest.publisher, commandId: input.command.commandId } });
      return manifest;
    });
  }

  async submitCheckpoint(checkpoint: ExecutionCheckpointV1): Promise<ExecutionCheckpointV1> {
    assertHex32(checkpoint.evidenceHash, "checkpoint evidenceHash");
    assertHex32(checkpoint.termsHash, "checkpoint termsHash");
    if (checkpoint.paycardId) assertHex32(checkpoint.paycardId, "checkpoint paycardId");
    if (parseIso(checkpoint.validUntil, "checkpoint validUntil") <= this.now().getTime()) throw new Error("checkpoint signature expired");
    return this.options.store.transact(async (state) => {
      const pact = requirePact(state, checkpoint.pactId);
      assertPact(pact);
      const workspace = requireWorkspace(state, pact.workspaceId);
      const agent = requireAgent(state, pact.agentId);
      if (pact.workspaceId !== checkpoint.workspaceId || pact.pathId !== checkpoint.pathId) throw new Error("checkpoint Pact binding mismatch");
      if (checkpoint.termsHash !== pact.termsHash) throw new Error("checkpoint Pact terms hash mismatch");
      if (checkpoint.counterparty.toLowerCase() !== pact.counterparty.toLowerCase()) throw new Error("checkpoint counterparty mismatch");
      if (pact.openRails?.paycardId && checkpoint.paycardId !== pact.openRails.paycardId) throw new Error("checkpoint Paycard binding mismatch");
      if (!["active", "performing", "disputed"].includes(pact.status)) throw new Error("Pact is not accepting checkpoints");
      if (state.checkpoints[checkpoint.checkpointId]) throw new Error("checkpoint already exists");
      const expectedIndex = Object.values(state.checkpoints).filter((entry) => entry.pactId === pact.pactId).length + 1;
      if (!Number.isSafeInteger(checkpoint.checkpointIndex) || checkpoint.checkpointIndex !== expectedIndex) throw new Error(`checkpoint index mismatch: expected ${expectedIndex}`);
      const allowedSigners = [workspace.authorityAccount, pact.counterparty, agent.operator].map((entry) => entry.toLowerCase());
      if (!allowedSigners.includes(checkpoint.submittedBy.toLowerCase())) throw new Error("checkpoint submitter is not a Pact participant or Agent operator");
      if (checkpoint.actor.toLowerCase() !== checkpoint.submittedBy.toLowerCase()) throw new Error("checkpoint actor must match the signing submitter in V1");
      const signatureValid = await this.options.signatureVerifier.verify({ typedData: checkpointTypedData(checkpoint), signature: checkpoint.signature, expectedSigner: checkpoint.submittedBy });
      if (!signatureValid) throw new Error("checkpoint signature is invalid");
      state.checkpoints[checkpoint.checkpointId] = clone(checkpoint);
      if (pact.status === "active") pact.status = "performing";
      pact.revision += 1;
      pact.updatedAt = nowIso(this.now);
      pactEvent(state, pact, "CHECKPOINT_SUBMITTED", checkpoint.submittedBy, { checkpointId: checkpoint.checkpointId, checkpointType: checkpoint.checkpointType, evidenceHash: checkpoint.evidenceHash, termsHash: checkpoint.termsHash }, checkpoint.observedAt);
      return checkpoint;
    });
  }

  async verifyCheckpoint(input: { checkpointId: string; pluginId: string; pluginVersion: string }): Promise<VerificationDecisionV1> {
    return this.options.store.transact(async (state) => {
      const checkpoint = state.checkpoints[input.checkpointId];
      if (!checkpoint) throw new Error("checkpoint not found");
      const pact = requirePact(state, checkpoint.pactId);
      if (input.pluginId !== pact.evidencePolicyId || input.pluginVersion !== pact.evidencePolicyVersion) {
        throw new Error("verification plugin does not match the immutable Pact evidence policy");
      }
      const key = this.plugins.key(input.pluginId, input.pluginVersion);
      const manifest = state.plugins[key];
      if (!manifest || manifest.status !== "active") throw new Error("Pact verification plugin is not active");
      if (manifest.codeDigest !== pact.evidencePolicyCodeDigest) throw new Error("Pact verification plugin digest changed");
      const implementation = this.plugins.get(input.pluginId, input.pluginVersion);
      if (!implementation || implementation.manifest.codeDigest !== pact.evidencePolicyCodeDigest) throw new Error("Pact verification implementation digest mismatch");
      const decision = await this.plugins.evaluate({ state, checkpoint, pluginId: input.pluginId, pluginVersion: input.pluginVersion, now: this.now });
      state.verificationDecisions[decision.decisionId] = decision;
      pactEvent(state, pact, `CHECKPOINT_${decision.decision.toUpperCase()}`, `plugin:${input.pluginId}`, { checkpointId: checkpoint.checkpointId, decisionId: decision.decisionId, reasonCodes: decision.reasonCodes }, decision.evaluatedAt);
      if (decision.decision === "rejected") {
        pact.status = "disputed";
        pact.revision += 1;
        pact.updatedAt = decision.evaluatedAt;
      } else if (decision.decision === "approved" && checkpoint.checkpointType === "completed") {
        pact.status = "completed";
        pact.revision += 1;
        pact.updatedAt = decision.evaluatedAt;
      }
      return decision;
    });
  }

  async openGaiaCase(input: Omit<GaiaCaseV1, "version" | "status" | "createdAt" | "updatedAt" | "claimHash">): Promise<GaiaCaseV1> {
    assertDomainId(input.caseId, "Gaia case ID");
    assertWorkspaceId(input.workspaceId);
    assertDomainId(input.pactId, "Pact ID");
    assertDomainId(input.pathId, "Path ID");
    assertAddress(input.claimant, "Gaia claimant");
    assertAddress(input.respondent, "Gaia respondent");
    for (const commitment of input.evidenceCommitments) assertHex32(commitment, "Gaia evidence commitment");
    if (parseIso(input.claimValidUntil, "Gaia claimValidUntil") <= this.now().getTime()) throw new Error("Gaia claim signature expired");
    return this.options.store.transact(async (state) => {
      const pact = requirePact(state, input.pactId);
      assertPact(pact);
      const workspace = requireWorkspace(state, pact.workspaceId);
      if (pact.workspaceId !== input.workspaceId || pact.pathId !== input.pathId) throw new Error("Gaia Pact binding mismatch");
      if (pact.openRails?.paycardId && input.paycardId !== pact.openRails.paycardId) throw new Error("Gaia Paycard binding mismatch");
      const authority = workspace.authorityAccount.toLowerCase();
      const counterparty = pact.counterparty.toLowerCase();
      const claimant = input.claimant.toLowerCase();
      if (claimant !== authority && claimant !== counterparty) throw new Error("Gaia claimant is not a Pact party");
      const expectedRespondent = claimant === authority ? counterparty : authority;
      if (input.respondent.toLowerCase() !== expectedRespondent) throw new Error("Gaia respondent is not the opposing Pact party");
      if (state.gaiaCases[input.caseId]) throw new Error("Gaia case already exists");
      const at = nowIso(this.now);
      const value: GaiaCaseV1 = {
        version: "openrails-gaia-case-v1",
        ...input,
        claimHash: ("0x" + "00".repeat(32)) as Hex,
        status: "open",
        createdAt: at,
        updatedAt: at,
      };
      value.claimHash = gaiaCaseClaimHash(value);
      const signatureValid = await this.options.signatureVerifier.verify({ typedData: gaiaCaseClaimTypedData(value), signature: value.claimSignature, expectedSigner: value.claimant });
      if (!signatureValid) throw new Error("Gaia claim signature is invalid");
      state.gaiaCases[value.caseId] = value;
      pact.status = "disputed";
      pact.revision += 1;
      pact.updatedAt = at;
      pactEvent(state, pact, "GAIA_CASE_OPENED", input.claimant, { caseId: value.caseId, claimHash: value.claimHash, reasonCode: value.reasonCode, requestedRemedy: value.requestedRemedy }, at);
      return value;
    });
  }

  async resolveGaiaCase(input: {
    caseId: string;
    resolver: Address;
    decision: NonNullable<GaiaCaseV1["decision"]>;
    resolutionSummary: string;
    rectificationTerms?: Record<string, unknown>;
    command: WorkspaceCommandV1;
    signature: Hex;
  }): Promise<{ gaiaCase: GaiaCaseV1; obligation?: RectificationObligationV1 }> {
    return this.options.store.transact(async (state) => {
      const gaia = state.gaiaCases[input.caseId];
      if (!gaia) throw new Error("Gaia case not found");
      const payload = {
        caseId: input.caseId,
        resolver: input.resolver,
        decision: input.decision,
        resolutionSummary: input.resolutionSummary,
        rectificationTerms: input.rectificationTerms ?? {},
      };
      const workspace = await authorizeWorkspaceCommand({
        state, command: input.command, signature: input.signature, operation: "resolve_gaia", payload, verifier: this.options.signatureVerifier, now: this.now,
      });
      if (workspace.workspaceId !== gaia.workspaceId) throw new Error("Workspace command target mismatch");
      const resolverMember = workspace.members.find((member) => member.address.toLowerCase() === input.resolver.toLowerCase() && member.status === "active" && member.roles.some((role) => role === "owner" || role === "gaia_resolver"));
      if (!resolverMember) throw new Error("resolver lacks Gaia authority");
      const pact = requirePact(state, gaia.pactId);
      gaia.decision = input.decision;
      gaia.resolutionSummary = input.resolutionSummary;
      gaia.updatedAt = nowIso(this.now);
      let obligation: RectificationObligationV1 | undefined;
      if (["replacement_pact", "compensating_pact", "close_and_return_residual"].includes(input.decision)) {
        gaia.status = "rectification_required";
        pact.status = "rectification_required";
        const remedyType: RectificationObligationV1["remedyType"] =
          input.decision === "replacement_pact"
            ? "replacement_pact"
            : input.decision === "compensating_pact"
              ? "compensating_pact"
              : "manual_action";
        const nextObligation: RectificationObligationV1 = {
          version: "openrails-rectification-obligation-v1",
          obligationId: stableId("rectify", { caseId: gaia.caseId, decision: input.decision }),
          caseId: gaia.caseId,
          pactId: gaia.pactId,
          workspaceId: gaia.workspaceId,
          obligor: gaia.respondent,
          beneficiary: gaia.claimant,
          remedyType,
          terms: clone(input.decision === "close_and_return_residual"
            ? { action: "close_and_return_residual", paycardId: pact.openRails?.paycardId, ...(input.rectificationTerms ?? {}) }
            : (input.rectificationTerms ?? {})),
          status: "open",
          createdAt: gaia.updatedAt,
        };
        obligation = nextObligation;
        state.rectifications[nextObligation.obligationId] = nextObligation;
      } else {
        gaia.status = input.decision === "dismiss" ? "dismissed" : "resolved";
      }
      pact.revision += 1;
      pact.updatedAt = gaia.updatedAt;
      pactEvent(state, pact, "GAIA_RESOLVED", input.resolver, { caseId: gaia.caseId, decision: input.decision, commandId: input.command.commandId, ...(obligation ? { obligationId: obligation.obligationId } : {}) }, gaia.updatedAt);
      return obligation ? { gaiaCase: gaia, obligation } : { gaiaCase: gaia };
    });
  }

  async openRailsMetadataBinding(pactId: string): Promise<{
    workflowId: string;
    metadataRef: string;
    descriptionHash: Hex;
    salt: string;
    pathHash: Hex;
    pactHash: Hex;
  }> {
    const state = await this.state();
    const pact = requirePact(state, pactId);
    assertPactExecutionEligible(state, pact, this.now().getTime());
    const evidencePolicyHash = hashCanonical({
      evidencePolicyId: pact.evidencePolicyId,
      evidencePolicyVersion: pact.evidencePolicyVersion,
      evidencePolicyCodeDigest: pact.evidencePolicyCodeDigest,
    });
    return {
      workflowId: pact.pactId,
      metadataRef: `orpk1:${pact.pathRevision}:${pact.pathHash.slice(2)}:${pact.decisionHash.slice(2)}:${evidencePolicyHash.slice(2)}`,
      descriptionHash: pact.termsHash,
      salt: pact.termsHash,
      pathHash: pact.pathHash,
      pactHash: pact.termsHash,
    };
  }

  async recordPactSettlement(input: { pactId: string; actor: string; txHash: Hex; settledAmountBaseUnits: string; final: boolean }): Promise<PactV1> {
    assertHex32(input.txHash, "settlement txHash");
    parseBaseUnits(input.settledAmountBaseUnits, "settled amount", false);
    if (!this.options.chainVerifier) throw new Error("Canonical OpenRails chain verifier is required to record settlement");
    const before = requirePact(await this.state(), input.pactId);
    assertPact(before);
    if (!before.openRails?.openingObservation) throw new Error("Pact has no canonically verified OpenRails opening");
    const observation = await this.options.chainVerifier.verifySettlement({
      pact: clone(before),
      txHash: input.txHash,
      settledAmountBaseUnits: input.settledAmountBaseUnits,
      final: input.final,
    });
    assertSettlementObservationMatchesPact(before, input.txHash, input.settledAmountBaseUnits, observation);
    if (observation.final !== input.final) throw new Error("Settlement finality claim does not match canonical Paycard state");
    return this.options.store.transact((state) => {
      const pact = requirePact(state, input.pactId);
      assertPact(pact);
      if (!pact.openRails?.openingObservation) throw new Error("Canonical opening observation disappeared before settlement recording");
      assertSettlementObservationMatchesPact(pact, input.txHash, input.settledAmountBaseUnits, observation);
      const settlements = pact.openRails.settlements ?? [];
      if (!settlements.some((entry) => entry.transactionHash.toLowerCase() === observation.transactionHash.toLowerCase())) settlements.push(observation);
      pact.openRails.settlements = settlements;
      pact.status = observation.final ? "settled" : pact.status;
      pact.revision += 1;
      pact.updatedAt = nowIso(this.now);
      pactEvent(state, pact, observation.final ? "PACT_SETTLED_CANONICAL" : "SETTLEMENT_CONFIRMED_CANONICAL", input.actor, {
        termsHash: pact.termsHash,
        txHash: input.txHash,
        paycardId: pact.openRails.paycardId,
        settledAmountBaseUnits: observation.settledAmountBaseUnits,
        blockNumber: observation.blockNumber,
      }, pact.updatedAt);
      return pact;
    });
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceV1 | undefined> { return clone((await this.state()).workspaces[workspaceId]); }
  async getAgent(agentId: string): Promise<AgentIdentityV1 | undefined> { return clone((await this.state()).agents[agentId]); }
  async getPath(pathId: string): Promise<SignedArtifactV1<PathV1> | undefined> { return clone((await this.state()).paths[pathId]); }
  async getPact(pactId: string): Promise<PactV1 | undefined> { return clone((await this.state()).pacts[pactId]); }
  async getJob(jobId: string): Promise<RuntimeJobV1 | undefined> { return clone((await this.state()).jobs[jobId]); }
  async listBlockedActions(workspaceId: string): Promise<BlockedActionV1[]> { return clone((await this.state()).blockedActions.filter((entry) => entry.workspaceId === workspaceId)); }
  async exportAuditBundle(workspaceId: string): Promise<{ stateHash: Hex; canonical: string }> {
    const state = await this.state();
    const bundle = {
      workspace: state.workspaces[workspaceId],
      workspaceArtifact: state.workspaceArtifacts[workspaceId],
      agents: Object.values(state.agents).filter((entry) => entry.workspaceId === workspaceId),
      agentArtifacts: Object.values(state.agentArtifacts).filter((entry) => entry.artifact.workspaceId === workspaceId),
      paths: Object.values(state.paths).filter((entry) => entry.artifact.workspaceId === workspaceId),
      pacts: Object.values(state.pacts).filter((entry) => entry.workspaceId === workspaceId),
      events: state.events.filter((entry) => entry.workspaceId === workspaceId),
      blockedActions: state.blockedActions.filter((entry) => entry.workspaceId === workspaceId),
      gaiaCases: Object.values(state.gaiaCases).filter((entry) => entry.workspaceId === workspaceId),
    };
    const canonical = canonicalJson(bundle);
    return { stateHash: sha256Hex(canonical), canonical };
  }
}
