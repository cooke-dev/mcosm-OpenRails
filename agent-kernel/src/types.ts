export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type IsoDate = string;

export type WorkspaceType = "individual" | "organization";
export type AuthorityType = "eoa" | "multisig" | "smart-account";
export type AuthorityMode = "observe" | "propose" | "prepare" | "confirmed_execution";
export type Decision = "ALLOW" | "BLOCK" | "REVIEW";
export type VerificationDecisionValue = "approved" | "rejected" | "review";
export type AgentStatus = "pending" | "active" | "paused" | "revoked";
export type PathStatus = "draft" | "active" | "paused" | "expired" | "revoked";
export type PactStatus =
  | "draft"
  | "proposed"
  | "counterparty_verified"
  | "policy_approved"
  | "awaiting_signatures"
  | "accepted"
  | "payment_prepared"
  | "awaiting_wallet"
  | "active"
  | "performing"
  | "completed"
  | "settled"
  | "closed"
  | "blocked"
  | "cancelled"
  | "failed"
  | "disputed"
  | "rectification_required"
  | "rectified";

export type WorkspaceRole =
  | "owner"
  | "policy_admin"
  | "agent_admin"
  | "payment_approver"
  | "risk_reviewer"
  | "auditor"
  | "gaia_resolver";

export interface WorkspaceMemberV1 {
  address: Address;
  roles: WorkspaceRole[];
  status: "active" | "revoked";
  addedAt: IsoDate;
}

