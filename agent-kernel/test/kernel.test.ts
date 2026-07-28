import test from "node:test";
import assert from "node:assert/strict";
import {
  ActionRegistry,
  MemoryKernelStore,
  OpenRailsAgentKernel,
  VerificationPluginRegistry,
  hashCanonical,
  type Address,
  type AgentIdentityV1,
  type AgentProposalV1,
  type AuthoritySignatureVerifier,
  type ExecutionCheckpointV1,
  type Hex,
  type OpenRailsChainVerifier,
  type PathV1,
  type VerificationPluginManifestV1,
} from "../src/index.js";

const authority = "0x1111111111111111111111111111111111111111" as Address;
const agentOperator = "0x2222222222222222222222222222222222222222" as Address;
const provider = "0x3333333333333333333333333333333333333333" as Address;
const token = "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De" as Address;
const signature = `0x${"11".repeat(65)}` as Hex;
const verifier: AuthoritySignatureVerifier = { async verify(input) { return input.signature === signature; } };
const now = () => new Date("2026-07-28T12:00:00.000Z");

const chainVerifier: OpenRailsChainVerifier = {
  async verifyOpening({ pact, metadataHash, paycardId, openingTxHash }) {
    if (!pact.openRails) throw new Error("payment not prepared");
    return {
      version: "openrails-opening-observation-v1",
      transactionHash: openingTxHash,
      chainId: pact.paymentTerms.chainId,
      vault: pact.paymentTerms.vault,
      paycardId,
      metadataHash,
      payer: pact.paymentTerms.payer,
      recipient: pact.paymentTerms.recipient,
      residualRecipient: pact.paymentTerms.residualRecipient,
      poolAllocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
      flowVelocityBaseUnitsPerSecond: pact.paymentTerms.velocityBaseUnitsPerSecond,
      genesisTimestamp: pact.openRails.genesisTimestamp,
      lifespanSeconds: pact.paymentTerms.lifespanSeconds,
      availableBalanceBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
      operationalStatus: 0,
      blockNumber: 1,
      observedAt: now().toISOString(),
    };
  },
  async verifySettlement({ pact, txHash, settledAmountBaseUnits, final }) {
    if (!pact.openRails) throw new Error("payment not prepared");
    return {
      version: "openrails-settlement-observation-v1",
      transactionHash: txHash,
      chainId: pact.paymentTerms.chainId,
      vault: pact.paymentTerms.vault,
      paycardId: pact.openRails.paycardId,
      recipient: pact.paymentTerms.recipient,
      settledAmountBaseUnits,
      final,
      blockNumber: 2,
      observedAt: now().toISOString(),
    };
  },
};

