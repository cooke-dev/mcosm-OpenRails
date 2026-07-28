import { createServer } from "node:http";
import { JsonFileKernelStore } from "./store.js";
import { OpenRailsAgentKernel } from "./runtime.js";
import { EthersAuthoritySignatureVerifier } from "./ethersVerifier.js";
import { safeStringEqual } from "./canonical.js";
const port = Number(process.env.OPENRAILS_AGENT_KERNEL_PORT ?? 4030);
const host = process.env.OPENRAILS_AGENT_KERNEL_HOST ?? "127.0.0.1";
const statePath = process.env.OPENRAILS_AGENT_KERNEL_STATE_PATH ?? "artifacts/giwa-agent-kernel/state.json";
const apiKey = process.env.OPENRAILS_AGENT_KERNEL_API_KEY;
if (!apiKey)
    throw new Error("OPENRAILS_AGENT_KERNEL_API_KEY is required");
if (process.env.OPENRAILS_AGENT_KERNEL_PRIVATE_KEY || process.env.OPENRAILS_MCP_SIGNER_KEY) {
    throw new Error("Agent Kernel refuses private-key environment variables");
}
const kernel = new OpenRailsAgentKernel({
    store: new JsonFileKernelStore(statePath),
    signatureVerifier: new EthersAuthoritySignatureVerifier(),
});
async function json(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.length === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
}
function authorized(req) {
    const value = req.headers.authorization;
    return typeof value === "string" && value.startsWith("Bearer ") && safeStringEqual(value.slice(7), apiKey);
}
const routes = {
    "POST /v1/workspaces/prepare": (body) => kernel.prepareWorkspace(body),
    "POST /v1/workspaces/register": (body) => kernel.registerWorkspace(body),
    "POST /v1/agents/prepare": (body) => kernel.prepareAgentRegistration(body),
    "POST /v1/agents/register": (body) => kernel.registerAgent(body),
    "POST /v1/agents/status": (body) => kernel.setAgentStatus(body),
    "POST /v1/paths/prepare": (body) => kernel.preparePath(body),
    "POST /v1/paths/activate": (body) => kernel.activatePath(body),
    "POST /v1/proposals": (body) => kernel.submitProposal(body),
    "POST /v1/jobs/run-next": (body) => kernel.runNextJob(body.workerId),
    "POST /v1/pacts/from-proposal": (body) => kernel.createPactFromProposal(body),
    "POST /v1/pacts/prepare-signature": (body) => kernel.preparePactSignature(body),
    "POST /v1/pacts/sign": (body) => kernel.signPact(body),
    "POST /v1/pacts/bind-openrails": (body) => kernel.bindOpenRailsPayment(body),
    "POST /v1/pacts/settlement": (body) => kernel.recordPactSettlement(body),
    "POST /v1/plugins/install": (body) => kernel.installPlugin(body.manifest, body.authoritySigner),
    "POST /v1/checkpoints": (body) => kernel.submitCheckpoint(body),
    "POST /v1/checkpoints/verify": (body) => kernel.verifyCheckpoint(body),
    "POST /v1/gaia": (body) => kernel.openGaiaCase(body),
    "POST /v1/gaia/resolve": (body) => kernel.resolveGaiaCase(body),
};
createServer(async (req, res) => {
    const key = `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`;
    try {
        if (key === "GET /health")
            return send(res, 200, {
                ok: true,
                service: "openrails-giwa-agent-kernel",
                authority: "external-wallet",
                signing: false,
                broadcasting: false,
                frontend: false,
            });
        if (!authorized(req))
            return send(res, 401, { error: "unauthorized" });
        if (key === "GET /v1/state")
            return send(res, 200, await kernel.state());
        if (key.startsWith("GET /v1/workspaces/"))
            return send(res, 200, await kernel.getWorkspace(decodeURIComponent(key.slice("GET /v1/workspaces/".length))));
        if (key.startsWith("GET /v1/agents/"))
            return send(res, 200, await kernel.getAgent(decodeURIComponent(key.slice("GET /v1/agents/".length))));
        if (key.startsWith("GET /v1/paths/"))
            return send(res, 200, await kernel.getPath(decodeURIComponent(key.slice("GET /v1/paths/".length))));
        if (key.startsWith("GET /v1/pacts/"))
            return send(res, 200, await kernel.getPact(decodeURIComponent(key.slice("GET /v1/pacts/".length))));
        const route = routes[key];
        if (!route)
            return send(res, 404, { error: "not_found" });
        send(res, 200, await route(await json(req)));
    }
    catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
}).listen(port, host, () => {
    console.error(`openrails-giwa-agent-kernel listening on http://${host}:${port} · external-wallet · no signer · no broadcaster`);
});
