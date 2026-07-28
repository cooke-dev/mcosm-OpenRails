import test from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, MemoryKernelStore, OpenRailsAgentKernel, VerificationPluginRegistry, createHashEqualityPlugin, hashCanonical, } from "../src/index.js";
const authority = "0x1111111111111111111111111111111111111111";
const agentOperator = "0x2222222222222222222222222222222222222222";
const provider = "0x3333333333333333333333333333333333333333";
const token = "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De";
const signature = `0x${"11".repeat(65)}`;
const verifier = { async verify(input) { return input.signature === signature; } };
const now = () => new Date("2026-07-28T12:00:00.000Z");
async function setup() {
    const store = new MemoryKernelStore();
    const plugins = new VerificationPluginRegistry();
    const kernel = new OpenRailsAgentKernel({
        store,
        signatureVerifier: verifier,
        actionRegistry: new ActionRegistry(),
        pluginRegistry: plugins,
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
    const manifest = {
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
    plugins.bind(createHashEqualityPlugin(manifest));
    await kernel.installPlugin(manifest, authority);
    const path = {
        version: "openrails-path-v1",
        pathId: "path.demo",
        workspaceId: "workspace.demo",
        owner: authority,
        authorityAccount: authority,
        authorizedAgentIds: ["agent.demo"],
        permittedActions: ["prepare_railsflow", "create_pact_proposal", "submit_checkpoint", "open_gaia_request"],
        permittedAssets: [token],
        permittedCounterparties: [provider],
        identityRequirements: [{ provider: "dojang", requirement: "verified-address", required: true, nameService: "up.id" }],
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
function proposal(overrides = {}) {
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
        counterparty: provider,
        initiator: authority,
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
        openingTxHash: hashCanonical("open-tx"),
    });
    assert.equal((await kernel.getPact(pact.pactId))?.status, "active");
    const checkpoint = {
        version: "openrails-work-checkpoint-v1",
        checkpointId: "checkpoint.demo",
        workspaceId: "workspace.demo",
        pactId: pact.pactId,
        pathId: "path.demo",
        paycardId: hashCanonical("paycard"),
        actor: provider,
        counterparty: provider,
        checkpointIndex: 1,
        checkpointType: "completed",
        evidenceType: "hash",
        evidenceHash: hashCanonical("work-result"),
        observedAt: now().toISOString(),
        submittedBy: provider,
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
    await assert.rejects(kernel.activatePath({ path: { ...path, revision: 2, previousPathHash: hashCanonical("wrong") }, signature }), /previous hash mismatch/);
    const revised = {
        ...path,
        revision: 2,
        previousPathHash: current.hash,
        limits: { ...path.limits, maxPerPactBaseUnits: "12000000" },
        updatedAt: "2026-07-28T12:01:00.000Z",
    };
    const signed = await kernel.activatePath({ path: revised, signature });
    assert.equal(signed.artifact.revision, 2);
});
test("revoked Agent cannot pass Baphomet", async () => {
    const { kernel } = await setup();
    await kernel.setAgentStatus({ workspaceId: "workspace.demo", agentId: "agent.demo", status: "revoked", authoritySigner: authority });
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
        counterparty: provider,
        initiator: authority,
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
    });
    assert.equal(gaia.status, "open");
    const resolved = await kernel.resolveGaiaCase({
        caseId: gaia.caseId,
        resolver: authority,
        decision: "replacement_pact",
        resolutionSummary: "Create replacement Pact after residual closure.",
        rectificationTerms: { preserveAccruedSettlement: true },
    });
    assert.equal(resolved.gaiaCase.status, "rectification_required");
    assert.equal(resolved.obligation?.remedyType, "replacement_pact");
});
test("idempotency rejects reused keys with different payloads", async () => {
    const { kernel } = await setup();
    await kernel.submitProposal(proposal());
    await assert.rejects(kernel.submitProposal(proposal({ proposalId: "proposal.changed", requestedDurationSeconds: 601 })), /idempotency conflict/);
});
test("authority mode prevents preparation when a Path is only propose", async () => {
    const { kernel, path } = await setup();
    const current = await kernel.getPath(path.pathId);
    const revised = {
        ...path,
        authorityMode: "propose",
        revision: 2,
        previousPathHash: current.hash,
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
        counterparty: provider,
        initiator: authority,
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
            previousPathHash: current.hash,
            updatedAt: "2026-07-28T12:03:00.000Z",
        },
        signature,
    });
    await assert.rejects(kernel.openRailsMetadataBinding("pact.stale"), /stale Path revision/);
});