async function setup() {
  const store = new MemoryKernelStore();
  const plugins = new VerificationPluginRegistry();
  const kernel = new OpenRailsAgentKernel({
    store,
    signatureVerifier: verifier,
    actionRegistry: new ActionRegistry(),
    pluginRegistry: plugins,
    chainVerifier,
    now,
    identityResolver: {
      async resolve(address) {
        return {
          version: "openrails-giwa-identity-snapshot-v1",
          address,
          verified: true,
          verificationProvider: "dojang",
          resolvedName: "provider.up.id",
          forwardResolutionMatches: true,
          observedAt: now().toISOString(),
        };
      },
    },
  });

  const preparedWorkspace = kernel.prepareWorkspace({
    workspaceId: "workspace.demo",
    workspaceType: "individual",
    displayName: "Demo Workspace",
    principalId: "principal.demo",
    authorityAccount: authority,
    authorityType: "eoa",
  });
  await kernel.registerWorkspace({ workspace: preparedWorkspace.workspace, signature });

  const preparedAgent = kernel.prepareAgentRegistration({
    agentId: "agent.demo",
    workspaceId: "workspace.demo",
    displayName: "Demo Agent",
    operator: agentOperator,
    identityKey: "did:key:demo",
    runtimeCredentialHash: hashCanonical("runtime-credential"),
    capabilities: ["commerce"],
    permittedActionTypes: ["prepare_railsflow", "create_pact_proposal", "submit_checkpoint"],
  });
  await kernel.registerAgent({ agent: preparedAgent.agent, authoritySigner: authority, signature });

  const manifest: VerificationPluginManifestV1 = {
    version: "openrails-verification-plugin-v1",
    pluginId: "proof.hash",
    pluginVersion: "1.0.0",
    name: "Hash proof",
    publisher: authority,
    pluginType: "checkpoint",
    supportedEvidenceTypes: ["hash"],
    deterministic: true,
    requiresNetworkAccess: false,
    externalDependencies: [],
    codeDigest: hashCanonical("hash-proof-v1"),
    publisherSignature: signature,
    status: "active",
    installedWorkspaceIds: ["workspace.demo"],
    createdAt: now().toISOString(),
  };
  plugins.bind({
    manifest,
    async evaluate(checkpoint) {
      return { decision: /^0x[0-9a-fA-F]{64}$/.test(checkpoint.evidenceHash) ? "approved" : "rejected", reasonCodes: ["TEST_VERIFIER"] };
    },
  });
  const pluginPayload = { workspaceId: "workspace.demo", pluginId: manifest.pluginId, pluginVersion: manifest.pluginVersion, codeDigest: manifest.codeDigest };
  const pluginCommand = await kernel.prepareWorkspaceCommand({ workspaceId: "workspace.demo", operation: "install_plugin", payload: pluginPayload });
  await kernel.installPlugin({ manifest, command: pluginCommand.command, signature });

  const path: PathV1 = {
    version: "openrails-path-v1",
    pathId: "path.demo",
    workspaceId: "workspace.demo",
    owner: authority,
    authorityAccount: authority,
    authorizedAgentIds: ["agent.demo"],
    permittedActions: ["prepare_railsflow", "create_pact_proposal", "submit_checkpoint", "open_gaia_request"],
    permittedAssets: [token],
    permittedCounterparties: [provider],
    identityRequirements: [{ provider: "dojang", requirement: "verified-address", required: true, nameService: "up.id", requireResolvedName: true, requireForwardResolutionMatch: true }],
    approvedVerificationPlugins: [{ pluginId: "proof.hash", version: "1.0.0" }],
    limits: {
      maxPerPactBaseUnits: "10000000",
      maxActiveExposureBaseUnits: "20000000",
      maxPerPeriodBaseUnits: "30000000",
      periodSeconds: 86400,
      maxVelocityBaseUnitsPerSecond: "100000",
      maxDurationSeconds: 3600,
      maxConcurrentPacts: 2,
    },
    authorityMode: "prepare",
    validFrom: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:00:00.000Z",
    status: "active",
    revision: 1,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  await kernel.activatePath({ path, signature });
  return { kernel, path, manifest };
}

function proposal(overrides: Partial<AgentProposalV1> = {}): AgentProposalV1 {
  return {
    version: "openrails-agent-proposal-v1",
    proposalId: "proposal.demo",
    workspaceId: "workspace.demo",
    pathId: "path.demo",
    agentId: "agent.demo",
    actionType: "prepare_railsflow",
    counterparty: provider,
    asset: token,
    requestedAllocationBaseUnits: "5000000",
    requestedVelocityBaseUnitsPerSecond: "1000",
    requestedDurationSeconds: 600,
    specification: { task: "generic" },
    evidencePolicyId: "proof.hash",
    requestedAt: now().toISOString(),
    idempotencyKey: "proposal-demo-1",
    ...overrides,
  };
}

test("full allowed lifecycle creates a Pact, verifies proof, and binds OpenRails", async () => {
  const { kernel } = await setup();
  const submitted = await kernel.submitProposal(proposal());
  const job = await kernel.runNextJob("worker-1");
  assert.equal(job?.state, "completed");

  const pact = await kernel.createPactFromProposal({
    proposalId: submitted.proposal.proposalId,
    pactId: "pact.demo",
    commercialTerms: { currency: "orUSD" },
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
  });
  assert.equal(pact.status, "awaiting_signatures");

  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  await kernel.signPact({ pactId: pact.pactId, signer: provider, signature });
  assert.equal((await kernel.getPact(pact.pactId))?.status, "accepted");

  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("metadata"),
    paycardId: hashCanonical("paycard"),
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 1,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("metadata"),
    paycardId: hashCanonical("paycard"),
    actor: authority,
    openingTxHash: hashCanonical("open-tx"),
  });
  assert.equal((await kernel.getPact(pact.pactId))?.status, "active");

  const checkpoint: ExecutionCheckpointV1 = {
    version: "openrails-work-checkpoint-v1",
    checkpointId: "checkpoint.demo",
    workspaceId: "workspace.demo",
    pactId: pact.pactId,
    pathId: "path.demo",
    paycardId: hashCanonical("paycard"),
    termsHash: pact.termsHash,
    actor: provider,
    counterparty: provider,
    checkpointIndex: 1,
    checkpointType: "completed",
    evidenceType: "hash",
    evidenceHash: hashCanonical("work-result"),
    observedAt: now().toISOString(),
    validUntil: "2026-07-28T12:05:00.000Z",
    submittedBy: provider,
    signature,
  };
  await kernel.submitCheckpoint(checkpoint);
  const decision = await kernel.verifyCheckpoint({ checkpointId: checkpoint.checkpointId, pluginId: "proof.hash", pluginVersion: "1.0.0" });
  assert.equal(decision.decision, "approved");
  assert.equal((await kernel.getPact(pact.pactId))?.status, "completed");
});

