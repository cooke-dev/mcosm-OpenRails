/**
 * OpenRails MCP tool handlers - pure functions of (ctx, args) → result, kept separate from
 * transport so they're unit-testable. The Vault is the source of truth; reads are on-chain
 * projections. Signing/relay is non-custodial: the server signs with its own configured
 * account and never holds anyone else's keys.
 */
import { ethers } from 'ethers';
import {
  createRailsCardIntent,
  createRailsCardClaimLink,
  createRailsFlowRequestLink,
  parseOpenRailsLink,
  payGasless,
  claimGasless,
  signUsdcPermit,
  readPaycard,
  readNonce,
  readTokenBalance,
  hashOpenRailsMetadata,
  buildMetadataBoundPaycardId,
  type CanonicalMetadataV1,
  type OpenRailsIntentV1,
  type RailsCardLinkPayloadV1,
  type RailsFlowLinkPayloadV1,
} from 'openrails-sdk';
import type { OpenRailsContext } from './context.js';

const NONCE_CHANNEL = 0;

// ---- Spend ceiling ------------------------------------------------------------
// Guards the two write tools that commit the MCP signer's own funds (pay_link's RailsFlow-open
// branch, and issue_railscard). Claiming a RailsCard doesn't spend the caller's funds - the payer
// already bounded that amount when they signed the card - so no cap applies there.
const MAX_AMOUNT_BASE_UNITS = parseUsdcCap(process.env.MCP_MAX_AMOUNT_USDC ?? '5');

function parseUsdcCap(value: string): bigint {
  try {
    const parsed = ethers.parseUnits(value, 6);
    if (parsed <= 0n) throw new Error('non-positive');
    return parsed;
  } catch {
    throw new Error('MCP_MAX_AMOUNT_USDC must be a positive decimal USDC amount');
  }
}

function assertWithinAmountCap(amountBaseUnits: string, toolName: string): void {
  const amount = BigInt(amountBaseUnits);
  if (amount > MAX_AMOUNT_BASE_UNITS) {
    throw new Error(
      `${toolName}: amount ${ethers.formatUnits(amount, 6)} USDC exceeds the configured per-call cap of ` +
      `${ethers.formatUnits(MAX_AMOUNT_BASE_UNITS, 6)} USDC. Set MCP_MAX_AMOUNT_USDC to raise it.`,
    );
  }
}

function readPaymentTerms(
  args: { oneTime?: boolean; velocityPerSecond?: string; lifespanSeconds?: number },
  defaultOneTime: boolean,
  toolName: string,
): { oneTime: boolean; velocity: string; lifespan: number } {
  const oneTime = args.oneTime ?? defaultOneTime;
  if (oneTime) return { oneTime, velocity: '0', lifespan: 0 };

  if (args.velocityPerSecond === undefined) {
    throw new Error(`${toolName}: streaming links require velocityPerSecond`);
  }
  let velocity: bigint;
  try {
    velocity = BigInt(args.velocityPerSecond);
  } catch {
    throw new Error(`${toolName}: velocityPerSecond must be a positive integer base-unit amount`);
  }
  if (velocity <= 0n) {
    throw new Error(`${toolName}: velocityPerSecond must be positive for streaming`);
  }
  const lifespanSeconds = args.lifespanSeconds;
  if (!Number.isInteger(lifespanSeconds) || (lifespanSeconds ?? 0) <= 0) {
    throw new Error(`${toolName}: streaming links require positive lifespanSeconds`);
  }

  return { oneTime, velocity: args.velocityPerSecond, lifespan: lifespanSeconds as number };
}

// ---- Idempotency on retry -------------------------------------------------------
// An agent retry after an ambiguous failure (timeout, dropped connection) must not sign and
// submit a second, independent authorization for the same request. Cache the result of an
// identical call for a short TTL and replay it instead of minting a fresh nonce/paycardId.
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const idempotencyCache = new Map<string, { expires: number; result: unknown }>();

async function withIdempotency<T>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const key = `${tool}:${JSON.stringify(args)}`;
  const now = Date.now();
  const cached = idempotencyCache.get(key);
  if (cached && cached.expires > now) return cached.result as T;
  const result = await fn();
  idempotencyCache.set(key, { expires: now + IDEMPOTENCY_TTL_MS, result });
  return result;
}

// The SDK is compiled CommonJS; its .d.ts reference ethers' commonjs type-view, while this ESM
// package resolves ethers to its ESM view. Same runtime ethers, incompatible brand types - so we
// pass the provider through this boundary cast at SDK read calls.
const asProvider = (ctx: OpenRailsContext): any => ctx.provider;

