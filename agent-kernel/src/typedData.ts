import type {
  Address,
  AgentIdentityV1,
  PactV1,
  PathV1,
  TypedDataEnvelope,
  ExecutionCheckpointV1,
  GaiaCaseV1,
  VerificationPluginManifestV1,
  WorkspaceCommandV1,
  WorkspaceV1,
} from "./types.js";
import { hashCanonical } from "./canonical.js";
import { GIWA_SEPOLIA } from "./giwa.js";

export const OPENRAILS_GIWA_CHAIN_ID = GIWA_SEPOLIA.chainId;
export const OPENRAILS_GIWA_VAULT = GIWA_SEPOLIA.vaultAddress as Address;

export function authorityDomain(verifyingContract: Address = OPENRAILS_GIWA_VAULT): TypedDataEnvelope["domain"] {
  return {
    name: "OpenRails Agent Kernel",
    version: "1",
    chainId: OPENRAILS_GIWA_CHAIN_ID,
    verifyingContract,
  };
}

function envelope(primaryType: string, fields: Array<{ name: string; type: string }>, message: Record<string, unknown>): TypedDataEnvelope {
  return {
    domain: authorityDomain(),
    primaryType,
    types: { [primaryType]: fields },
    message,
  };
}

export function workspaceTypedData(workspace: WorkspaceV1): TypedDataEnvelope {
  return envelope("WorkspaceAuthority", [
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "principalIdHash", type: "bytes32" },
    { name: "authorityAccount", type: "address" },
    { name: "authorityTypeHash", type: "bytes32" },
    { name: "revision", type: "uint256" },
    { name: "workspaceHash", type: "bytes32" },
  ], {
    workspaceIdHash: hashCanonical(workspace.workspaceId),
    principalIdHash: hashCanonical(workspace.principalId),
    authorityAccount: workspace.authorityAccount,
    authorityTypeHash: hashCanonical(workspace.authorityType),
    revision: workspace.revision,
    workspaceHash: hashCanonical(workspace),
  });
}

export function agentRegistrationTypedData(agent: AgentIdentityV1): TypedDataEnvelope {
  return envelope("AgentRegistration", [
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "agentIdHash", type: "bytes32" },
    { name: "operator", type: "address" },
    { name: "identityKeyHash", type: "bytes32" },
    { name: "capabilitiesHash", type: "bytes32" },
    { name: "revision", type: "uint256" },
    { name: "agentHash", type: "bytes32" },
  ], {
    workspaceIdHash: hashCanonical(agent.workspaceId),
    agentIdHash: hashCanonical(agent.agentId),
    operator: agent.operator,
    identityKeyHash: hashCanonical(agent.identityKey),
    capabilitiesHash: hashCanonical(agent.capabilities),
    revision: agent.revision,
    agentHash: hashCanonical(agent),
  });
}

export function pathTypedData(path: PathV1): TypedDataEnvelope {
  return envelope("OpenRailsPath", [
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "pathIdHash", type: "bytes32" },
    { name: "authorityAccount", type: "address" },
    { name: "revision", type: "uint256" },
    { name: "authorityModeHash", type: "bytes32" },
    { name: "pathHash", type: "bytes32" },
    { name: "expiresAtHash", type: "bytes32" },
  ], {
    workspaceIdHash: hashCanonical(path.workspaceId),
    pathIdHash: hashCanonical(path.pathId),
    authorityAccount: path.authorityAccount,
    revision: path.revision,
    authorityModeHash: hashCanonical(path.authorityMode),
    pathHash: hashCanonical(path),
    expiresAtHash: hashCanonical(path.expiresAt),
  });
}

export function pactTermsProjection(pact: PactV1): Record<string, unknown> {
  return {
    version: "openrails-pact-terms-v1",
    pactId: pact.pactId,
    workspaceId: pact.workspaceId,
    pathId: pact.pathId,
    pathRevision: pact.pathRevision,
    pathHash: pact.pathHash,
    proposalId: pact.proposalId,
    proposalHash: pact.proposalHash,
    decisionId: pact.decisionId,
    decisionHash: pact.decisionHash,
    initiator: pact.initiator,
    agentId: pact.agentId,
    counterparty: pact.counterparty,
    actionType: pact.actionType,
    specification: pact.specification,
    commercialTerms: pact.commercialTerms,
    paymentTerms: pact.paymentTerms,
    evidencePolicyId: pact.evidencePolicyId,
    evidencePolicyVersion: pact.evidencePolicyVersion,
    evidencePolicyCodeDigest: pact.evidencePolicyCodeDigest,
    completionPolicyId: pact.completionPolicyId,
    disputePolicyId: pact.disputePolicyId,
    requiresCounterpartySignature: pact.requiresCounterpartySignature,
  };
}

export function pactTermsHash(pact: PactV1): `0x${string}` {
  return hashCanonical(pactTermsProjection(pact));
}

export function assertPactTermsIntegrity(pact: PactV1): void {
  if (pactTermsHash(pact) !== pact.termsHash) throw new Error("Pact immutable terms hash mismatch");
}

export function pactTypedData(pact: PactV1): TypedDataEnvelope {
  assertPactTermsIntegrity(pact);
  return envelope("OpenRailsPactTerms", [
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "pactIdHash", type: "bytes32" },
    { name: "pathIdHash", type: "bytes32" },
    { name: "pathHash", type: "bytes32" },
    { name: "proposalHash", type: "bytes32" },
    { name: "decisionHash", type: "bytes32" },
    { name: "initiator", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "actionTypeHash", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
  ], {
    workspaceIdHash: hashCanonical(pact.workspaceId),
    pactIdHash: hashCanonical(pact.pactId),
    pathIdHash: hashCanonical(pact.pathId),
    pathHash: pact.pathHash,
    proposalHash: pact.proposalHash,
    decisionHash: pact.decisionHash,
    initiator: pact.initiator,
    counterparty: pact.counterparty,
    actionTypeHash: hashCanonical(pact.actionType),
    termsHash: pact.termsHash,
  });
}