export interface WorkspaceV1 {
  version: "openrails-workspace-v1";
  workspaceId: string;
  workspaceType: WorkspaceType;
  displayName: string;
  principalId: string;
  authorityAccount: Address;
  authorityType: AuthorityType;
  members: WorkspaceMemberV1[];
  status: "active" | "paused" | "revoked";
  revision: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type WorkspaceCommandOperation =
  | "set_agent_status"
  | "install_plugin"
  | "resolve_gaia"
  | "pause_path"
  | "revoke_path";

export interface WorkspaceCommandV1 {
  version: "openrails-workspace-command-v1";
  commandId: string;
  workspaceId: string;
  operation: WorkspaceCommandOperation;
  payloadHash: Hex;
  workspaceRevision: number;
  nonce: number;
  issuedAt: IsoDate;
  expiresAt: IsoDate;
}

export interface AgentIdentityV1 {
  version: "openrails-agent-identity-v1";
  agentId: string;
  workspaceId: string;
  displayName: string;
  description?: string;
  operator: Address;
  identityKey: string;
  runtimeCredentialHash: Hex;
  capabilities: string[];
  permittedActionTypes: string[];
  assignedPathIds: string[];
  status: AgentStatus;
  createdAt: IsoDate;
  expiresAt?: IsoDate;
  revision: number;
}

export interface IdentityRequirementV1 {
  provider: "dojang" | "none" | string;
  requirement: string;
  required: boolean;
  nameService?: "up.id" | string;
  requireResolvedName?: boolean;
  requireForwardResolutionMatch?: boolean;
}

export interface PathLimitsV1 {
  maxPerPactBaseUnits: string;
  maxActiveExposureBaseUnits: string;
  maxPerPeriodBaseUnits: string;
  periodSeconds: number;
  maxVelocityBaseUnitsPerSecond: string;
  maxDurationSeconds: number;
  maxConcurrentPacts: number;
}

export interface PathV1 {
  version: "openrails-path-v1";
  pathId: string;
  workspaceId: string;
  owner: Address;
  authorityAccount: Address;
  authorizedAgentIds: string[];
  permittedActions: string[];
  permittedAssets: Address[];
  permittedCounterparties?: Address[];
  identityRequirements: IdentityRequirementV1[];
  approvedVerificationPlugins: Array<{ pluginId: string; version: string }>;
  limits: PathLimitsV1;
  authorityMode: AuthorityMode;
  validFrom: IsoDate;
  expiresAt: IsoDate;
  status: PathStatus;
  revision: number;
  previousPathHash?: Hex;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface SignedArtifactV1<T> {
  artifact: T;
  hash: Hex;
  typedData: TypedDataEnvelope;
  signer: Address;
  signature: Hex;
  signedAt: IsoDate;
}

export interface TypedDataEnvelope {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  primaryType: string;
  types: Record<string, Array<{ name: string; type: string }>>;
  message: Record<string, unknown>;
}

export interface PaymentTermsV1 {
  chainId: number;
  vault: Address;
  token: Address;
  payer: Address;
  recipient: Address;
  maximumAllocationBaseUnits: string;
  velocityBaseUnitsPerSecond: string;
  lifespanSeconds: number;
  residualRecipient: Address;
}

export interface PactV1 {
  version: "openrails-pact-v1";
  pactId: string;
  workspaceId: string;
  pathId: string;
  pathRevision: number;
  pathHash: Hex;
  proposalId: string;
  proposalHash: Hex;
  decisionId: string;
  decisionHash: Hex;
  termsHash: Hex;
  initiator: Address;
  agentId: string;
  counterparty: Address;
  actionType: string;
  specification: Record<string, unknown>;
  commercialTerms: Record<string, unknown>;
  paymentTerms: PaymentTermsV1;
  evidencePolicyId: string;
  evidencePolicyVersion: string;
  evidencePolicyCodeDigest: Hex;
  completionPolicyId: string;
  disputePolicyId: string;
  requiresCounterpartySignature: boolean;
  status: PactStatus;
  revision: number;
  openRails?: {
    metadataHash: Hex;
    paycardId: Hex;
    genesisTimestamp: number;
    nonceChannel: number;
    nonceValue: number;
    preparedAt: IsoDate;
    openingTxHash?: Hex;
    openingObservation?: OpenRailsOpeningObservationV1;
    settlements?: OpenRailsSettlementObservationV1[];
  };
  createdAt: IsoDate;
  updatedAt: IsoDate;
}


export interface OpenRailsOpeningObservationV1 {
  version: "openrails-opening-observation-v1";
  transactionHash: Hex;
  chainId: number;
  vault: Address;
  paycardId: Hex;
  metadataHash: Hex;
  payer: Address;
  recipient: Address;
  residualRecipient: Address;
  poolAllocationBaseUnits: string;
  flowVelocityBaseUnitsPerSecond: string;
  genesisTimestamp: number;
  lifespanSeconds: number;
  availableBalanceBaseUnits: string;
  operationalStatus: number;
  blockNumber: number;
  observedAt: IsoDate;
}

export interface OpenRailsSettlementObservationV1 {
  version: "openrails-settlement-observation-v1";
  transactionHash: Hex;
  chainId: number;
  vault: Address;
  paycardId: Hex;
  recipient: Address;
  settledAmountBaseUnits: string;
  final: boolean;
  blockNumber: number;
  observedAt: IsoDate;
}

export interface PactEventV1 {
  version: "openrails-pact-event-v1";
  eventId: string;
  pactId: string;
  workspaceId: string;
  sequence: number;
  type: string;
  actor: string;
  at: IsoDate;
  data: Record<string, unknown>;
}

export interface ActionDescriptorV1 {
  version: "openrails-action-v1";
  actionType: string;
  description: string;
  riskClass: "read" | "proposal" | "prepare" | "financial" | "administrative";
  minimumAuthorityMode: AuthorityMode;
  executor: "runtime" | "wallet" | "smart-account" | "public-caller";
  paymentEffect: "none" | "prepare_only" | "moves_value";
  allowedTargets: Address[];
  allowedSelectors: Hex[];
  enabled: boolean;
}

export interface AgentProposalV1 {
  version: "openrails-agent-proposal-v1";
  proposalId: string;
  workspaceId: string;
  pathId: string;
  agentId: string;
  actionType: string;
  counterparty?: Address;
  asset: Address;
  requestedAllocationBaseUnits: string;
  requestedVelocityBaseUnitsPerSecond: string;
  requestedDurationSeconds: number;
  specification: Record<string, unknown>;
  evidencePolicyId: string;
  requestedAt: IsoDate;
  idempotencyKey: string;
}

export type PolicyReasonCode =
  | "WORKSPACE_INACTIVE"
  | "AGENT_NOT_REGISTERED"
  | "AGENT_INACTIVE"
  | "AGENT_NOT_ASSIGNED_TO_PATH"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_ACTIVE"
  | "PATH_NOT_YET_VALID"
  | "PATH_EXPIRED"
  | "ACTION_NOT_REGISTERED"
  | "ACTION_DISABLED"
  | "ACTION_NOT_ALLOWED"
  | "AUTHORITY_MODE_INSUFFICIENT"
  | "ASSET_NOT_ALLOWED"
  | "COUNTERPARTY_REQUIRED"
  | "COUNTERPARTY_NOT_ALLOWED"
  | "COUNTERPARTY_NOT_VERIFIED"
  | "PACT_LIMIT_EXCEEDED"
  | "ACTIVE_EXPOSURE_EXCEEDED"
  | "PERIOD_LIMIT_EXCEEDED"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "DURATION_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "PLUGIN_NOT_APPROVED"
  | "INVALID_AMOUNT"
  | "INVALID_DURATION"
  | "STALE_PATH_REVISION"
  | "CHECKPOINT_REJECTED"
  | "SIGNATURE_INVALID";

export interface BaphometDecisionV1 {
  version: "openrails-baphomet-decision-v1";
  decisionId: string;
  proposalId: string;
  proposalHash: Hex;
  workspaceId: string;
  pathId: string;
  pathHash: Hex;
  result: Decision;
  reasonCodes: PolicyReasonCode[];
  summary: string;
  policySnapshot: {
    activeExposureBaseUnits: string;
    periodSpentBaseUnits: string;
    activePacts: number;
  };
  evidenceHash: Hex;
  decisionHash: Hex;
  evaluatedAt: IsoDate;
}

export interface BlockedActionV1 {
  version: "openrails-blocked-action-v1";
  blockedActionId: string;
  workspaceId: string;
  pathId: string;
  agentId: string;
  proposalId: string;
  actionType: string;
  requestedAllocationBaseUnits: string;
  reasonCodes: PolicyReasonCode[];
  decisionHash: Hex;
  at: IsoDate;
}

export interface VerificationPluginManifestV1 {
  version: "openrails-verification-plugin-v1";
  pluginId: string;
  pluginVersion: string;
  name: string;
  publisher: Address;
  pluginType: "identity" | "counterparty" | "quote" | "checkpoint" | "completion" | "risk" | "gaia";
  supportedEvidenceTypes: string[];
  deterministic: boolean;
  requiresNetworkAccess: boolean;
  externalDependencies: string[];
  codeDigest: Hex;
  publisherSignature: Hex;
  status: "pending" | "active" | "disabled" | "revoked";
  installedWorkspaceIds: string[];
  createdAt: IsoDate;
}

export interface ExecutionCheckpointV1 {
  version: "openrails-work-checkpoint-v1";
  checkpointId: string;
  workspaceId: string;
  pactId: string;
  pathId: string;
  paycardId?: Hex;
  termsHash: Hex;
  actor: Address;
  counterparty: Address;
  checkpointIndex: number;
  checkpointType: "accepted" | "started" | "progress" | "milestone" | "delivery" | "completed" | "failed";
  evidenceType: string;
  evidenceHash: Hex;
  sourceCommitmentHash?: Hex;
  evidenceUri?: string;
  units?: { type: string; completed: string; total?: string };
  observedAt: IsoDate;
  validUntil: IsoDate;
  submittedBy: Address;
  signature: Hex;
}

export interface VerificationDecisionV1 {
  version: "openrails-verification-decision-v1";
  decisionId: string;
  workspaceId: string;
  pactId: string;
  checkpointId: string;
  pluginId: string;
  pluginVersion: string;
  decision: VerificationDecisionValue;
  reasonCodes: string[];
  evidenceHash: Hex;
  sourceCommitmentHash?: Hex;
  decisionHash: Hex;
  evaluatedAt: IsoDate;
  validUntil?: IsoDate;
  verifierSignature?: Hex;
}

export interface GaiaCaseV1 {
  version: "openrails-gaia-case-v1";
  caseId: string;
  workspaceId: string;
  pactId: string;
  pathId: string;
  paycardId?: Hex;
  claimant: Address;
  respondent: Address;
  reasonCode: string;
  evidenceCommitments: Hex[];
  paymentSnapshot: {
    observedAt: IsoDate;
    availableBalanceBaseUnits?: string;
    operationalStatus?: string;
    latestSettlementTxHash?: Hex;
  };
  requestedRemedy: string;
  resolutionPolicyId: string;
  claimHash: Hex;
  claimValidUntil: IsoDate;
  claimSignature: Hex;
  status: "open" | "review" | "resolved" | "dismissed" | "rectification_required" | "rectified";
  decision?: "dismiss" | "close_and_return_residual" | "replacement_pact" | "compensating_pact" | "manual_review";
  resolutionSummary?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface RectificationObligationV1 {
  version: "openrails-rectification-obligation-v1";
  obligationId: string;
  caseId: string;
  pactId: string;
  workspaceId: string;
  obligor: Address;
  beneficiary: Address;
  remedyType: "replacement_pact" | "compensating_pact" | "manual_action";
  terms: Record<string, unknown>;
  status: "open" | "fulfilled" | "cancelled";
  createdAt: IsoDate;
  fulfilledAt?: IsoDate;
}

export interface RuntimeJobV1 {
  version: "openrails-runtime-job-v1";
  jobId: string;
  workspaceId: string;
  proposalId: string;
  kind: "evaluate_proposal" | "verify_checkpoint" | "open_gaia";
  state: "queued" | "running" | "completed" | "blocked" | "review" | "failed";
  attempts: number;
  lockedBy?: string;
  lockUntil?: IsoDate;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface GiwaIdentitySnapshotV1 {
  version: "openrails-giwa-identity-snapshot-v1";
  address: Address;
  verified: boolean;
  verificationProvider: string;
  verificationReference?: string;
  resolvedName?: string;
  forwardResolutionMatches?: boolean;
  observedAt: IsoDate;
}

export interface KernelEventV1 {
  version: "openrails-kernel-event-v1";
  eventId: string;
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  actor: string;
  at: IsoDate;
  data: Record<string, unknown>;
}

export interface KernelStateV1 {
  version: "openrails-agent-kernel-state-v1";
  workspaces: Record<string, WorkspaceV1>;
  workspaceArtifacts: Record<string, SignedArtifactV1<WorkspaceV1>>;
  agents: Record<string, AgentIdentityV1>;
  agentArtifacts: Record<string, SignedArtifactV1<AgentIdentityV1>>;
  paths: Record<string, SignedArtifactV1<PathV1>>;
  pacts: Record<string, PactV1>;
  pactSignatures: Record<string, SignedArtifactV1<PactV1>[]>;
  pactEvents: PactEventV1[];
  proposals: Record<string, AgentProposalV1>;
  decisions: Record<string, BaphometDecisionV1>;
  blockedActions: BlockedActionV1[];
  plugins: Record<string, VerificationPluginManifestV1>;
  checkpoints: Record<string, ExecutionCheckpointV1>;
  verificationDecisions: Record<string, VerificationDecisionV1>;
  gaiaCases: Record<string, GaiaCaseV1>;
  rectifications: Record<string, RectificationObligationV1>;
  jobs: Record<string, RuntimeJobV1>;
  events: KernelEventV1[];
  workspaceCommandNonces: Record<string, number>;
  idempotency: Record<string, { fingerprint: Hex; result: Record<string, unknown> }>;
}
