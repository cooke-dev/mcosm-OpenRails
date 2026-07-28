import { hashCanonical } from "./canonical.js";
export const OPENRAILS_GIWA_CHAIN_ID = 91_342;
export const OPENRAILS_GIWA_VAULT = "0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1";
export function authorityDomain(verifyingContract = OPENRAILS_GIWA_VAULT) {
    return {
        name: "OpenRails Agent Kernel",
        version: "1",
        chainId: OPENRAILS_GIWA_CHAIN_ID,
        verifyingContract,
    };
}
function envelope(primaryType, fields, message) {
    return {
        domain: authorityDomain(),
        primaryType,
        types: { [primaryType]: fields },
        message,
    };
}
export function workspaceTypedData(workspace) {
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
export function agentRegistrationTypedData(agent) {
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
export function pathTypedData(path) {
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
export function pactTypedData(pact) {
    return envelope("OpenRailsPact", [
        { name: "workspaceIdHash", type: "bytes32" },
        { name: "pactIdHash", type: "bytes32" },
        { name: "pathIdHash", type: "bytes32" },
        { name: "pathHash", type: "bytes32" },
        { name: "initiator", type: "address" },
        { name: "counterparty", type: "address" },
        { name: "actionTypeHash", type: "bytes32" },
        { name: "pactHash", type: "bytes32" },
    ], {
        workspaceIdHash: hashCanonical(pact.workspaceId),
        pactIdHash: hashCanonical(pact.pactId),
        pathIdHash: hashCanonical(pact.pathId),
        pathHash: pact.pathHash,
        initiator: pact.initiator,
        counterparty: pact.counterparty,
        actionTypeHash: hashCanonical(pact.actionType),
        pactHash: hashCanonical(pact),
    });
}
export function verificationPluginTypedData(manifest) {
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
