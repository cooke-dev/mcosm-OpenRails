import { assertAddress, assertHex32, canonicalJson, clone, hashCanonical, nowIso, parseBaseUnits, parseIso, sha256Hex, stableId, } from "./canonical.js";
import { ActionRegistry } from "./actionRegistry.js";
import { evaluateProposal } from "./evaluator.js";
import { VerificationPluginRegistry } from "./plugins.js";
import { agentRegistrationTypedData, pactTypedData, pathTypedData, workspaceTypedData, verificationPluginTypedData, } from "./typedData.js";
function requireWorkspace(state, workspaceId) {
    const workspace = state.workspaces[workspaceId];
    if (!workspace)
        throw new Error("Workspace not found");
    return workspace;
}
function requireAgent(state, agentId) {
    const agent = state.agents[agentId];
    if (!agent)
        throw new Error("Agent not found");
    return agent;
}
function requirePath(state, pathId) {
    const path = state.paths[pathId];
    if (!path)
        throw new Error("Path not found");
    return path;
}
function requirePact(state, pactId) {
    const pact = state.pacts[pactId];
    if (!pact)
        throw new Error("Pact not found");
    return pact;
}
function assertAuthority(workspace, signer) {
    if (workspace.authorityAccount.toLowerCase() !== signer.toLowerCase())
        throw new Error("Workspace authority mismatch");
}
function assertRevision(actual, expected, label) {
    if (actual !== expected)
        throw new Error(`${label} revision conflict: expected ${expected}, found ${actual}`);
}
function event(state, input) {
    state.events.push({
        version: "openrails-kernel-event-v1",
        eventId: stableId("event", { ...input, sequence: state.events.length }),
        ...input,
    });
}
function pactEvent(state, pact, type, actor, data, at) {
    const sequence = state.pactEvents.filter((entry) => entry.pactId === pact.pactId).length;
    const value = {
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
function assertWorkspaceId(value) {
    if (!/^[A-Za-z0-9._:-]{3,96}$/.test(value))
        throw new Error("invalid Workspace ID");
}
function assertDomainId(value, label) {
    if (!/^[A-Za-z0-9._:-]{3,128}$/.test(value))
        throw new Error(`invalid ${label}`);
}
function assertPath(path) {
    assertDomainId(path.pathId, "Path ID");
    assertWorkspaceId(path.workspaceId);
    assertAddress(path.owner, "Path owner");
    assertAddress(path.authorityAccount, "Path authority");
    if (path.revision < 1 || !Number.isSafeInteger(path.revision))
        throw new Error("Path revision must be positive");
    if (parseIso(path.validFrom, "Path validFrom") >= parseIso(path.expiresAt, "Path expiresAt"))
        throw new Error("Path validity window is invalid");
    parseBaseUnits(path.limits.maxPerPactBaseUnits, "maxPerPactBaseUnits", false);
    parseBaseUnits(path.limits.maxActiveExposureBaseUnits, "maxActiveExposureBaseUnits", false);
    parseBaseUnits(path.limits.maxPerPeriodBaseUnits, "maxPerPeriodBaseUnits", false);
    parseBaseUnits(path.limits.maxVelocityBaseUnitsPerSecond, "maxVelocityBaseUnitsPerSecond", false);
    if (!Number.isSafeInteger(path.limits.periodSeconds) || path.limits.periodSeconds <= 0)
        throw new Error("periodSeconds must be positive");
    if (!Number.isSafeInteger(path.limits.maxDurationSeconds) || path.limits.maxDurationSeconds <= 0)
        throw new Error("maxDurationSeconds must be positive");
    if (!Number.isSafeInteger(path.limits.maxConcurrentPacts) || path.limits.maxConcurrentPacts <= 0)
        throw new Error("maxConcurrentPacts must be positive");
    if (path.authorizedAgentIds.length === 0)
        throw new Error("Path requires at least one authorized Agent");
    if (path.permittedActions.length === 0)
        throw new Error("Path requires permitted actions");
    if (path.permittedAssets.length === 0)
        throw new Error("Path requires permitted assets");
}
function assertPact(pact) {
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
    if (!Number.isSafeInteger(pact.paymentTerms.lifespanSeconds) || pact.paymentTerms.lifespanSeconds <= 0)
        throw new Error("Pact lifespan must be positive");
}
export class OpenRailsAgentKernel {
    options;
    actions;
    plugins;
    now;
    constructor(options) {
        this.options = options;
        this.actions = options.actionRegistry ?? new ActionRegistry();
        this.plugins = options.pluginRegistry ?? new VerificationPluginRegistry();
        this.now = options.now ?? (() => new Date());
    }
    async state() { return this.options.store.load(); }
    prepareWorkspace(input) {
        assertWorkspaceId(input.workspaceId);
        assertAddress(input.authorityAccount, "Workspace authority");
        const at = nowIso(this.now);
        const workspace = {
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
    async registerWorkspace(input) {
        const typedData = workspaceTypedData(input.workspace);
        const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.workspace.authorityAccount });
        if (!valid)
            throw new Error("Workspace authority signature is invalid");
        return this.options.store.transact((state) => {
            if (state.workspaces[input.workspace.workspaceId])
                throw new Error("Workspace already exists");
            state.workspaces[input.workspace.workspaceId] = clone(input.workspace);
            const artifact = {
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
    prepareAgentRegistration(input) {
        assertDomainId(input.agentId, "Agent ID");
        assertAddress(input.operator, "Agent operator");
        const agent = {
            version: "openrails-agent-identity-v1",
            ...input,
            assignedPathIds: input.assignedPathIds ?? [],
            status: "active",
            createdAt: nowIso(this.now),
            revision: 1,
        };
        return { agent, hash: hashCanonical(agent), typedData: agentRegistrationTypedData(agent) };
    }
    async registerAgent(input) {
        return this.options.store.transact(async (state) => {
            const workspace = requireWorkspace(state, input.agent.workspaceId);
            assertAuthority(workspace, input.authoritySigner);
            if (state.agents[input.agent.agentId])
                throw new Error("Agent already exists");
            const typedData = agentRegistrationTypedData(input.agent);
            const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.authoritySigner });
            if (!valid)
                throw new Error("Agent registration signature is invalid");
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
    async setAgentStatus(input) {
        return this.options.store.transact((state) => {
            const workspace = requireWorkspace(state, input.workspaceId);
            assertAuthority(workspace, input.authoritySigner);
            const agent = requireAgent(state, input.agentId);
            if (agent.workspaceId !== workspace.workspaceId)
                throw new Error("Agent Workspace mismatch");
            agent.status = input.status;
            agent.revision += 1;
            event(state, { workspaceId: workspace.workspaceId, subjectType: "agent", subjectId: agent.agentId, type: `AGENT_${input.status.toUpperCase()}`, actor: input.authoritySigner, at: nowIso(this.now), data: { revision: agent.revision } });
            return agent;
        });
    }
    preparePath(path) {
        assertPath(path);
        return { path: clone(path), hash: hashCanonical(path), typedData: pathTypedData(path) };
    }
    async activatePath(input) {
        assertPath(input.path);
        const typedData = pathTypedData(input.path);
        const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.path.authorityAccount });
        if (!valid)
            throw new Error("Path authority signature is invalid");
        return this.options.store.transact((state) => {
            const workspace = requireWorkspace(state, input.path.workspaceId);
            assertAuthority(workspace, input.path.authorityAccount);
            for (const agentId of input.path.authorizedAgentIds) {
                const agent = requireAgent(state, agentId);
                if (agent.workspaceId !== workspace.workspaceId || agent.status !== "active")
                    throw new Error(`Agent ${agentId} is not active in this Workspace`);
            }
            const existing = state.paths[input.path.pathId];
            if (existing) {
                assertRevision(input.path.revision, existing.artifact.revision + 1, "Path");
                if (input.path.previousPathHash !== existing.hash)
                    throw new Error("Path previous hash mismatch");
            }
            else if (input.path.revision !== 1)
                throw new Error("New Path revision must be 1");
            const signed = {
                artifact: clone(input.path),
                hash: hashCanonical(input.path),
                typedData,
                signer: input.path.authorityAccount,
                signature: input.signature,
                signedAt: nowIso(this.now),
            };
            state.paths[input.path.pathId] = signed;
            for (const agentId of input.path.authorizedAgentIds) {
                const agent = state.agents[agentId];
                if (!agent.assignedPathIds.includes(input.path.pathId))
                    agent.assignedPathIds.push(input.path.pathId);
            }
            event(state, { workspaceId: workspace.workspaceId, subjectType: "path", subjectId: input.path.pathId, type: existing ? "PATH_REVISED" : "PATH_ACTIVATED", actor: input.path.authorityAccount, at: signed.signedAt, data: { revision: input.path.revision, pathHash: signed.hash } });
            return signed;
        });
    }
    async submitProposal(proposal) {
        assertDomainId(proposal.proposalId, "Proposal ID");
        const fingerprint = hashCanonical(proposal);
        return this.options.store.transact((state) => {
            const idempotencyKey = `${proposal.workspaceId}:proposal:${proposal.idempotencyKey}`;
            const previous = state.idempotency[idempotencyKey];
            if (previous) {
                if (previous.fingerprint !== fingerprint)
                    throw new Error("idempotency conflict");
                const previousProposal = state.proposals[proposal.proposalId];
                const previousJob = Object.values(state.jobs).find((entry) => entry.proposalId === proposal.proposalId);
                if (!previousProposal || !previousJob)
                    throw new Error("idempotency record is inconsistent");
                return { proposal: previousProposal, job: previousJob };
            }
            state.proposals[proposal.proposalId] = clone(proposal);
            const at = nowIso(this.now);
            const job = {
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
    async runNextJob(workerId = "openrails-kernel-worker") {
        const state = await this.options.store.load();
        const candidate = Object.values(state.jobs).find((job) => job.state === "queued");
        if (!candidate)
            return undefined;
        return this.options.store.transact(async (draft) => {
            const job = draft.jobs[candidate.jobId];
            if (!job || job.state !== "queued")
                return job;
            job.state = "running";
            job.attempts += 1;
            job.lockedBy = workerId;
            job.lockUntil = new Date(this.now().getTime() + 60_000).toISOString();
            job.updatedAt = nowIso(this.now);
            try {
                if (job.kind !== "evaluate_proposal")
                    throw new Error(`unsupported job kind ${job.kind}`);
                const proposal = draft.proposals[job.proposalId];
                if (!proposal)
                    throw new Error("proposal is missing");
                const evaluatorOptions = {
                    actionRegistry: this.actions,
                    now: this.now,
                    ...(this.options.identityResolver ? { identityResolver: this.options.identityResolver } : {}),
                };
                const { decision, identity } = await evaluateProposal(draft, proposal, evaluatorOptions);
                draft.decisions[decision.decisionId] = decision;
                if (decision.result === "BLOCK") {
                    const blocked = {
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
                }
                else if (decision.result === "REVIEW") {
                    job.state = "review";
                    job.result = { decisionId: decision.decisionId };
                }
                else {
                    job.state = "completed";
                    job.result = { decisionId: decision.decisionId, ...(identity ? { identity } : {}) };
                }
                job.updatedAt = nowIso(this.now);
                event(draft, { workspaceId: proposal.workspaceId, subjectType: "proposal", subjectId: proposal.proposalId, type: `BAPHOMET_${decision.result}`, actor: "baphomet", at: decision.evaluatedAt, data: { decisionId: decision.decisionId, reasonCodes: decision.reasonCodes } });
            }
            catch (error) {
                job.state = "failed";
                job.error = error instanceof Error ? error.message : String(error);
                job.updatedAt = nowIso(this.now);
            }
            return job;
        });
    }
    async createPactFromProposal(input) {
        return this.options.store.transact((state) => {
            const proposal = state.proposals[input.proposalId];
            if (!proposal)
                throw new Error("Proposal not found");
            const decision = Object.values(state.decisions).find((entry) => entry.proposalId === proposal.proposalId);
            if (!decision || decision.result !== "ALLOW")
                throw new Error("Proposal is not allowed by Baphomet");
            const signedPath = requirePath(state, proposal.pathId);
            if (state.pacts[input.pactId])
                throw new Error("Pact already exists");
            const at = nowIso(this.now);
            const pact = {
                version: "openrails-pact-v1",
                pactId: input.pactId,
                workspaceId: proposal.workspaceId,
                pathId: proposal.pathId,
                pathRevision: signedPath.artifact.revision,
                pathHash: signedPath.hash,
                initiator: input.initiator,
                agentId: proposal.agentId,
                counterparty: input.counterparty,
                actionType: proposal.actionType,
                specification: clone(proposal.specification),
                commercialTerms: clone(input.commercialTerms),
                paymentTerms: {
                    chainId: 91_342,
                    vault: "0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1",
                    token: proposal.asset,
                    payer: input.initiator,
                    recipient: input.counterparty,
                    maximumAllocationBaseUnits: proposal.requestedAllocationBaseUnits,
                    velocityBaseUnitsPerSecond: proposal.requestedVelocityBaseUnitsPerSecond,
                    lifespanSeconds: proposal.requestedDurationSeconds,
                    residualRecipient: input.initiator,
                },
                evidencePolicyId: proposal.evidencePolicyId,
                completionPolicyId: input.completionPolicyId,
                disputePolicyId: input.disputePolicyId,
                requiresCounterpartySignature: input.requiresCounterpartySignature ?? true,
                status: "awaiting_signatures",
                revision: 1,
                createdAt: at,
                updatedAt: at,
            };
            assertPact(pact);
            state.pacts[pact.pactId] = pact;
            state.pactSignatures[pact.pactId] = [];
            pactEvent(state, pact, "PACT_CREATED", proposal.agentId, { proposalId: proposal.proposalId, decisionId: decision.decisionId, pactHash: hashCanonical(pact) }, at);
            return pact;
        });
    }
    preparePactSignature(pact) {
        assertPact(pact);
        return { pact: clone(pact), hash: hashCanonical(pact), typedData: pactTypedData(pact) };
    }
    async signPact(input) {
        return this.options.store.transact(async (state) => {
            const pact = requirePact(state, input.pactId);
            const workspace = requireWorkspace(state, pact.workspaceId);
            const allowed = input.signer.toLowerCase() === workspace.authorityAccount.toLowerCase() || input.signer.toLowerCase() === pact.counterparty.toLowerCase();
            if (!allowed)
                throw new Error("Pact signer is neither Workspace authority nor counterparty");
            const typedData = pactTypedData(pact);
            const valid = await this.options.signatureVerifier.verify({ typedData, signature: input.signature, expectedSigner: input.signer });
            if (!valid)
                throw new Error("Pact signature is invalid");
            const signed = { artifact: clone(pact), hash: hashCanonical(pact), typedData, signer: input.signer, signature: input.signature, signedAt: nowIso(this.now) };
            const signatures = state.pactSignatures[pact.pactId] ?? [];
            if (!signatures.some((entry) => entry.signer.toLowerCase() === input.signer.toLowerCase()))
                signatures.push(signed);
            state.pactSignatures[pact.pactId] = signatures;
            const authoritySigned = signatures.some((entry) => entry.signer.toLowerCase() === workspace.authorityAccount.toLowerCase());
            const counterpartySigned = signatures.some((entry) => entry.signer.toLowerCase() === pact.counterparty.toLowerCase());
            if (authoritySigned && (!pact.requiresCounterpartySignature || counterpartySigned)) {
                pact.status = "accepted";
                pact.revision += 1;
                pact.updatedAt = nowIso(this.now);
                pactEvent(state, pact, "PACT_ACCEPTED", input.signer, { pactHash: signed.hash, signers: signatures.map((entry) => entry.signer) }, pact.updatedAt);
            }
            else {
                pactEvent(state, pact, "PACT_SIGNATURE_ADDED", input.signer, { pactHash: signed.hash }, signed.signedAt);
            }
            return signed;
        });
    }
    async bindOpenRailsPayment(input) {
        assertHex32(input.metadataHash, "metadataHash");
        assertHex32(input.paycardId, "paycardId");
        if (input.openingTxHash)
            assertHex32(input.openingTxHash, "openingTxHash");
        return this.options.store.transact((state) => {
            const pact = requirePact(state, input.pactId);
            if (!['accepted', 'payment_prepared', 'awaiting_wallet'].includes(pact.status))
                throw new Error("Pact is not ready for OpenRails binding");
            pact.openRails = {
                metadataHash: input.metadataHash,
                paycardId: input.paycardId,
                ...(input.openingTxHash ? { openingTxHash: input.openingTxHash } : {}),
            };
            pact.status = input.openingTxHash ? "active" : "payment_prepared";
            pact.revision += 1;
            pact.updatedAt = nowIso(this.now);
            pactEvent(state, pact, input.openingTxHash ? "PAYMENT_OPENED" : "PAYMENT_PREPARED", input.actor, {
                metadataHash: input.metadataHash,
                paycardId: input.paycardId,
                allocationBaseUnits: pact.paymentTerms.maximumAllocationBaseUnits,
                ...(input.openingTxHash ? { openingTxHash: input.openingTxHash } : {}),
            }, pact.updatedAt);
            return pact;
        });
    }
    async installPlugin(manifest, authoritySigner) {
        assertHex32(manifest.codeDigest, "plugin codeDigest");
        if (manifest.installedWorkspaceIds.length !== 1)
            throw new Error("V1 plugin installation must target exactly one Workspace");
        const publisherValid = await this.options.signatureVerifier.verify({
            typedData: verificationPluginTypedData(manifest),
            signature: manifest.publisherSignature,
            expectedSigner: manifest.publisher,
        });
        if (!publisherValid)
            throw new Error("plugin publisher signature is invalid");
        return this.options.store.transact((state) => {
            const workspace = requireWorkspace(state, manifest.installedWorkspaceIds[0]);
            assertAuthority(workspace, authoritySigner);
            const key = this.plugins.key(manifest.pluginId, manifest.pluginVersion);
            const existing = state.plugins[key];
            if (existing && existing.codeDigest !== manifest.codeDigest)
                throw new Error("plugin version digest conflict");
            state.plugins[key] = clone(manifest);
            event(state, { workspaceId: workspace.workspaceId, subjectType: "plugin", subjectId: key, type: "PLUGIN_INSTALLED", actor: authoritySigner, at: nowIso(this.now), data: { codeDigest: manifest.codeDigest, publisher: manifest.publisher } });
            return manifest;
        });
    }
    async submitCheckpoint(checkpoint) {
        assertHex32(checkpoint.evidenceHash, "checkpoint evidenceHash");
        return this.options.store.transact((state) => {
            const pact = requirePact(state, checkpoint.pactId);
            if (pact.workspaceId !== checkpoint.workspaceId || pact.pathId !== checkpoint.pathId)
                throw new Error("checkpoint Pact binding mismatch");
            if (!["active", "performing", "disputed"].includes(pact.status))
                throw new Error("Pact is not accepting checkpoints");
            if (state.checkpoints[checkpoint.checkpointId])
                throw new Error("checkpoint already exists");
            state.checkpoints[checkpoint.checkpointId] = clone(checkpoint);
            if (pact.status === "active")
                pact.status = "performing";
            pact.revision += 1;
            pact.updatedAt = nowIso(this.now);
            pactEvent(state, pact, "CHECKPOINT_SUBMITTED", checkpoint.submittedBy, { checkpointId: checkpoint.checkpointId, checkpointType: checkpoint.checkpointType, evidenceHash: checkpoint.evidenceHash }, checkpoint.observedAt);
            return checkpoint;
        });
    }
    async verifyCheckpoint(input) {
        return this.options.store.transact(async (state) => {
            const checkpoint = state.checkpoints[input.checkpointId];
            if (!checkpoint)
                throw new Error("checkpoint not found");
            const pact = requirePact(state, checkpoint.pactId);
            const signedPath = requirePath(state, pact.pathId);
            const allowed = signedPath.artifact.approvedVerificationPlugins.some((entry) => entry.pluginId === input.pluginId && entry.version === input.pluginVersion);
            if (!allowed)
                throw new Error("plugin is not approved by the Pact Path");
            const decision = await this.plugins.evaluate({ state, checkpoint, pluginId: input.pluginId, pluginVersion: input.pluginVersion, now: this.now });
            state.verificationDecisions[decision.decisionId] = decision;
            pactEvent(state, pact, `CHECKPOINT_${decision.decision.toUpperCase()}`, `plugin:${input.pluginId}`, { checkpointId: checkpoint.checkpointId, decisionId: decision.decisionId, reasonCodes: decision.reasonCodes }, decision.evaluatedAt);
            if (decision.decision === "rejected") {
                pact.status = "disputed";
                pact.revision += 1;
                pact.updatedAt = decision.evaluatedAt;
            }
            else if (decision.decision === "approved" && checkpoint.checkpointType === "completed") {
                pact.status = "completed";
                pact.revision += 1;
                pact.updatedAt = decision.evaluatedAt;
            }
            return decision;
        });
    }
    async openGaiaCase(input) {
        return this.options.store.transact((state) => {
            const pact = requirePact(state, input.pactId);
            if (pact.workspaceId !== input.workspaceId || pact.pathId !== input.pathId)
                throw new Error("Gaia Pact binding mismatch");
            if (state.gaiaCases[input.caseId])
                throw new Error("Gaia case already exists");
            const at = nowIso(this.now);
            const value = { version: "openrails-gaia-case-v1", ...input, status: "open", createdAt: at, updatedAt: at };
            state.gaiaCases[value.caseId] = value;
            pact.status = "disputed";
            pact.revision += 1;
            pact.updatedAt = at;
            pactEvent(state, pact, "GAIA_CASE_OPENED", input.claimant, { caseId: value.caseId, reasonCode: value.reasonCode, requestedRemedy: value.requestedRemedy }, at);
            return value;
        });
    }
    async resolveGaiaCase(input) {
        return this.options.store.transact((state) => {
            const gaia = state.gaiaCases[input.caseId];
            if (!gaia)
                throw new Error("Gaia case not found");
            const workspace = requireWorkspace(state, gaia.workspaceId);
            const resolverMember = workspace.members.find((member) => member.address.toLowerCase() === input.resolver.toLowerCase() && member.status === "active" && member.roles.some((role) => role === "owner" || role === "gaia_resolver"));
            if (!resolverMember)
                throw new Error("resolver lacks Gaia authority");
            const pact = requirePact(state, gaia.pactId);
            gaia.decision = input.decision;
            gaia.resolutionSummary = input.resolutionSummary;
            gaia.updatedAt = nowIso(this.now);
            let obligation;
            if (["replacement_pact", "compensating_pact"].includes(input.decision)) {
                gaia.status = "rectification_required";
                pact.status = "rectification_required";
                const remedyType = input.decision === "replacement_pact" ? "replacement_pact" : "compensating_pact";
                const nextObligation = {
                    version: "openrails-rectification-obligation-v1",
                    obligationId: stableId("rectify", { caseId: gaia.caseId, decision: input.decision }),
                    caseId: gaia.caseId,
                    pactId: gaia.pactId,
                    workspaceId: gaia.workspaceId,
                    obligor: gaia.respondent,
                    beneficiary: gaia.claimant,
                    remedyType,
                    terms: clone(input.rectificationTerms ?? {}),
                    status: "open",
                    createdAt: gaia.updatedAt,
                };
                obligation = nextObligation;
                state.rectifications[nextObligation.obligationId] = nextObligation;
            }
            else {
                gaia.status = input.decision === "dismiss" ? "dismissed" : "resolved";
                pact.status = input.decision === "close_and_return_residual" ? "closed" : pact.status;
            }
            pact.revision += 1;
            pact.updatedAt = gaia.updatedAt;
            pactEvent(state, pact, "GAIA_RESOLVED", input.resolver, { caseId: gaia.caseId, decision: input.decision, ...(obligation ? { obligationId: obligation.obligationId } : {}) }, gaia.updatedAt);
            return obligation ? { gaiaCase: gaia, obligation } : { gaiaCase: gaia };
        });
    }
    async openRailsMetadataBinding(pactId) {
        const state = await this.state();
        const pact = requirePact(state, pactId);
        const path = requirePath(state, pact.pathId);
        if (path.hash !== pact.pathHash || path.artifact.revision !== pact.pathRevision)
            throw new Error("Pact is bound to a stale Path revision");
        const pactHash = hashCanonical(pact);
        const evidencePolicyHash = hashCanonical({ evidencePolicyId: pact.evidencePolicyId });
        return {
            workflowId: pact.pactId,
            metadataRef: `orpk1:${pact.pathRevision}:${pact.pathHash.slice(2)}:${evidencePolicyHash.slice(2)}`,
            descriptionHash: pactHash,
            salt: pactHash,
            pathHash: pact.pathHash,
            pactHash,
        };
    }
    async recordPactSettlement(input) {
        assertHex32(input.txHash, "settlement txHash");
        parseBaseUnits(input.settledAmountBaseUnits, "settled amount", false);
        return this.options.store.transact((state) => {
            const pact = requirePact(state, input.pactId);
            pact.status = input.final ? "settled" : pact.status;
            pact.revision += 1;
            pact.updatedAt = nowIso(this.now);
            pactEvent(state, pact, input.final ? "PACT_SETTLED" : "SETTLEMENT_CONFIRMED", input.actor, { txHash: input.txHash, settledAmountBaseUnits: input.settledAmountBaseUnits }, pact.updatedAt);
            return pact;
        });
    }
    async getWorkspace(workspaceId) { return clone((await this.state()).workspaces[workspaceId]); }
    async getAgent(agentId) { return clone((await this.state()).agents[agentId]); }
    async getPath(pathId) { return clone((await this.state()).paths[pathId]); }
    async getPact(pactId) { return clone((await this.state()).pacts[pactId]); }
    async getJob(jobId) { return clone((await this.state()).jobs[jobId]); }
    async listBlockedActions(workspaceId) { return clone((await this.state()).blockedActions.filter((entry) => entry.workspaceId === workspaceId)); }
    async exportAuditBundle(workspaceId) {
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
