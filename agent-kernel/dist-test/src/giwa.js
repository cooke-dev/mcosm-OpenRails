import { nowIso } from "./canonical.js";
export const GIWA_SEPOLIA = {
    chainId: 91_342,
    canonicalRpcUrl: "https://sepolia-rpc.giwa.io",
    flashblocksRpcUrl: "https://sepolia-rpc-flashblocks.giwa.io",
    explorerBaseUrl: "https://sepolia-explorer.giwa.io",
};
export class GiwaRpcClient {
    rpcUrl;
    fetchImpl;
    id = 0;
    constructor(rpcUrl, fetchImpl = fetch) {
        this.rpcUrl = rpcUrl;
        this.fetchImpl = fetchImpl;
    }
    async request(method, params = []) {
        const response = await this.fetchImpl(this.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
            throw new Error(`GIWA RPC ${method} failed with HTTP ${response.status}`);
        const body = await response.json();
        if (body.error)
            throw new Error(`GIWA RPC ${method} error ${body.error.code}: ${body.error.message}`);
        if (body.result === undefined)
            throw new Error(`GIWA RPC ${method} returned no result`);
        return body.result;
    }
    async chainId() {
        return Number.parseInt(await this.request("eth_chainId"), 16);
    }
    async transactionReceipt(txHash) {
        return this.request("eth_getTransactionReceipt", [txHash]);
    }
    async latestBlock() {
        return this.request("eth_getBlockByNumber", ["latest", false]);
    }
}
export class GiwaIdentityResolver {
    functions;
    now;
    constructor(functions, now = () => new Date()) {
        this.functions = functions;
        this.now = now;
    }
    async resolve(address) {
        const [verification, name] = await Promise.all([
            this.functions.isDojangVerified(address),
            this.functions.resolveUpId(address),
        ]);
        return {
            version: "openrails-giwa-identity-snapshot-v1",
            address,
            verified: verification.verified,
            verificationProvider: "dojang",
            ...(verification.reference ? { verificationReference: verification.reference } : {}),
            ...(name.name ? { resolvedName: name.name } : {}),
            ...(name.forwardResolutionMatches !== undefined ? { forwardResolutionMatches: name.forwardResolutionMatches } : {}),
            observedAt: nowIso(this.now),
        };
    }
}
export class GiwaConfirmationObserver {
    canonical;
    flashblocks;
    constructor(options = {}) {
        this.canonical = new GiwaRpcClient(options.canonicalRpcUrl ?? GIWA_SEPOLIA.canonicalRpcUrl, options.fetchImpl);
        this.flashblocks = new GiwaRpcClient(options.flashblocksRpcUrl ?? GIWA_SEPOLIA.flashblocksRpcUrl, options.fetchImpl);
    }
    async observe(transactionHash) {
        const [flash, canonical] = await Promise.allSettled([
            this.flashblocks.transactionReceipt(transactionHash),
            this.canonical.transactionReceipt(transactionHash),
        ]);
        const flashReceipt = flash.status === "fulfilled" ? flash.value : null;
        const canonicalReceipt = canonical.status === "fulfilled" ? canonical.value : null;
        return {
            transactionHash,
            flashblocksSeen: Boolean(flashReceipt),
            ...(flashReceipt ? { flashblocksReceipt: flashReceipt } : {}),
            canonicalConfirmed: Boolean(canonicalReceipt?.blockNumber),
            ...(canonicalReceipt ? { canonicalReceipt } : {}),
            observedAt: new Date().toISOString(),
        };
    }
}