function metadataFor(params: {
  mode: CanonicalMetadataV1['mode'];
  originator: string;
  recipient: string;
  token: string;
  amount: string;
  velocity: string;
  lifespan: number;
}): CanonicalMetadataV1 {
  return {
    version: 'openrails-metadata-v1',
    mode: params.mode,
    originator: params.originator,
    recipient: params.recipient,
    token: params.token,
    amount: params.amount,
    flowVelocityPerSecond: params.velocity,
    lifespanSeconds: params.lifespan,
    metadataRef: 'openrails-mcp',
  };
}

// ---- openrails_config -------------------------------------------------------
export async function openrailsConfig(ctx: OpenRailsContext) {
  let usdcBalance: string | null = null;
  if (ctx.signerAddress) {
    const bal = await readTokenBalance(asProvider(ctx), ctx.config.usdcAddress, ctx.signerAddress);
    usdcBalance = ethers.formatUnits(bal, 6);
  }
  return {
    ...ctx.config,
    signerAddress: ctx.signerAddress ?? null,
    usdcBalance,
    note: 'Vault is the source of truth; balances/state are on-chain projections. Opens/claims are gasless via the relay.',
  };
}

// ---- pay_link ---------------------------------------------------------------
export async function payLink(ctx: OpenRailsContext, args: { link: string }) {
  const artifact = parseOpenRailsLink(args.link);

  if (artifact.kind === 'railscard') {
    const pl = artifact.payload as RailsCardLinkPayloadV1;
    const account = await ctx.requireAccount();
    const claimRecipient = await account.getAddress();
    const res = await claimGasless({ relay: ctx.relay, envelopeToken: pl.envelopeToken, claimRecipient });
    return { kind: 'railscard', action: 'claimed', ...res, explorer: `${ctx.config.explorerBaseUrl}/tx/${res.txHash}` };
  }

  // RailsFlow request → pay it (the signer becomes the payer).
  const pl = artifact.payload as RailsFlowLinkPayloadV1;
  if (pl.expiresAt && Date.now() / 1000 > pl.expiresAt) throw new Error('This request link has expired.');
  assertWithinAmountCap(pl.amount, 'pay_link');

  return withIdempotency('pay_link:railsflow', args, async () => {
    const account = await ctx.requireAccount();
    const client = await ctx.requireClient();
    const payer = await account.getAddress();
    const { hubAddress: hub, usdcAddress: token, chainId } = ctx.config;

    const metadata = metadataFor({
      mode: 'railsflow', originator: payer, recipient: pl.recipient, token,
      amount: pl.amount, velocity: pl.flowVelocityPerSecond, lifespan: pl.lifespanSeconds,
    });
    const metadataHash = hashOpenRailsMetadata(metadata);
    const nonceValue = Number(await readNonce(asProvider(ctx), hub, payer, NONCE_CHANNEL));
    const paycardId = buildMetadataBoundPaycardId({ payer, nonceChannel: NONCE_CHANNEL, nonceValue, metadataHash });
    const intent: OpenRailsIntentV1 = {
      paycardId, metadataHash, recipient: pl.recipient,
      totalAllocationPool: pl.amount, flowVelocityPerSecond: pl.flowVelocityPerSecond,
      genesisTimestamp: Math.floor(Date.now() / 1000), lifespanSeconds: pl.lifespanSeconds,
      residualDeltaRecipient: payer, nonceChannel: NONCE_CHANNEL, nonceValue,
    };
    const permit = await signUsdcPermit(account, { token, spender: hub, value: pl.amount, chainId, provider: asProvider(ctx) });
    const res = await payGasless({ client, relay: ctx.relay, intent, options: { mode: 'railsflow', metadata }, permit });
    return { kind: 'railsflow', action: 'paid', ...res, explorer: `${ctx.config.explorerBaseUrl}/tx/${res.txHash}` };
  });
}