test("Baphomet blocks over-limit proposals and records refusal", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal({ proposalId: "proposal.over", idempotencyKey: "over-1", requestedAllocationBaseUnits: "10000001" }));
  const job = await kernel.runNextJob();
  assert.equal(job?.state, "blocked");
  const blocked = await kernel.listBlockedActions("workspace.demo");
  assert.equal(blocked.length, 1);
  assert.ok(blocked[0]?.reasonCodes.includes("PACT_LIMIT_EXCEEDED"));
});

test("Path revision requires predecessor hash and monotonic version", async () => {
  const { kernel, path } = await setup();
  const current = await kernel.getPath(path.pathId);
  assert.ok(current);
  await assert.rejects(
    kernel.activatePath({ path: { ...path, revision: 2, previousPathHash: hashCanonical("wrong") }, signature }),
    /previous hash mismatch/,
  );
  const revised: PathV1 = {
    ...path,
    revision: 2,
    previousPathHash: current!.hash,
    limits: { ...path.limits, maxPerPactBaseUnits: "12000000" },
    updatedAt: "2026-07-28T12:01:00.000Z",
  };
  const signed = await kernel.activatePath({ path: revised, signature });
  assert.equal(signed.artifact.revision, 2);
});

test("revoked Agent cannot pass Baphomet", async () => {
  const { kernel } = await setup();
  const payload = { workspaceId: "workspace.demo", agentId: "agent.demo", status: "revoked" as const };
  const command = await kernel.prepareWorkspaceCommand({ workspaceId: "workspace.demo", operation: "set_agent_status", payload });
  await kernel.setAgentStatus({ ...payload, command: command.command, signature });
  await kernel.submitProposal(proposal({ proposalId: "proposal.revoked", idempotencyKey: "revoked-1" }));
  const job = await kernel.runNextJob();
  assert.equal(job?.state, "blocked");
  const blocked = await kernel.listBlockedActions("workspace.demo");
  assert.ok(blocked[0]?.reasonCodes.includes("AGENT_INACTIVE"));
});

