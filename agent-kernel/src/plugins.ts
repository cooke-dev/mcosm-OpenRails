import { hashCanonical, nowIso, stableId } from "./canonical.js";
import type {
  ExecutionCheckpointV1,
  KernelStateV1,
  VerificationDecisionV1,
  VerificationDecisionValue,
  VerificationPluginManifestV1,
} from "./types.js";

export interface VerificationPluginContext {
  state: KernelStateV1;
  now: () => Date;
}

export interface VerificationPlugin {
  manifest: VerificationPluginManifestV1;
  evaluate(checkpoint: ExecutionCheckpointV1, context: VerificationPluginContext): Promise<{
    decision: VerificationDecisionValue;
    reasonCodes: string[];
    sourceCommitmentHash?: `0x${string}`;
    validUntil?: string;
  }>;
}

export class VerificationPluginRegistry {
  private readonly implementations = new Map<string, VerificationPlugin>();

  key(pluginId: string, version: string): string { return `${pluginId}@${version}`; }

  bind(plugin: VerificationPlugin): void {
    const key = this.key(plugin.manifest.pluginId, plugin.manifest.pluginVersion);
    const current = this.implementations.get(key);
    if (current && current.manifest.codeDigest !== plugin.manifest.codeDigest) throw new Error("plugin implementation digest conflict");
    this.implementations.set(key, plugin);
  }

  get(pluginId: string, version: string): VerificationPlugin | undefined {
    return this.implementations.get(this.key(pluginId, version));
  }

  async evaluate(input: {
    state: KernelStateV1;
    checkpoint: ExecutionCheckpointV1;
    pluginId: string;
    pluginVersion: string;
    now?: () => Date;
  }): Promise<VerificationDecisionV1> {
    const manifest = input.state.plugins[this.key(input.pluginId, input.pluginVersion)];
    if (!manifest || manifest.status !== "active") throw new Error("verification plugin is not active");
    if (!manifest.installedWorkspaceIds.includes(input.checkpoint.workspaceId)) throw new Error("verification plugin is not installed in the Workspace");
    const implementation = this.get(input.pluginId, input.pluginVersion);
    if (!implementation) throw new Error("verification plugin implementation is unavailable");
    if (implementation.manifest.codeDigest !== manifest.codeDigest) throw new Error("verification plugin digest mismatch");
    if (!manifest.supportedEvidenceTypes.includes(input.checkpoint.evidenceType)) throw new Error("verification plugin does not support this evidence type");
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

export function createDevelopmentHashSyntaxPlugin(manifest: VerificationPluginManifestV1): VerificationPlugin {
  return {
    manifest,
    async evaluate(checkpoint) {
      const syntacticallyValid = /^0x[0-9a-fA-F]{64}$/.test(checkpoint.evidenceHash);
      return {
        decision: syntacticallyValid ? "review" : "rejected",
        reasonCodes: syntacticallyValid ? ["DEV_HASH_SYNTAX_VALID_REQUIRES_REVIEW"] : ["EVIDENCE_HASH_INVALID"],
      };
    },
  };
}
