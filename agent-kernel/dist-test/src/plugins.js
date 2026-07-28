import { hashCanonical, nowIso, stableId } from "./canonical.js";
export class VerificationPluginRegistry {
    implementations = new Map();
    key(pluginId, version) { return `${pluginId}@${version}`; }
    bind(plugin) {
        const key = this.key(plugin.manifest.pluginId, plugin.manifest.pluginVersion);
        const current = this.implementations.get(key);
        if (current && current.manifest.codeDigest !== plugin.manifest.codeDigest)
            throw new Error("plugin implementation digest conflict");
        this.implementations.set(key, plugin);
    }
    get(pluginId, version) {
        return this.implementations.get(this.key(pluginId, version));
    }
    async evaluate(input) {
        const manifest = input.state.plugins[this.key(input.pluginId, input.pluginVersion)];
        if (!manifest || manifest.status !== "active")
            throw new Error("verification plugin is not active");
        if (!manifest.installedWorkspaceIds.includes(input.checkpoint.workspaceId))
            throw new Error("verification plugin is not installed in the Workspace");
        const implementation = this.get(input.pluginId, input.pluginVersion);
        if (!implementation)
            throw new Error("verification plugin implementation is unavailable");
        if (implementation.manifest.codeDigest !== manifest.codeDigest)
            throw new Error("verification plugin digest mismatch");
        if (!manifest.supportedEvidenceTypes.includes(input.checkpoint.evidenceType))
            throw new Error("verification plugin does not support this evidence type");
        const now = input.now ?? (() => new Date());
        const result = await implementation.evaluate(input.checkpoint, { state: input.state, now });
        const evaluatedAt = nowIso(now);
        const core = {
            workspaceId: input.checkpoint.workspaceId,
            pactId: input.checkpoint.pactId,
            checkpointId: input.checkpoint.checkpointId,
            pluginId: input.pluginId,
            pluginVersion: input.pluginVersion,
            decision: result.decision,
            reasonCodes: result.reasonCodes,
            evidenceHash: input.checkpoint.evidenceHash,
            ...(result.sourceCommitmentHash ? { sourceCommitmentHash: result.sourceCommitmentHash } : {}),
            evaluatedAt,
            ...(result.validUntil ? { validUntil: result.validUntil } : {}),
        };
        return {
            version: "openrails-verification-decision-v1",
            decisionId: stableId("verify", core),
            ...core,
            decisionHash: hashCanonical(core),
        };
    }
}
export function createHashEqualityPlugin(manifest) {
    return {
        manifest,
        async evaluate(checkpoint) {
            return {
                decision: /^0x[0-9a-fA-F]{64}$/.test(checkpoint.evidenceHash) ? "approved" : "rejected",
                reasonCodes: /^0x[0-9a-fA-F]{64}$/.test(checkpoint.evidenceHash) ? ["EVIDENCE_HASH_VALID"] : ["EVIDENCE_HASH_INVALID"],
            };
        },
    };
}