export function gaiaCaseClaimProjection(gaia: GaiaCaseV1): Record<string, unknown> {
  return {
    version: "openrails-gaia-claim-v1",
    caseId: gaia.caseId,
    workspaceId: gaia.workspaceId,
    pactId: gaia.pactId,
    pathId: gaia.pathId,
    ...(gaia.paycardId ? { paycardId: gaia.paycardId } : {}),
    claimant: gaia.claimant,
    respondent: gaia.respondent,
    reasonCode: gaia.reasonCode,
    evidenceCommitments: gaia.evidenceCommitments,
    paymentSnapshot: gaia.paymentSnapshot,
    requestedRemedy: gaia.requestedRemedy,
    resolutionPolicyId: gaia.resolutionPolicyId,
    claimValidUntil: gaia.claimValidUntil,
  };
}

export function gaiaCaseClaimHash(gaia: GaiaCaseV1): `0x${string}` {
  return hashCanonical(gaiaCaseClaimProjection(gaia));
}

export function gaiaCaseClaimTypedData(gaia: GaiaCaseV1): TypedDataEnvelope {
  if (gaiaCaseClaimHash(gaia) !== gaia.claimHash) throw new Error("Gaia claim hash mismatch");
  return envelope("GaiaCaseClaim", [
    { name: "caseIdHash", type: "bytes32" },
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "pactIdHash", type: "bytes32" },
    { name: "pathIdHash", type: "bytes32" },
    { name: "claimant", type: "address" },
    { name: "respondent", type: "address" },
    { name: "reasonCodeHash", type: "bytes32" },
    { name: "claimHash", type: "bytes32" },
    { name: "claimValidUntilHash", type: "bytes32" },
  ], {
    caseIdHash: hashCanonical(gaia.caseId),
    workspaceIdHash: hashCanonical(gaia.workspaceId),
    pactIdHash: hashCanonical(gaia.pactId),
    pathIdHash: hashCanonical(gaia.pathId),
    claimant: gaia.claimant,
    respondent: gaia.respondent,
    reasonCodeHash: hashCanonical(gaia.reasonCode),
    claimHash: gaia.claimHash,
    claimValidUntilHash: hashCanonical(gaia.claimValidUntil),
  });
}

export function workspaceCommandTypedData(command: WorkspaceCommandV1): TypedDataEnvelope {
  return envelope("WorkspaceCommand", [
    { name: "commandIdHash", type: "bytes32" },
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "operationHash", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "workspaceRevision", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAtHash", type: "bytes32" },
    { name: "expiresAtHash", type: "bytes32" },
  ], {
    commandIdHash: hashCanonical(command.commandId),
    workspaceIdHash: hashCanonical(command.workspaceId),
    operationHash: hashCanonical(command.operation),
    payloadHash: command.payloadHash,
    workspaceRevision: command.workspaceRevision,
    nonce: command.nonce,
    issuedAtHash: hashCanonical(command.issuedAt),
    expiresAtHash: hashCanonical(command.expiresAt),
  });
}

export function checkpointTypedData(checkpoint: ExecutionCheckpointV1): TypedDataEnvelope {
  const { signature: _signature, ...unsigned } = checkpoint;
  return envelope("ExecutionCheckpoint", [
    { name: "workspaceIdHash", type: "bytes32" },
    { name: "pactIdHash", type: "bytes32" },
    { name: "pathIdHash", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "paycardId", type: "bytes32" },
    { name: "actor", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "checkpointIndex", type: "uint256" },
    { name: "checkpointTypeHash", type: "bytes32" },
    { name: "evidenceTypeHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "checkpointHash", type: "bytes32" },
    { name: "validUntilHash", type: "bytes32" },
  ], {
    workspaceIdHash: hashCanonical(checkpoint.workspaceId),
    pactIdHash: hashCanonical(checkpoint.pactId),
    pathIdHash: hashCanonical(checkpoint.pathId),
    termsHash: checkpoint.termsHash,
    paycardId: checkpoint.paycardId ?? ("0x" + "00".repeat(32)),
    actor: checkpoint.actor,
    counterparty: checkpoint.counterparty,
    checkpointIndex: checkpoint.checkpointIndex,
    checkpointTypeHash: hashCanonical(checkpoint.checkpointType),
    evidenceTypeHash: hashCanonical(checkpoint.evidenceType),
    evidenceHash: checkpoint.evidenceHash,
    checkpointHash: hashCanonical(unsigned),
    validUntilHash: hashCanonical(checkpoint.validUntil),
  });
}

export function verificationPluginTypedData(manifest: VerificationPluginManifestV1): TypedDataEnvelope {
  const { publisherSignature: _publisherSignature, ...unsignedManifest } = manifest;
  return envelope("VerificationPluginManifest", [
    { name: "pluginIdHash", type: "bytes32" },
    { name: "pluginVersionHash", type: "bytes32" },
    { name: "publisher", type: "address" },
    { name: "codeDigest", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
  ], {
    pluginIdHash: hashCanonical(manifest.pluginId),
    pluginVersionHash: hashCanonical(manifest.pluginVersion),
    publisher: manifest.publisher,
    codeDigest: manifest.codeDigest,
    manifestHash: hashCanonical(unsignedManifest),
  });
}

export interface AuthoritySignatureVerifier {
  verify(input: { typedData: TypedDataEnvelope; signature: `0x${string}`; expectedSigner: Address }): Promise<boolean>;
}