// ---- create_request_link ----------------------------------------------------
export async function createRequestLink(
  ctx: OpenRailsContext,
  args: { amount: string; recipient?: string; oneTime?: boolean; velocityPerSecond?: string; lifespanSeconds?: number },
) {
  const recipient = ethers.getAddress(args.recipient ?? (ctx.signerAddress ?? ethers.ZeroAddress));
  if (recipient === ethers.ZeroAddress) throw new Error('recipient required (no signer configured to default to)');
  const { oneTime, velocity, lifespan } = readPaymentTerms(args, true, 'create_request_link');
  const { hubAddress: hub, usdcAddress: token, chainId, appBaseUrl } = ctx.config;

  const metadata = metadataFor({ mode: 'railsflow', originator: recipient, recipient, token, amount: args.amount, velocity, lifespan });
  const link = createRailsFlowRequestLink({
    appBaseUrl, chainId, vault: hub, token, metadataHash: hashOpenRailsMetadata(metadata),
    payload: { mode: 'railsflow', merchant: recipient, recipient, amount: args.amount, flowVelocityPerSecond: velocity, lifespanSeconds: lifespan, metadataRef: 'openrails-mcp' },
  });
  return { link, recipient, amount: args.amount, type: oneTime ? 'one-time' : 'streaming' };
}

// ---- issue_railscard --------------------------------------------------------
export async function issueRailscard(
  ctx: OpenRailsContext,
  args: {
    amount: string;
    mode?: 'bearer' | 'recipient_bound';
    recipient?: string;
    oneTime?: boolean;
    velocityPerSecond?: string;
    lifespanSeconds?: number;
    acknowledgeBearerRisk?: boolean;
  },
) {
  const bearer = (args.mode ?? 'bearer') === 'bearer';
  if (bearer && args.acknowledgeBearerRisk !== true) {
    throw new Error(
      'issue_railscard: mode "bearer" creates a standing, anyone-with-the-link pull-authorization ' +
      '(first claimant wins, no recipient check). Pass acknowledgeBearerRisk: true to confirm this is ' +
      'intended, or use mode: "recipient_bound" to bind the claim to a specific address instead.',
    );
  }
  assertWithinAmountCap(args.amount, 'issue_railscard');

  return withIdempotency('issue_railscard', args, async () => {
    const account = await ctx.requireAccount();
    const client = await ctx.requireClient();
    const payer = await account.getAddress();
    const recipient = bearer ? ethers.ZeroAddress : ethers.getAddress(args.recipient ?? ethers.ZeroAddress);
    if (!bearer && recipient === ethers.ZeroAddress) throw new Error('recipient_bound cards need a recipient');
    const { oneTime, velocity, lifespan } = readPaymentTerms(args, true, 'issue_railscard');
    const { hubAddress: hub, usdcAddress: token, chainId, appBaseUrl } = ctx.config;
    const mode = bearer ? 'railscard_bearer' : 'railscard_recipient_bound';

    const metadata = metadataFor({ mode, originator: payer, recipient, token, amount: args.amount, velocity, lifespan });
    const metadataHash = hashOpenRailsMetadata(metadata);
    const nonceValue = Number(await readNonce(asProvider(ctx), hub, payer, NONCE_CHANNEL));
    const paycardId = buildMetadataBoundPaycardId({ payer, nonceChannel: NONCE_CHANNEL, nonceValue, metadataHash });
    const intent = createRailsCardIntent({
      paycardId, metadataHash,
      totalAllocationPool: args.amount, flowVelocityPerSecond: velocity,
      genesisTimestamp: Math.floor(Date.now() / 1000), lifespanSeconds: lifespan,
      residualDeltaRecipient: payer, nonceChannel: NONCE_CHANNEL, nonceValue,
    });
    if (!bearer) intent.recipient = recipient;

    const envelopeToken = await client.signPermissionEnvelope(intent, { mode, metadata });
    const link = createRailsCardClaimLink({ appBaseUrl, chainId, vault: hub, token, metadataHash, mode, envelopeToken });
    return {
      link, paycardId, mode, amount: args.amount, type: oneTime ? 'one-time' : 'streaming',
      note: 'Escrow is pulled from the payer on claim - ensure the payer keeps enough USDC allowance/balance when this is claimed.',
    };
  });
}

// ---- paycard_status ---------------------------------------------------------
export async function paycardStatus(ctx: OpenRailsContext, args: { paycardId: string }) {
  const c = await readPaycard(asProvider(ctx), ctx.config.hubAddress, args.paycardId);
  return {
    paycardId: args.paycardId,
    payer: c.payer,
    recipient: c.recipient,
    status: c.operationalStatus,
    totalAllocation: ethers.formatUnits(c.totalAllocationPool, 6),
    availableBalance: ethers.formatUnits(c.availableBalance, 6),
    flowVelocityPerSecond: c.flowVelocityPerSecond.toString(),
    lifespanSeconds: Number(c.lifespanSeconds),
    type: Number(c.lifespanSeconds) === 0 ? 'one-time' : 'streaming',
  };
}