test("Gaia creates a rectification obligation rather than reversing settlement", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.gaia",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: "pact.gaia", signer: authority, signature });
  const gaia = await kernel.openGaiaCase({
    caseId: "gaia.demo",
    workspaceId: "workspace.demo",
    pactId: "pact.gaia",
    pathId: "path.demo",
    claimant: authority,
    respondent: provider,
    reasonCode: "EVIDENCE_CONFLICT",
    evidenceCommitments: [hashCanonical("evidence")],
    paymentSnapshot: { observedAt: now().toISOString(), availableBalanceBaseUnits: "4000000" },
    requestedRemedy: "replacement",
    resolutionPolicyId: "gaia.default",
    claimValidUntil: "2026-07-28T12:05:00.000Z",
    claimSignature: signature,
  });
  assert.equal(gaia.status, "open");
  const resolutionPayload = {
    caseId: gaia.caseId,
    resolver: authority,
    decision: "replacement_pact" as const,
    resolutionSummary: "Create replacement Pact after residual closure.",
    rectificationTerms: { preserveAccruedSettlement: true },
  };
  const resolutionCommand = await kernel.prepareWorkspaceCommand({ workspaceId: "workspace.demo", operation: "resolve_gaia", payload: resolutionPayload });
  const resolved = await kernel.resolveGaiaCase({ ...resolutionPayload, command: resolutionCommand.command, signature });
  assert.equal(resolved.gaiaCase.status, "rectification_required");
  assert.equal(resolved.obligation?.remedyType, "replacement_pact");
});

test("idempotency rejects reused keys with different payloads", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await assert.rejects(
    kernel.submitProposal(proposal({ proposalId: "proposal.changed", requestedDurationSeconds: 601 })),
    /idempotency conflict/,
  );
});

test("authority mode prevents preparation when a Path is only propose", async () => {
  const { kernel, path } = await setup();
  const current = await kernel.getPath(path.pathId);
  const revised: PathV1 = {
    ...path,
    authorityMode: "propose",
    revision: 2,
    previousPathHash: current!.hash,
    updatedAt: "2026-07-28T12:02:00.000Z",
  };
  await kernel.activatePath({ path: revised, signature });
  await kernel.submitProposal(proposal({ proposalId: "proposal.mode", idempotencyKey: "mode-1" }));
  const job = await kernel.runNextJob();
  assert.equal(job?.state, "blocked");
  const blocked = await kernel.listBlockedActions("workspace.demo");
  assert.ok(blocked[0]?.reasonCodes.includes("AUTHORITY_MODE_INSUFFICIENT"));
});

test("Pact payment preparation fails after its signed Path revision becomes stale", async () => {
  const { kernel, path } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.stale",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: "pact.stale", signer: authority, signature });
  const current = await kernel.getPath(path.pathId);
  await kernel.activatePath({
    path: {
      ...path,
      revision: 2,
      previousPathHash: current!.hash,
      updatedAt: "2026-07-28T12:03:00.000Z",
    },
    signature,
  });
  await assert.rejects(kernel.openRailsMetadataBinding("pact.stale"), /stale Path revision/);
});


test("Pact parties and payment recipients are derived from the approved proposal and Workspace", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.derived",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
  });
  assert.equal(pact.counterparty, provider);
  assert.equal(pact.initiator, authority);
  assert.equal(pact.paymentTerms.payer, authority);
  assert.equal(pact.paymentTerms.recipient, provider);
  assert.equal(pact.paymentTerms.residualRecipient, authority);
  assert.equal(pact.proposalHash, hashCanonical(proposal()));
});

test("Pact creation re-evaluates policy and rejects a proposal after the Path is tightened", async () => {
  const { kernel, path } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const current = await kernel.getPath(path.pathId);
  await kernel.activatePath({
    path: {
      ...path,
      revision: 2,
      previousPathHash: current!.hash,
      permittedCounterparties: ["0x4444444444444444444444444444444444444444" as Address],
      updatedAt: "2026-07-28T12:04:00.000Z",
    },
    signature,
  });
  await assert.rejects(
    kernel.createPactFromProposal({
      proposalId: "proposal.demo",
      pactId: "pact.rejected-after-revision",
      commercialTerms: {},
      completionPolicyId: "completion.default",
      disputePolicyId: "gaia.default",
    }),
    /not currently allowed by Baphomet/,
  );
});

