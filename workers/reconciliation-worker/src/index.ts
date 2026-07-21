import { ethers } from "ethers";
import { authorized } from "../../shared/auth";

export interface Env {
  STREAM_DB?: D1Database; // only used in the legacy "d1" settler mode
  ARC_RPC_URL: string;
  ARC_CHAIN_ID: string;
  OPENRAILS_HUB_ADDRESS: string;
  ARC_USDC_ADDRESS?: string; // USDC token (for the optional EIP-2612 permit in /relay-open)
  RECONCILIATION_SIGNER_KEY?: string; // Private key secret loaded from Wrangler
  RECONCILIATION_ADMIN_TOKEN?: string;
  RECONCILIATION_BATCH_LIMIT?: string;
  MAX_SETTLEMENT_ATTEMPTS?: string;
  SETTLER_MODE?: string; // "chain" (default) - settle all active rails; or "d1" - legacy plays table
  SETTLER_WINDOW_BLOCKS?: string; // getLogs lookback (default 9000; public RPC caps ~10k)
  MIN_ACCRUED_USDC?: string; // skip streaming settles below this accrued amount (default 0.0005)
  RELAY_CLAIMS_ENABLED?: string; // "true" (default) exposes the public gasless RailsCard claim relay
}

const HUB_ABI = [
  "function processDripSettle(bytes32 paycardId) external",
  "function openPaycardChannel(bytes32 paycardId, bytes32 metadataHash, address recipient, uint256 totalAllocationPool, uint256 flowVelocityPerSecond, uint256 genesisTimestamp, uint256 lifespanSeconds, address residualDeltaRecipient, bytes envelopeSignature, uint256 nonceChannel, uint256 nonceValue, address payer) external",
  "function claimWildcardPaycardChannel(bytes32 paycardId, bytes32 metadataHash, address claimRecipient, uint256 totalAllocationPool, uint256 flowVelocityPerSecond, uint256 genesisTimestamp, uint256 lifespanSeconds, address residualDeltaRecipient, bytes envelopeSignature, uint256 nonceChannel, uint256 nonceValue, address payer) external",
  "function registry(bytes32 paycardId) external view returns (address payer, address recipient, bytes32 metadataHash, uint256 totalAllocationPool, uint256 availableBalance, uint256 flowVelocityPerSecond, uint256 genesisTimestamp, uint256 lifespanSeconds, uint256 lastCheckpointEpoch, address residualDeltaRecipient, uint8 operationalStatus)",
  "event PaycardProvisioned(bytes32 indexed paycardId, address indexed payer, address indexed recipient, bytes32 metadataHash, uint256 poolAllocation, uint256 flowVelocityPerSecond, uint256 genesisTimestamp, uint256 lifespanSeconds)"
];

const USDC_PERMIT_ABI = [
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external"
];

// Envelope shape minted by the SDK / cockpit (base64url-JSON of a CryptographicEnvelopeV1).
interface ClaimEnvelope {
  payerAddress: string;
  envelopeSignature: string;
  intent: {
    paycardId: string;
    metadataHash: string;
    recipient: string;
    totalAllocationPool: string;
    flowVelocityPerSecond: string;
    genesisTimestamp: number;
    lifespanSeconds: number;
    residualDeltaRecipient: string;
    nonceChannel: number;
    nonceValue: number;
  };
  mode: string; // railscard_bearer | railscard_recipient_bound | ...
  permit?: {
    owner: string;
    spender: string;
    value: string;
    deadline: number;
    v: number;
    r: string;
    s: string;
  };
}

// Inverse of the cockpit/SDK serializeEnvelope (TextEncoder bytes → base64url).
function decodeEnvelope(token: string): ClaimEnvelope {
  let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as ClaimEnvelope;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenRails-Admin-Token",
};

