import { nowIso } from "./canonical.js";
import type { Address, GiwaIdentitySnapshotV1, Hex } from "./types.js";
import type { CounterpartyIdentityResolver } from "./evaluator.js";

export const GIWA_SEPOLIA = {
  chainId: 91_342,
  canonicalRpcUrl: "https://sepolia-rpc.giwa.io",
  flashblocksRpcUrl: "https://sepolia-rpc-flashblocks.giwa.io",
  explorerBaseUrl: "https://sepolia-explorer.giwa.io",
  tokenAddress: "0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De",
  vaultAddress: "0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1",
  factoryAddress: "0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d",
  masterAddress: "0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb",
  dojangScrollAddress: "0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9",
  upbitKoreaAttesterId: "0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034",
} as const;

export class GiwaRpcClient {
  private id = 0;
  constructor(readonly rpcUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GIWA RPC ${method} failed with HTTP ${response.status}`);
    const body = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`GIWA RPC ${method} error ${body.error.code}: ${body.error.message}`);
    if (body.result === undefined) throw new Error(`GIWA RPC ${method} returned no result`);
    return body.result;
  }

  async chainId(): Promise<number> {
    return Number.parseInt(await this.request<string>("eth_chainId"), 16);
  }

  async transactionReceipt(txHash: Hex): Promise<Record<string, unknown> | null> {
    return this.request<Record<string, unknown> | null>("eth_getTransactionReceipt", [txHash]);
  }

  async latestBlock(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("eth_getBlockByNumber", ["latest", false]);
  }
}

export interface GiwaIdentityFunctions {
  isDojangVerified(address: Address): Promise<{ verified: boolean; reference?: string }>;
  resolveUpId(address: Address): Promise<{ name?: string; forwardResolutionMatches?: boolean }>;
}

export class GiwaIdentityResolver implements CounterpartyIdentityResolver {
  constructor(private readonly functions: GiwaIdentityFunctions, private readonly now: () => Date = () => new Date()) {}

  async resolve(address: Address): Promise<GiwaIdentitySnapshotV1> {
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

export interface GiwaTransactionObservation {
  transactionHash: Hex;
  flashblocksSeen: boolean;
  flashblocksReceipt?: Record<string, unknown>;
  canonicalReceiptObserved: boolean;
  canonicalSucceeded: boolean;
  canonicalReceipt?: Record<string, unknown>;
  observedAt: string;
}

export class GiwaConfirmationObserver {
  private readonly canonical: GiwaRpcClient;
  private readonly flashblocks: GiwaRpcClient;

  constructor(options: { canonicalRpcUrl?: string; flashblocksRpcUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.canonical = new GiwaRpcClient(options.canonicalRpcUrl ?? GIWA_SEPOLIA.canonicalRpcUrl, options.fetchImpl);
    this.flashblocks = new GiwaRpcClient(options.flashblocksRpcUrl ?? GIWA_SEPOLIA.flashblocksRpcUrl, options.fetchImpl);
  }

  async observe(transactionHash: Hex): Promise<GiwaTransactionObservation> {
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
      canonicalReceiptObserved: Boolean(canonicalReceipt?.blockNumber),
      canonicalSucceeded: canonicalReceipt?.status === "0x1" || canonicalReceipt?.status === 1,
      ...(canonicalReceipt ? { canonicalReceipt } : {}),
      observedAt: new Date().toISOString(),
    };
  }
}