test("Pact signatures and OpenRails metadata bind immutable terms rather than lifecycle state", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.terms",
    commercialTerms: { unit: "service" },
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  const before = kernel.preparePactSignature(pact);
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const accepted = await kernel.getPact(pact.pactId);
  assert.ok(accepted);
  const after = kernel.preparePactSignature(accepted!);
  assert.equal(before.hash, after.hash);
  assert.deepEqual(before.typedData.message, after.typedData.message);
  const binding = await kernel.openRailsMetadataBinding(pact.pactId);
  assert.equal(binding.descriptionHash, pact.termsHash);
  assert.equal(binding.salt, pact.termsHash);
});

test("Pact activation requires prepared parameters and a canonical chain verifier", async () => {
  const store = new MemoryKernelStore();
  const noChainKernel = new OpenRailsAgentKernel({ store, signatureVerifier: verifier, now });
  const preparedWorkspace = noChainKernel.prepareWorkspace({
    workspaceId: "workspace.nochain", workspaceType: "individual", displayName: "No chain", principalId: "principal.nochain", authorityAccount: authority, authorityType: "eoa",
  });
  await noChainKernel.registerWorkspace({ workspace: preparedWorkspace.workspace, signature });
  await assert.rejects(
    noChainKernel.bindOpenRailsPayment({
      pactId: "missing", metadataHash: hashCanonical("metadata"), paycardId: hashCanonical("paycard"), actor: authority, openingTxHash: hashCanonical("tx"),
    }),
    /Canonical OpenRails chain verifier is required/,
  );
});

test("checkpoint must bind the immutable Pact terms and canonical Paycard", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo", pactId: "pact.checkpoint-bind", commercialTerms: {}, completionPolicyId: "completion.default", disputePolicyId: "gaia.default", requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId, metadataHash: hashCanonical("metadata-bind"), paycardId: hashCanonical("paycard-bind"), actor: authority, genesisTimestamp: 1_722_165_000, nonceChannel: 0, nonceValue: 2,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId, metadataHash: hashCanonical("metadata-bind"), paycardId: hashCanonical("paycard-bind"), actor: authority, openingTxHash: hashCanonical("open-bind"),
  });
  const bad: ExecutionCheckpointV1 = {
    version: "openrails-work-checkpoint-v1", checkpointId: "checkpoint.bad-bind", workspaceId: pact.workspaceId, pactId: pact.pactId, pathId: pact.pathId, paycardId: hashCanonical("wrong-paycard"), termsHash: hashCanonical("wrong-terms"), actor: provider, counterparty: provider, checkpointIndex: 1, checkpointType: "progress", evidenceType: "hash", evidenceHash: hashCanonical("evidence"), observedAt: now().toISOString(), validUntil: "2026-07-28T12:05:00.000Z", submittedBy: provider, signature,
  };
  await assert.rejects(kernel.submitCheckpoint(bad), /terms hash mismatch/);
});


test("Workspace administrative commands are signed, nonce-protected, and payload-bound", async () => {
  const { kernel } = await setup();
  const payload = { workspaceId: "workspace.demo", agentId: "agent.demo", status: "paused" as const };
  const prepared = await kernel.prepareWorkspaceCommand({ workspaceId: "workspace.demo", operation: "set_agent_status", payload });
  await kernel.setAgentStatus({ ...payload, command: prepared.command, signature });
  await assert.rejects(
    kernel.setAgentStatus({ ...payload, status: "revoked", command: prepared.command, signature }),
    /payload hash mismatch|nonce mismatch/,
  );
});


