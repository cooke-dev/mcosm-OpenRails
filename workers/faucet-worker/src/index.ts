import { ethers } from "ethers";
import { authorized } from "../../shared/auth";

export interface Env {
  ARC_RPC_URL: string;
  ARC_CHAIN_ID: string;
  ARC_USDC_ADDRESS: string;
  FAUCET_SIGNER_KEY?: string;
  FAUCET_ADMIN_TOKEN?: string;
  FAUCET_DRIP_AMOUNT_USDC?: string;
  FAUCET_MAX_BALANCE_USDC?: string;
  FAUCET_MAX_DRIPS_PER_DAY?: string;
  FAUCET_COOLDOWN_SECONDS?: string;
  FAUCET_ENABLED?: string;
  FAUCET_CLAIMS: KVNamespace;
}

// USDC on Arc is fixed at 6 decimals — hardcoded (matches reconciliation-worker's existing
// scaling convention) rather than an extra balanceOf-adjacent RPC call per request.
const USDC_DECIMALS = 6;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-OpenRails-Admin-Token",
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Ordered checks, cheapest/safest first: kill switch -> signer configured -> validate address ->
// per-address AND per-IP cooldown (a per-address-only cooldown doesn't stop someone generating
// many fresh addresses from one source) -> daily cap -> recipient's current balance (skip, not an
// error, if already funded) -> faucet wallet's own balance (clear "needs a top-up", not a raw tx
// failure) -> send.
async function handleFund(request: Request, env: Env): Promise<Response> {
  if ((env.FAUCET_ENABLED ?? "true").toLowerCase() === "false") {
    return jsonResponse({ error: "Faucet is disabled" }, 503);
  }
  if (!env.FAUCET_SIGNER_KEY) {
    return jsonResponse({ error: "Faucet signer is not configured" }, 503);
  }

  let body: { address?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  if (!body.address || !isEvmAddress(body.address)) {
    return jsonResponse({ error: "Invalid or missing address" }, 400);
  }
  const address = ethers.getAddress(body.address);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const cooldownSeconds = readPositiveInt(env.FAUCET_COOLDOWN_SECONDS, 86400);
  const addrKey = `addr:${address.toLowerCase()}`;
  const ipKey = `ip:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  const addrCooldown = await env.FAUCET_CLAIMS.get(addrKey);
  const ipCooldown = ip !== "unknown" ? await env.FAUCET_CLAIMS.get(ipKey) : null;
  for (const [label, stored] of [["address", addrCooldown], ["IP", ipCooldown]] as const) {
    if (stored) {
      const claimedAt = Number(stored);
      const retryAfterSeconds = Math.max(0, cooldownSeconds - (now - claimedAt));
      return jsonResponse({ error: `Faucet cooldown active for this ${label}`, retryAfterSeconds }, 429);
    }
  }

  const dayKey = `day:${utcDateString(new Date())}`;
  const maxDripsPerDay = readPositiveInt(env.FAUCET_MAX_DRIPS_PER_DAY, 500);
  const todayCountRaw = await env.FAUCET_CLAIMS.get(dayKey);
  const todayCount = todayCountRaw ? Number(todayCountRaw) : 0;
  if (todayCount >= maxDripsPerDay) {
    return jsonResponse({ error: "Daily faucet cap reached, try again tomorrow" }, 429);
  }

  const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
  const signer = new ethers.Wallet(env.FAUCET_SIGNER_KEY, provider);
  const usdc = new ethers.Contract(env.ARC_USDC_ADDRESS, ERC20_ABI, signer);

  const maxBalance = ethers.parseUnits(env.FAUCET_MAX_BALANCE_USDC ?? "0.10", USDC_DECIMALS);
  const recipientBalance: bigint = await usdc.balanceOf(address);
  if (recipientBalance >= maxBalance) {
    return jsonResponse({
      skipped: true,
      reason: "already funded",
      balance: ethers.formatUnits(recipientBalance, USDC_DECIMALS),
    });
  }

  const dripAmountStr = env.FAUCET_DRIP_AMOUNT_USDC ?? "0.05";
  const dripAmount = ethers.parseUnits(dripAmountStr, USDC_DECIMALS);
  const faucetBalance: bigint = await usdc.balanceOf(signer.address);
  if (faucetBalance < dripAmount) {
    return jsonResponse(
      {
        error: "Faucet needs a top-up",
        faucetAddress: signer.address,
        balance: ethers.formatUnits(faucetBalance, USDC_DECIMALS),
      },
      503
    );
  }

  try {
    const tx = await usdc.transfer(address, dripAmount);
    await tx.wait();

    await Promise.all([
      env.FAUCET_CLAIMS.put(addrKey, String(now), { expirationTtl: cooldownSeconds }),
      env.FAUCET_CLAIMS.put(ipKey, String(now), { expirationTtl: cooldownSeconds }),
      env.FAUCET_CLAIMS.put(dayKey, String(todayCount + 1), { expirationTtl: 172800 }),
    ]);

    console.log(`[faucet] funded ${address} with ${dripAmountStr} USDC (${tx.hash})`);
    return jsonResponse({ txHash: tx.hash, amount: dripAmountStr });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message?.slice(0, 300) || "faucet transfer failed" }, 502);
  }
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  if (!env.FAUCET_ADMIN_TOKEN) return jsonResponse({ error: "Faucet admin token is not configured" }, 503);
  if (!authorized(request, env.FAUCET_ADMIN_TOKEN, "X-OpenRails-Admin-Token")) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!env.FAUCET_SIGNER_KEY) return jsonResponse({ error: "Faucet signer is not configured" }, 503);

  const provider = new ethers.JsonRpcProvider(env.ARC_RPC_URL);
  const signer = new ethers.Wallet(env.FAUCET_SIGNER_KEY, provider);
  const usdc = new ethers.Contract(env.ARC_USDC_ADDRESS, ERC20_ABI, provider);
  const balance: bigint = await usdc.balanceOf(signer.address);

  const dayKey = `day:${utcDateString(new Date())}`;
  const todayCountRaw = await env.FAUCET_CLAIMS.get(dayKey);

  return jsonResponse({
    faucetAddress: signer.address,
    balanceUsdc: ethers.formatUnits(balance, USDC_DECIMALS),
    todayDripCount: todayCountRaw ? Number(todayCountRaw) : 0,
    maxDripsPerDay: readPositiveInt(env.FAUCET_MAX_DRIPS_PER_DAY, 500),
    enabled: (env.FAUCET_ENABLED ?? "true").toLowerCase() !== "false",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/fund") {
        if (request.method !== "POST") return jsonResponse({ error: "Only POST requests allowed" }, 405);
        return handleFund(request, env);
      }

      if (url.pathname === "/status") {
        if (request.method !== "GET") return jsonResponse({ error: "Only GET requests allowed" }, 405);
        return handleStatus(request, env);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  },
};
