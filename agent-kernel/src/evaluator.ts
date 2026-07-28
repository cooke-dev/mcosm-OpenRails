import { hashCanonical, nowIso, parseBaseUnits, parseIso, stableId } from "./canonical.js";
import { authorityModeSatisfies, type ActionRegistry } from "./actionRegistry.js";
import type {
  AgentProposalV1,
  BaphometDecisionV1,
  GiwaIdentitySnapshotV1,
  KernelStateV1,
  PathV1,
  PolicyReasonCode,
} from "./types.js";

export interface CounterpartyIdentityResolver {
  resolve(address: `0x${string}`): Promise<GiwaIdentitySnapshotV1>;
}

export interface BaphometOptions {
  actionRegistry: ActionRegistry;
  identityResolver?: CounterpartyIdentityResolver;
  now?: () => Date;
}

function activePactsForPath(state: KernelStateV1, pathId: string) {
  const exposureReservedStatuses = new Set([
    "accepted",
    "payment_prepared",
    "awaiting_wallet",
    "active",
    "performing",
    "completed",
    "disputed",
    "rectification_required",
  ]);
  return Object.values(state.pacts).filter((pact) =>
    pact.pathId === pathId && exposureReservedStatuses.has(pact.status),
  );
}

function activeExposure(state: KernelStateV1, pathId: string): bigint {
  return activePactsForPath(state, pathId).reduce(
    (sum, pact) => sum + parseBaseUnits(pact.paymentTerms.maximumAllocationBaseUnits, "pact maximum allocation"),
    0n,
  );
}

function periodSpent(state: KernelStateV1, path: PathV1, nowMs: number): bigint {
  const start = nowMs - path.limits.periodSeconds * 1000;
  return state.pactEvents
    .filter((event) => event.workspaceId === path.workspaceId && event.type === "PAYMENT_OPENED_CANONICAL" && state.pacts[event.pactId]?.pathId === path.pathId && Date.parse(event.at) >= start)
    .reduce((sum, event) => {
      const value = event.data.allocationBaseUnits;
      return sum + (typeof value === "string" ? parseBaseUnits(value, "event allocation") : 0n);
    }, 0n);
}

function approvedPlugin(path: PathV1, pluginId: string): boolean {
  return path.approvedVerificationPlugins.some((entry) => entry.pluginId === pluginId);
}