test("canonical settlement recording requires verified opening and stores canonical evidence", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.settlement",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const metadataHash = hashCanonical("metadata-settlement");
  const paycardId = hashCanonical("paycard-settlement");
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash,
    paycardId,
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 3,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash,
    paycardId,
    actor: authority,
    openingTxHash: hashCanonical("opening-settlement"),
  });
  const settled = await kernel.recordPactSettlement({
    pactId: pact.pactId,
    actor: "canonical-observer",
    txHash: hashCanonical("settlement-tx"),
    settledAmountBaseUnits: "5000000",
    final: true,
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.openRails?.settlements?.length, 1);
  assert.equal(settled.openRails?.settlements?.[0]?.paycardId, paycardId);
  assert.equal(settled.openRails?.settlements?.[0]?.settledAmountBaseUnits, "5000000");

  const noChainKernel = new OpenRailsAgentKernel({ store: new MemoryKernelStore(), signatureVerifier: verifier, now });
  await assert.rejects(
    noChainKernel.recordPactSettlement({
      pactId: "missing",
      actor: "forged-observer",
      txHash: hashCanonical("forged-settlement"),
      settledAmountBaseUnits: "1",
      final: true,
    }),
    /Canonical OpenRails chain verifier is required/,
  );
});

test("Gaia claims reject invalid signatures and non-party bindings", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.gaia-adversarial",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const baseClaim = {
    workspaceId: pact.workspaceId,
    pactId: pact.pactId,
    pathId: pact.pathId,
    claimant: authority,
    respondent: provider,
    reasonCode: "EVIDENCE_CONFLICT",
    evidenceCommitments: [hashCanonical("gaia-adversarial-evidence")],
    paymentSnapshot: { observedAt: now().toISOString() },
    requestedRemedy: "manual review",
    resolutionPolicyId: "gaia.default",
    claimValidUntil: "2026-07-28T12:05:00.000Z",
  };

  await assert.rejects(
    kernel.openGaiaCase({
      ...baseClaim,
      caseId: "gaia.invalid-signature",
      claimSignature: `0x${"22".repeat(65)}` as Hex,
    }),
    /claim signature is invalid/,
  );

  await assert.rejects(
    kernel.openGaiaCase({
      ...baseClaim,
      caseId: "gaia.non-party",
      claimant: "0x4444444444444444444444444444444444444444" as Address,
      claimSignature: signature,
    }),
    /claimant is not a Pact party/,
  );

  await assert.rejects(
    kernel.openGaiaCase({
      ...baseClaim,
      caseId: "gaia.wrong-respondent",
      respondent: authority,
      claimSignature: signature,
    }),
    /respondent is not the opposing Pact party/,
  );
});

// second-security-review-adversarial-tests
test("replayed Pact signatures are idempotent and cannot regress lifecycle state", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.signature-replay",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  const recorded = await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const replay = await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  assert.equal(replay.signedAt, recorded.signedAt);
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("signature-replay-metadata"),
    paycardId: hashCanonical("signature-replay-paycard"),
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 11,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("signature-replay-metadata"),
    paycardId: hashCanonical("signature-replay-paycard"),
    actor: authority,
    openingTxHash: hashCanonical("signature-replay-opening"),
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  assert.equal((await kernel.getPact(pact.pactId))?.status, "active");
});

test("canonical openings count against the Path period limit", async () => {
  const { kernel, path } = await setup();
  const current = await kernel.getPath(path.pathId);
  await kernel.activatePath({
    path: {
      ...path,
      revision: 2,
      previousPathHash: current!.hash,
      limits: { ...path.limits, maxPerPeriodBaseUnits: "6000000" },
      updatedAt: "2026-07-28T12:01:00.000Z",
    },
    signature,
  });
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const first = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.period-first",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: first.pactId, signer: authority, signature });
  await kernel.bindOpenRailsPayment({
    pactId: first.pactId,
    metadataHash: hashCanonical("period-metadata"),
    paycardId: hashCanonical("period-paycard"),
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 12,
  });
  await kernel.bindOpenRailsPayment({
    pactId: first.pactId,
    metadataHash: hashCanonical("period-metadata"),
    paycardId: hashCanonical("period-paycard"),
    actor: authority,
    openingTxHash: hashCanonical("period-opening"),
  });
  await kernel.submitProposal(proposal({
    proposalId: "proposal.period-second",
    idempotencyKey: "proposal-period-second",
    requestedAllocationBaseUnits: "2000000",
  }));
  const job = await kernel.runNextJob();
  assert.equal(job?.state, "blocked");
  assert.ok((await kernel.listBlockedActions("workspace.demo")).some((entry) => entry.reasonCodes.includes("PERIOD_LIMIT_EXCEEDED")));
});