const RELAY_RATE_LIMIT_WINDOW_MS = 60_000;
const RELAY_RATE_LIMIT_MAX = 30;
const relayRateLimits = new Map<string, { count: number; resetAt: number }>();

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function checkRelayRateLimit(request: Request, route: string): Response | null {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${route}:${ip}`;
  const now = Date.now();
  if (relayRateLimits.size > 5000) {
    for (const [entryKey, entry] of relayRateLimits.entries()) {
      if (entry.resetAt <= now) relayRateLimits.delete(entryKey);
    }
  }
  const current = relayRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    relayRateLimits.set(key, { count: 1, resetAt: now + RELAY_RATE_LIMIT_WINDOW_MS });
    return null;
  }

  if (current.count >= RELAY_RATE_LIMIT_MAX) {
    const retryAfterSeconds = Math.ceil((current.resetAt - now) / 1000);
    return jsonResponse({ error: "Relay rate limit exceeded", retryAfterSeconds }, 429);
  }

  current.count += 1;
  return null;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default {
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(this.reconcileStreams(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Public, gasless RailsCard claim relay: the keeper submits the claim on behalf of the
      // holder so a recipient with zero gas can still claim. Non-custodial - escrow is pulled
      // from the payer (who already signed); the keeper only pays gas and cannot redirect funds
      // beyond what the signed intent + claimant address allow.
      if (url.pathname === "/relay-claim") {
        if (request.method !== "POST") return jsonResponse({ error: "Only POST requests allowed" }, 405);
        const limited = checkRelayRateLimit(request, url.pathname);
        if (limited) return limited;
        return this.relayClaim(request, env);
      }

      // Public, gasless RailsFlow/stream open: the payer signs the intent (and optionally an
      // EIP-2612 permit so they never send an approval tx); the keeper submits both and pays gas.
      if (url.pathname === "/relay-open") {
        if (request.method !== "POST") return jsonResponse({ error: "Only POST requests allowed" }, 405);
        const limited = checkRelayRateLimit(request, url.pathname);
        if (limited) return limited;
        return this.relayOpen(request, env);
      }

      // Admin-gated manual settle trigger (the cron drives this automatically otherwise).
      if (url.pathname === "/reconcile") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Only POST requests allowed" }, 405);
        }
        if (!env.RECONCILIATION_ADMIN_TOKEN) {
          return jsonResponse({ error: "Reconciliation admin token is not configured" }, 503);
        }
        if (!authorized(request, env.RECONCILIATION_ADMIN_TOKEN, "X-OpenRails-Admin-Token")) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        await this.reconcileStreams(env);
        return jsonResponse({ success: true, message: "Reconciliation triggered successfully" });
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  },

  // Sponsor a RailsCard claim: decode the signed envelope, verify it would succeed (staticCall so
  // the keeper never burns gas on an already-claimed/expired card), then submit as msg.sender.
  async relayClaim(request: Request, env: Env): Promise<Response> {
    if ((env.RELAY_CLAIMS_ENABLED ?? "true").toLowerCase() === "false") {
      return jsonResponse({ error: "Claim relay is disabled" }, 503);
    }
    if (!env.RECONCILIATION_SIGNER_KEY) {
      return jsonResponse({ error: "Relay signer is not configured" }, 503);
    }

    let body: { envelopeToken?: string; claimRecipient?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    if (!body.envelopeToken) return jsonResponse({ error: "Missing envelopeToken" }, 400);

    let env0: ClaimEnvelope;
    try {
      env0 = decodeEnvelope(body.envelopeToken);
    } catch {
      return jsonResponse({ error: "Could not decode envelopeToken" }, 400);
    }
    const i = env0.intent;
    if (!i?.paycardId || !env0.envelopeSignature) {
      return jsonResponse({ error: "Envelope is missing an intent or signature" }, 400);
    }

    const bearer = env0.mode === "railscard_bearer" || /^0x0{40}$/i.test(i.recipient);
    let claimRecipient = bearer ? body.claimRecipient : i.recipient;
    if (bearer && !claimRecipient) {
      return jsonResponse({ error: "Bearer card requires a claimRecipient address" }, 400);
    }
    if (!ethers.isAddress(claimRecipient as string)) {
      return jsonResponse({ error: "Invalid claimRecipient address" }, 400);
    }
    claimRecipient = ethers.getAddress(claimRecipient as string);

    const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
    const signer = new ethers.Wallet(env.RECONCILIATION_SIGNER_KEY, provider);
    const hub = new ethers.Contract(env.OPENRAILS_HUB_ADDRESS, HUB_ABI, signer);

    // Optional: land the payer's approval via permit (gasless for them) before claiming.
    if (env0.permit) {
      if (!env.ARC_USDC_ADDRESS) return jsonResponse({ error: "USDC address not configured for permit" }, 503);
      const p = env0.permit;
      const usdc = new ethers.Contract(env.ARC_USDC_ADDRESS, USDC_PERMIT_ABI, signer);
      try {
        await usdc.permit.staticCall(p.owner, p.spender, BigInt(p.value), BigInt(p.deadline), p.v, p.r, p.s);
        const ptx = await usdc.permit(p.owner, p.spender, BigInt(p.value), BigInt(p.deadline), p.v, p.r, p.s);
        await ptx.wait();
        console.log(`[relay] claim permit landed for ${p.owner} (${ptx.hash})`);
      } catch (error) {
        // Permit might already be landed or expired, warn but don't fail yet
        console.warn(`[relay] permit staticCall failed or already set for ${p.owner}: ${(error as Error).message}`);
      }
    }

    const fn = bearer ? "claimWildcardPaycardChannel" : "openPaycardChannel";
    const args = [
      i.paycardId,
      i.metadataHash,
      claimRecipient,
      BigInt(i.totalAllocationPool),
      BigInt(i.flowVelocityPerSecond),
      BigInt(i.genesisTimestamp),
      BigInt(i.lifespanSeconds),
      i.residualDeltaRecipient,
      env0.envelopeSignature,
      BigInt(i.nonceChannel),
      BigInt(i.nonceValue),
      env0.payerAddress, // V2: explicit payer
    ];

    try {
      // Precheck: reverts here (already claimed, expired, payer under-funded) cost the keeper nothing.
      await hub[fn].staticCall(...args);
    } catch (error) {
      const msg = (error as Error).message?.slice(0, 300) || "claim would revert";
      return jsonResponse({ error: `Claim not currently valid: ${msg}` }, 409);
    }

    try {
      const tx = await hub[fn](...args);
      await tx.wait();
      console.log(`[relay] sponsored ${fn} ${i.paycardId} -> ${claimRecipient} (${tx.hash})`);
      return jsonResponse({ txHash: tx.hash, paycardId: i.paycardId, recipient: claimRecipient, mode: env0.mode });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message?.slice(0, 300) || "relay submit failed" }, 502);
    }
  },

  // Sponsor a RailsFlow/stream open: the payer-signed envelope opens the channel; an optional
  // EIP-2612 permit lands the USDC approval first, so the payer sends no tx at all. Escrow is
  // pulled from the recovered payer per the signed intent - non-custodial; the keeper pays gas.
  async relayOpen(request: Request, env: Env): Promise<Response> {
    if ((env.RELAY_CLAIMS_ENABLED ?? "true").toLowerCase() === "false") {
      return jsonResponse({ error: "Claim relay is disabled" }, 503);
    }
    if (!env.RECONCILIATION_SIGNER_KEY) {
      return jsonResponse({ error: "Relay signer is not configured" }, 503);
    }

    type Permit = { owner: string; spender: string; value: string; deadline: number; v: number; r: string; s: string };
    let body: { envelopeToken?: string; permit?: Permit };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    if (!body.envelopeToken) return jsonResponse({ error: "Missing envelopeToken" }, 400);

    let env0: ClaimEnvelope;
    try {
      env0 = decodeEnvelope(body.envelopeToken);
    } catch {
      return jsonResponse({ error: "Could not decode envelopeToken" }, 400);
    }
    const i = env0.intent;
    if (!i?.paycardId || !env0.envelopeSignature) {
      return jsonResponse({ error: "Envelope is missing an intent or signature" }, 400);
    }
    if (/^0x0{40}$/i.test(i.recipient)) {
      return jsonResponse({ error: "relay-open needs a fixed recipient; use /relay-claim for bearer cards" }, 400);
    }

    const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
    const signer = new ethers.Wallet(env.RECONCILIATION_SIGNER_KEY, provider);
    const hub = new ethers.Contract(env.OPENRAILS_HUB_ADDRESS, HUB_ABI, signer);

    // Optional: land the payer's approval via permit (gasless for them) before opening.
    if (body.permit) {
      if (!env.ARC_USDC_ADDRESS) return jsonResponse({ error: "USDC address not configured for permit" }, 503);
      const p = body.permit;
      const usdc = new ethers.Contract(env.ARC_USDC_ADDRESS, USDC_PERMIT_ABI, signer);
      try {
        await usdc.permit.staticCall(p.owner, p.spender, BigInt(p.value), BigInt(p.deadline), p.v, p.r, p.s);
      } catch (error) {
        return jsonResponse({ error: `Permit not valid: ${(error as Error).message?.slice(0, 240)}` }, 409);
      }
      try {
        const ptx = await usdc.permit(p.owner, p.spender, BigInt(p.value), BigInt(p.deadline), p.v, p.r, p.s);
        await ptx.wait();
        console.log(`[relay] permit landed for ${p.owner} (${ptx.hash})`);
      } catch (error) {
        return jsonResponse({ error: (error as Error).message?.slice(0, 300) || "permit submit failed" }, 502);
      }
    }

    const args = [
      i.paycardId,
      i.metadataHash,
      i.recipient,
      BigInt(i.totalAllocationPool),
      BigInt(i.flowVelocityPerSecond),
      BigInt(i.genesisTimestamp),
      BigInt(i.lifespanSeconds),
      i.residualDeltaRecipient,
      env0.envelopeSignature,
      BigInt(i.nonceChannel),
      BigInt(i.nonceValue),
      env0.payerAddress, // V2: explicit payer
    ];

    try {
      await hub.openPaycardChannel.staticCall(...args);
    } catch (error) {
      const msg = (error as Error).message?.slice(0, 300) || "open would revert";
      return jsonResponse({ error: `Open not currently valid: ${msg}` }, 409);
    }

    try {
      const tx = await hub.openPaycardChannel(...args);
      await tx.wait();
      console.log(`[relay] sponsored open ${i.paycardId} -> ${i.recipient} (${tx.hash})`);
      return jsonResponse({ txHash: tx.hash, paycardId: i.paycardId, recipient: i.recipient, mode: env0.mode });
    } catch (error) {
      return jsonResponse({ error: (error as Error).message?.slice(0, 300) || "relay open failed" }, 502);
    }
  },

  async reconcileStreams(env: Env): Promise<void> {
    if (!env.RECONCILIATION_SIGNER_KEY) {
      console.warn("[reconciliation-worker] Aborting: RECONCILIATION_SIGNER_KEY is not configured.");
      return;
    }
    const mode = (env.SETTLER_MODE || "chain").toLowerCase();
    if (mode === "d1") return this.reconcileFromD1(env);
    return this.settleActiveRails(env);
  },

  // Generic rails settler: enumerate active Paycard Streams from chain and drip-settle them.
  // The keeper ONLY settles (processDripSettle) - it never opens (openPaycardChannel) or closes
  // (flushResidualDelta); opening and closure stay with payer/merchant/creator. Permissionless +
  // non-custodial: funds always flow payer -> recipient per on-chain state; the keeper pays gas.
  async settleActiveRails(env: Env): Promise<void> {
    const batchLimit = readPositiveInt(env.RECONCILIATION_BATCH_LIMIT, 25);
    const windowBlocks = readPositiveInt(env.SETTLER_WINDOW_BLOCKS, 9000);
    const minAccruedBase = BigInt(Math.round(Number(env.MIN_ACCRUED_USDC ?? "0.0005") * 1_000_000));

    const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
    const signer = new ethers.Wallet(env.RECONCILIATION_SIGNER_KEY!, provider);
    const hub = new ethers.Contract(env.OPENRAILS_HUB_ADDRESS, HUB_ABI, signer);

    const latest = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - windowBlocks);
    const logs = await hub.queryFilter(hub.filters.PaycardProvisioned(), fromBlock, latest);
    const ids = [...new Set(logs.map((l: any) => l.args?.paycardId as string))];
    console.log(`[settler] ${ids.length} provisioned streams in blocks [${fromBlock}, ${latest}]`);

    const now = Math.floor(Date.now() / 1000);
    let settled = 0, skipped = 0, errors = 0;
    for (const paycardId of ids) {
      if (settled >= batchLimit) break;
      try {
        const s = await hub.registry(paycardId);
        if (Number(s.operationalStatus) !== 0) { skipped++; continue; } // not Active
        const available = BigInt(s.availableBalance);
        if (available === 0n) { skipped++; continue; } // nothing left to settle

        const lifespan = BigInt(s.lifespanSeconds);
        if (lifespan === 0n) {
          // One-time (instant): the full amount unlocks on the first settle. available > 0 means
          // it hasn't been settled yet - settle it once. Afterwards available is 0 and it's skipped.
        } else {
          // Streaming: only settle when accrued-since-checkpoint clears the dust threshold, so the
          // cron doesn't burn gas on negligible drips.
          const velocity = BigInt(s.flowVelocityPerSecond);
          const genesis = BigInt(s.genesisTimestamp);
          const lastCheckpoint = BigInt(s.lastCheckpointEpoch);
          const end = genesis + lifespan;
          const upto = BigInt(now) < end ? BigInt(now) : end;
          const elapsed = upto > lastCheckpoint ? upto - lastCheckpoint : 0n;
          let accrued = velocity * elapsed;
          if (accrued > available) accrued = available;
          if (accrued < minAccruedBase) { skipped++; continue; }
        }

        const tx = await hub.processDripSettle(paycardId);
        await tx.wait();
        settled++;
        console.log(`[settler] settled ${paycardId} (${tx.hash})`);
      } catch (error) {
        errors++;
        console.error(`[settler] settle failed ${paycardId}:`, (error as Error).message?.slice(0, 300));
      }
    }
    console.log(`[settler] done - settled ${settled}, skipped ${skipped}, errors ${errors}`);
  },

  // Legacy mode: settle only paycards referenced by unsettled rows in the music "plays" D1 table.
  async reconcileFromD1(env: Env): Promise<void> {
    if (!env.STREAM_DB) {
      console.warn("[reconciliation-worker] d1 mode requires STREAM_DB binding.");
      return;
    }
    const db = env.STREAM_DB;

    const maxAttempts = readPositiveInt(env.MAX_SETTLEMENT_ATTEMPTS, 5);
    const batchLimit = readPositiveInt(env.RECONCILIATION_BATCH_LIMIT, 10);

    // 1. Fetch unique paycardIds with pending (unsettled) play counts
    const { results } = await db.prepare(
      "SELECT DISTINCT paycard_id FROM plays WHERE settled = 0 AND settlement_attempts < ? LIMIT ?"
    ).bind(maxAttempts, batchLimit).all();

    if (!results || results.length === 0) {
      console.log("[reconciliation-worker] No pending royalties to settle.");
      return;
    }

    // 2. Initialize provider and wallet signer
    const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
    const signer = new ethers.Wallet(env.RECONCILIATION_SIGNER_KEY, provider);
    const hub = new ethers.Contract(env.OPENRAILS_HUB_ADDRESS, HUB_ABI, signer);

    console.log(`[reconciliation-worker] Found ${results.length} paycard streams needing settlement.`);

    for (const row of results) {
      const paycardId = row.paycard_id as string;
      if (!ethers.isHexString(paycardId, 32)) {
        console.warn(`[reconciliation-worker] Invalid paycardId ${paycardId}. Marking as skipped.`);
        await db.prepare(
          "UPDATE plays SET settled = 2, last_error = ?, updated_at = ? WHERE paycard_id = ? AND settled = 0"
        ).bind("invalid paycardId", Math.floor(Date.now() / 1000), paycardId).run();
        continue;
      }

      const locked = await db.prepare(
        "UPDATE plays SET settled = 3, settlement_attempts = settlement_attempts + 1, updated_at = ? WHERE paycard_id = ? AND settled = 0 AND settlement_attempts < ?"
      ).bind(Math.floor(Date.now() / 1000), paycardId, maxAttempts).run();

      if ((locked.meta?.changes ?? 0) === 0) {
        console.log(`[reconciliation-worker] Skipping ${paycardId}; no pending rows could be locked.`);
        continue;
      }

      try {
        // Double-check stream state on-chain: is it active?
        const stream = await hub.registry(paycardId);
        const operationalStatus = Number(stream.operationalStatus); // 0 = Active, 1 = Terminated

        if (operationalStatus !== 0) {
          console.warn(`[reconciliation-worker] Stream ${paycardId} is not Active (Status: ${operationalStatus}). Marking as skipped.`);
          // Mark as settled/processed to avoid infinite retry loops
          await db.prepare(
            "UPDATE plays SET settled = 2, last_error = ?, updated_at = ? WHERE paycard_id = ? AND settled = 3"
          ).bind(`inactive status ${operationalStatus}`, Math.floor(Date.now() / 1000), paycardId).run();
          continue;
        }

        // 3. Broadcast processDripSettle onchain to pull USDC
        console.log(`[reconciliation-worker] Sending settlement for paycard: ${paycardId}`);
        const tx = await hub.processDripSettle(paycardId);
        await tx.wait(); // Wait for transaction confirmation
        console.log(`[reconciliation-worker] Settlement transaction confirmed: ${tx.hash}`);

        // 4. Update plays in D1 cache to mark as settled (1 = settled)
        await db.prepare(
          "UPDATE plays SET settled = 1, last_error = NULL, updated_at = ? WHERE paycard_id = ? AND settled = 3"
        ).bind(Math.floor(Date.now() / 1000), paycardId).run();

      } catch (error) {
        console.error(`[reconciliation-worker] Failed to settle stream ${paycardId}:`, error);
        const message = (error as Error).message?.slice(0, 500) || "settlement failed";
        await db.prepare(
          "UPDATE plays SET settled = CASE WHEN settlement_attempts >= ? THEN 2 ELSE 0 END, last_error = ?, updated_at = ? WHERE paycard_id = ? AND settled = 3"
        ).bind(maxAttempts, message, Math.floor(Date.now() / 1000), paycardId).run();
      }
    }
  }
};