export async function evaluateProposal(
  state: KernelStateV1,
  proposal: AgentProposalV1,
  options: BaphometOptions,
): Promise<{ decision: BaphometDecisionV1; identity?: GiwaIdentitySnapshotV1 }> {
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const reasons: PolicyReasonCode[] = [];
  const workspace = state.workspaces[proposal.workspaceId];
  const agent = state.agents[proposal.agentId];
  const signedPath = state.paths[proposal.pathId];
  const path = signedPath?.artifact;
  const action = options.actionRegistry.get(proposal.actionType);

  if (!workspace || workspace.status !== "active") reasons.push("WORKSPACE_INACTIVE");
  if (!agent) reasons.push("AGENT_NOT_REGISTERED");
  else {
    if (agent.status !== "active") reasons.push("AGENT_INACTIVE");
    if (!agent.assignedPathIds.includes(proposal.pathId)) reasons.push("AGENT_NOT_ASSIGNED_TO_PATH");
  }
  if (!path) reasons.push("PATH_NOT_FOUND");
  if (!action) reasons.push("ACTION_NOT_REGISTERED");
  else if (!action.enabled) reasons.push("ACTION_DISABLED");

  let identity: GiwaIdentitySnapshotV1 | undefined;
  let snapshot = { activeExposureBaseUnits: "0", periodSpentBaseUnits: "0", activePacts: 0 };

  if (path) {
    if (path.status !== "active") reasons.push("PATH_NOT_ACTIVE");
    if (parseIso(path.validFrom, "path validFrom") > nowMs) reasons.push("PATH_NOT_YET_VALID");
    if (parseIso(path.expiresAt, "path expiresAt") <= nowMs) reasons.push("PATH_EXPIRED");
    if (!path.authorizedAgentIds.includes(proposal.agentId)) reasons.push("AGENT_NOT_ASSIGNED_TO_PATH");
    if (!path.permittedActions.includes(proposal.actionType)) reasons.push("ACTION_NOT_ALLOWED");
    if (action && !authorityModeSatisfies(path.authorityMode, action.minimumAuthorityMode)) reasons.push("AUTHORITY_MODE_INSUFFICIENT");
    if (!path.permittedAssets.some((asset) => asset.toLowerCase() === proposal.asset.toLowerCase())) reasons.push("ASSET_NOT_ALLOWED");
    if (!approvedPlugin(path, proposal.evidencePolicyId)) reasons.push("PLUGIN_NOT_APPROVED");

    let allocation = 0n;
    let velocity = 0n;
    try { allocation = parseBaseUnits(proposal.requestedAllocationBaseUnits, "requested allocation", false); }
    catch { reasons.push("INVALID_AMOUNT"); }
    try { velocity = parseBaseUnits(proposal.requestedVelocityBaseUnitsPerSecond, "requested velocity", false); }
    catch { reasons.push("INVALID_AMOUNT"); }
    if (!Number.isSafeInteger(proposal.requestedDurationSeconds) || proposal.requestedDurationSeconds <= 0) reasons.push("INVALID_DURATION");

    const exposure = activeExposure(state, path.pathId);
    const spent = periodSpent(state, path, nowMs);
    const activePacts = activePactsForPath(state, path.pathId).length;
    snapshot = {
      activeExposureBaseUnits: exposure.toString(),
      periodSpentBaseUnits: spent.toString(),
      activePacts,
    };

    if (allocation > parseBaseUnits(path.limits.maxPerPactBaseUnits, "maxPerPact")) reasons.push("PACT_LIMIT_EXCEEDED");
    if (exposure + allocation > parseBaseUnits(path.limits.maxActiveExposureBaseUnits, "maxActiveExposure")) reasons.push("ACTIVE_EXPOSURE_EXCEEDED");
    if (spent + allocation > parseBaseUnits(path.limits.maxPerPeriodBaseUnits, "maxPerPeriod")) reasons.push("PERIOD_LIMIT_EXCEEDED");
    if (velocity > parseBaseUnits(path.limits.maxVelocityBaseUnitsPerSecond, "maxVelocity")) reasons.push("VELOCITY_LIMIT_EXCEEDED");
    if (proposal.requestedDurationSeconds > path.limits.maxDurationSeconds) reasons.push("DURATION_LIMIT_EXCEEDED");
    if (activePacts >= path.limits.maxConcurrentPacts) reasons.push("CONCURRENCY_LIMIT_EXCEEDED");

    if (path.permittedCounterparties?.length) {
      if (!proposal.counterparty) reasons.push("COUNTERPARTY_REQUIRED");
      else if (!path.permittedCounterparties.some((entry) => entry.toLowerCase() === proposal.counterparty?.toLowerCase())) reasons.push("COUNTERPARTY_NOT_ALLOWED");
    }

    const requiredIdentity = path.identityRequirements.filter((entry) => entry.required);
    if (requiredIdentity.length > 0) {
      if (!proposal.counterparty) reasons.push("COUNTERPARTY_REQUIRED");
      else if (!options.identityResolver) reasons.push("COUNTERPARTY_NOT_VERIFIED");
      else {
        try {
          identity = await options.identityResolver.resolve(proposal.counterparty);
          for (const requirement of requiredIdentity) {
            if (requirement.provider === "dojang" && !identity.verified) reasons.push("COUNTERPARTY_NOT_VERIFIED");
            if ((requirement.nameService === "up.id" || requirement.requireResolvedName) && !identity.resolvedName) reasons.push("COUNTERPARTY_NOT_VERIFIED");
            if (requirement.requireForwardResolutionMatch && identity.forwardResolutionMatches !== true) reasons.push("COUNTERPARTY_NOT_VERIFIED");
          }
        } catch {
          reasons.push("COUNTERPARTY_NOT_VERIFIED");
        }
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const result: BaphometDecisionV1["result"] = uniqueReasons.length === 0 ? "ALLOW" : "BLOCK";
  const evidenceHash = hashCanonical({ proposal, identity, snapshot });
  const evaluatedAt = nowIso(now);
  const decisionCore = {
    proposalId: proposal.proposalId,
    proposalHash: hashCanonical(proposal),
    workspaceId: proposal.workspaceId,
    pathId: proposal.pathId,
    pathHash: signedPath?.hash ?? ("0x" + "00".repeat(32)) as `0x${string}`,
    result,
    reasonCodes: uniqueReasons,
    policySnapshot: snapshot,
    evidenceHash,
    evaluatedAt,
  };
  const decision: BaphometDecisionV1 = {
    version: "openrails-baphomet-decision-v1",
    decisionId: stableId("decision", decisionCore),
    ...decisionCore,
    summary: result === "ALLOW" ? "Proposal is inside the active signed Path." : `Proposal blocked: ${uniqueReasons.join(", ")}.`,
    decisionHash: hashCanonical(decisionCore),
  };
  return identity ? { decision, identity } : { decision };
}