test("completed but unsettled Pacts continue reserving active exposure", async () => {
  const { kernel, path } = await setup();
  const current = await kernel.getPath(path.pathId);
  await kernel.activatePath({
    path: {
      ...path,
      revision: 2,
      previousPathHash: current!.hash,
      limits: { ...path.limits, maxActiveExposureBaseUnits: "6000000" },
      updatedAt: "2026-07-28T12:01:00.000Z",
    },
    signature,
  });
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.completed-exposure",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const paycardId = hashCanonical("completed-exposure-paycard");
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("completed-exposure-metadata"),
    paycardId,
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 13,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("completed-exposure-metadata"),
    paycardId,
    actor: authority,
    openingTxHash: hashCanonical("completed-exposure-opening"),
  });
  const checkpoint: ExecutionCheckpointV1 = {
    version: "openrails-work-checkpoint-v1",
    checkpointId: "checkpoint.completed-exposure",
    workspaceId: pact.workspaceId,
    pactId: pact.pactId,
    pathId: pact.pathId,
    paycardId,
    termsHash: pact.termsHash,
    actor: provider,
    counterparty: provider,
    checkpointIndex: 1,
    checkpointType: "completed",
    evidenceType: "hash",
    evidenceHash: hashCanonical("completed-exposure-evidence"),
    observedAt: now().toISOString(),
    validUntil: "2026-07-28T12:05:00.000Z",
    submittedBy: provider,
    signature,
  };
  await kernel.submitCheckpoint(checkpoint);
  await kernel.verifyCheckpoint({ checkpointId: checkpoint.checkpointId, pluginId: pact.evidencePolicyId, pluginVersion: pact.evidencePolicyVersion });
  assert.equal((await kernel.getPact(pact.pactId))?.status, "completed");
  await kernel.submitProposal(proposal({
    proposalId: "proposal.after-completion",
    idempotencyKey: "proposal-after-completion",
    requestedAllocationBaseUnits: "2000000",
  }));
  const job = await kernel.runNextJob();
  assert.equal(job?.state, "blocked");
  assert.ok((await kernel.listBlockedActions("workspace.demo")).some((entry) => entry.reasonCodes.includes("ACTIVE_EXPOSURE_EXCEEDED")));
});

test("payment preparation fails when the Pact Path is revised", async () => {
  const { kernel, path } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.execution-eligibility",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const current = await kernel.getPath(path.pathId);
  await kernel.activatePath({
    path: { ...path, revision: 2, previousPathHash: current!.hash, updatedAt: "2026-07-28T12:02:00.000Z" },
    signature,
  });
  await assert.rejects(kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("eligibility-metadata"),
    paycardId: hashCanonical("eligibility-paycard"),
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 14,
  }), /stale Path revision/);
});

test("Pact verification policy snapshots plugin version and digest", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.proof-snapshot",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  assert.equal(pact.evidencePolicyId, "proof.hash");
  assert.equal(pact.evidencePolicyVersion, "1.0.0");
  assert.equal(pact.evidencePolicyCodeDigest, hashCanonical("hash-proof-v1"));
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const paycardId = hashCanonical("proof-snapshot-paycard");
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("proof-snapshot-metadata"),
    paycardId,
    actor: authority,
    genesisTimestamp: 1_722_165_000,
    nonceChannel: 0,
    nonceValue: 15,
  });
  await kernel.bindOpenRailsPayment({
    pactId: pact.pactId,
    metadataHash: hashCanonical("proof-snapshot-metadata"),
    paycardId,
    actor: authority,
    openingTxHash: hashCanonical("proof-snapshot-opening"),
  });
  const checkpoint: ExecutionCheckpointV1 = {
    version: "openrails-work-checkpoint-v1",
    checkpointId: "checkpoint.proof-snapshot",
    workspaceId: pact.workspaceId,
    pactId: pact.pactId,
    pathId: pact.pathId,
    paycardId,
    termsHash: pact.termsHash,
    actor: provider,
    counterparty: provider,
    checkpointIndex: 1,
    checkpointType: "progress",
    evidenceType: "hash",
    evidenceHash: hashCanonical("proof-snapshot-evidence"),
    observedAt: now().toISOString(),
    validUntil: "2026-07-28T12:05:00.000Z",
    submittedBy: provider,
    signature,
  };
  await kernel.submitCheckpoint(checkpoint);
  await assert.rejects(
    kernel.verifyCheckpoint({ checkpointId: checkpoint.checkpointId, pluginId: "proof.hash", pluginVersion: "2.0.0" }),
    /immutable Pact evidence policy/,
  );
});

test("Gaia residual closure creates an obligation and cannot close the Pact offchain", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await kernel.runNextJob();
  const pact = await kernel.createPactFromProposal({
    proposalId: "proposal.demo",
    pactId: "pact.gaia-closure",
    commercialTerms: {},
    completionPolicyId: "completion.default",
    disputePolicyId: "gaia.default",
    requiresCounterpartySignature: false,
  });
  await kernel.signPact({ pactId: pact.pactId, signer: authority, signature });
  const gaia = await kernel.openGaiaCase({
    caseId: "gaia.closure",
    workspaceId: pact.workspaceId,
    pactId: pact.pactId,
    pathId: pact.pathId,
    claimant: authority,
    respondent: provider,
    reasonCode: "CLOSE_REQUIRED",
    evidenceCommitments: [hashCanonical("gaia-closure-evidence")],
    paymentSnapshot: { observedAt: now().toISOString() },
    requestedRemedy: "close residual",
    resolutionPolicyId: "gaia.default",
    claimValidUntil: "2026-07-28T12:05:00.000Z",
    claimSignature: signature,
  });
  const payload = {
    caseId: gaia.caseId,
    resolver: authority,
    decision: "close_and_return_residual" as const,
    resolutionSummary: "Request canonical Paycard closure.",
    rectificationTerms: {},
  };
  const command = await kernel.prepareWorkspaceCommand({ workspaceId: pact.workspaceId, operation: "resolve_gaia", payload });
  const result = await kernel.resolveGaiaCase({ ...payload, command: command.command, signature });
  assert.equal(result.gaiaCase.status, "rectification_required");
  assert.equal(result.obligation?.remedyType, "manual_action");
  assert.equal((await kernel.getPact(pact.pactId))?.status, "rectification_required");
});

test("Path revisions cannot transfer Workspace, owner, or authority", async () => {
  const { kernel, path } = await setup();
  const current = await kernel.getPath(path.pathId);
  await assert.rejects(kernel.activatePath({
    path: {
      ...path,
      owner: provider,
      revision: 2,
      previousPathHash: current!.hash,
      updatedAt: "2026-07-28T12:03:00.000Z",
    },
    signature,
  }), /owner cannot change|active Workspace owner/);
});

test("Proposal IDs are immutable independently of idempotency keys", async () => {
  const { kernel } = await setup();
  await kernel.submitProposal(proposal());
  await assert.rejects(kernel.submitProposal(proposal({
    idempotencyKey: "different-idempotency-key",
    requestedDurationSeconds: 601,
  })), /Proposal ID already exists/);
});

test("Agent Kernel V1 rejects non-EOA Workspace authority modes", async () => {
  const kernel = new OpenRailsAgentKernel({ store: new MemoryKernelStore(), signatureVerifier: verifier, now });
  assert.throws(() => kernel.prepareWorkspace({
    workspaceId: "workspace.smart",
    workspaceType: "organization",
    displayName: "Smart Workspace",
    principalId: "principal.smart",
    authorityAccount: authority,
    authorityType: "smart-account",
  }), /EOA Workspace authorities only/);
});
