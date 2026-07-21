/**
 * @module agent/manifest
 * @description Surface manifest schema for the OpenRails Agent layer — describes a payable
 * service (a "surface") in a chain-agnostic, validated shape. Part of the agent application
 * layer, not the core payment primitives (see `docs/agent/README.md`).
 */
import { ethers } from 'ethers';
import {
  assertOpenRailsChainMatch,
  findOpenRailsChainBySettlementChain,
  normalizeAddress,
} from './chains';

export const OPENRAILS_SURFACE_MANIFEST_VERSION = 'openrails-surface-v1' as const;

export type OpenRailsSurfaceType =
  | 'api'
  | 'agent_service'
  | 'live_session'
  | 'compute'
  | 'gateway'
  | 'media'
  | 'other';

export type OpenRailsPricingModel =
  | 'one_time'
  | 'metered_seconds'
  | 'metered_requests'
  | 'bounded_budget'
  | 'x402_challenge';

export type OpenRailsSupportedPrimitive =
  | 'railsflow'
  | 'railscard_bearer'
  | 'railscard_recipient_bound'
  | 'x402'
  | 'gateway';

export interface OpenRailsTokenRef {
  symbol: string;
  address: string;
  decimals: number;
}

export interface OpenRailsPricingSpec {
  model: OpenRailsPricingModel;
  velocityPerSecondBaseUnits?: string;
  amountBaseUnits?: string;
  requestPriceBaseUnits?: string;
  displayRate?: string;
  maxSessionSeconds?: number;
}

export interface OpenRailsSessionSpec {
  heartbeatTimeoutMs: number;
  stopOnExitSupported?: boolean;
  residualReturn?: 'stn-delta-flush' | 'none' | 'external';
}

export type OpenRailsProofStatus = 'local' | 'demo' | 'arc-testnet-proven' | 'mainnet' | 'audited';

export interface OpenRailsSurfaceManifestV1 {
  version: typeof OPENRAILS_SURFACE_MANIFEST_VERSION;
  surfaceId: string;
  name: string;
  description?: string;
  type: OpenRailsSurfaceType;
  source?: string;
  recipient: string;
  settlementChain: string;
  chainId: number;
  token: OpenRailsTokenRef;
  pricing: OpenRailsPricingSpec;
  session: OpenRailsSessionSpec;
  scope: string;
  permissions?: string[];
  endpoints?: {
    verifySession?: string;
    receipt?: string;
    manifest?: string;
  };
  openrails: {
    supportedPrimitives: OpenRailsSupportedPrimitive[];
    hub: string;
    domainVersion: '1.0.0' | '2.0.0';
  };
  interop?: {
    x402?: boolean;
    paymentLinkFallback?: boolean;
    gatewayFallback?: boolean;
  };
  proof?: {
    status?: OpenRailsProofStatus;
    docs?: string;
  };
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: OpenRailsSurfaceManifestV1;
}

export class OpenRailsManifestError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid OpenRails surface manifest: ${errors.join('; ')}`);
    this.name = 'OpenRailsManifestError';
  }
}

const SURFACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,80}$/;
const SURFACE_TYPES: OpenRailsSurfaceType[] = ['api', 'agent_service', 'live_session', 'compute', 'gateway', 'media', 'other'];
const PRICING_MODELS: OpenRailsPricingModel[] = ['one_time', 'metered_seconds', 'metered_requests', 'bounded_budget', 'x402_challenge'];
const PRIMITIVES: OpenRailsSupportedPrimitive[] = ['railsflow', 'railscard_bearer', 'railscard_recipient_bound', 'x402', 'gateway'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(target: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const value = target[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${key} must be a non-empty string`);
    return undefined;
  }
  return value;
}

function requirePositiveInteger(target: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  const value = target[key];
  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push(`${key} must be a positive integer`);
    return undefined;
  }
  return Number(value);
}

function validateIntegerString(value: unknown, field: string, errors: string[], allowZero = true): string | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    errors.push(`${field} must be an integer string in base units`);
    return undefined;
  }
  if (!allowZero && BigInt(value) <= 0n) errors.push(`${field} must be greater than zero`);
  return value;
}

function normalizeOptionalUrl(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${field} must be a URL string`);
    return undefined;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${field} must be http(s)`);
    return value;
  } catch {
    errors.push(`${field} must be a valid URL`);
    return undefined;
  }
}

export function validateOpenRailsSurfaceManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['manifest must be an object'] };

  if (input.version !== OPENRAILS_SURFACE_MANIFEST_VERSION) {
    errors.push(`version must be ${OPENRAILS_SURFACE_MANIFEST_VERSION}`);
  }

  const surfaceId = requireString(input, 'surfaceId', errors);
  if (surfaceId && !SURFACE_ID_PATTERN.test(surfaceId)) errors.push('surfaceId must be URL-safe and 3-81 chars');

  const name = requireString(input, 'name', errors);
  const type = requireString(input, 'type', errors) as OpenRailsSurfaceType | undefined;
  if (type && !SURFACE_TYPES.includes(type)) errors.push(`type must be one of: ${SURFACE_TYPES.join(', ')}`);

  const recipientRaw = requireString(input, 'recipient', errors);
  let recipient = recipientRaw;
  if (recipientRaw) {
    try { recipient = normalizeAddress(recipientRaw, 'recipient'); } catch (err) { errors.push((err as Error).message); }
  }

  const settlementChain = requireString(input, 'settlementChain', errors);
  const chainId = requirePositiveInteger(input, 'chainId', errors);

  if (!isRecord(input.token)) {
    errors.push('token must be an object');
  }
  const token = isRecord(input.token) ? input.token : {};
  const tokenSymbol = requireString(token, 'symbol', errors);
  const tokenAddressRaw = requireString(token, 'address', errors);
  let tokenAddress = tokenAddressRaw;
  if (tokenAddressRaw) {
    try { tokenAddress = normalizeAddress(tokenAddressRaw, 'token.address'); } catch (err) { errors.push((err as Error).message); }
  }
  const tokenDecimals = requirePositiveInteger(token, 'decimals', errors);

  if (!isRecord(input.pricing)) errors.push('pricing must be an object');
  const pricing = isRecord(input.pricing) ? input.pricing : {};
  const model = requireString(pricing, 'model', errors) as OpenRailsPricingModel | undefined;
  if (model && !PRICING_MODELS.includes(model)) errors.push(`pricing.model must be one of: ${PRICING_MODELS.join(', ')}`);
  const velocity = pricing.velocityPerSecondBaseUnits === undefined
    ? undefined
    : validateIntegerString(pricing.velocityPerSecondBaseUnits, 'pricing.velocityPerSecondBaseUnits', errors, false);
  const amount = pricing.amountBaseUnits === undefined
    ? undefined
    : validateIntegerString(pricing.amountBaseUnits, 'pricing.amountBaseUnits', errors, false);
  const requestPrice = pricing.requestPriceBaseUnits === undefined
    ? undefined
    : validateIntegerString(pricing.requestPriceBaseUnits, 'pricing.requestPriceBaseUnits', errors, false);
  const maxSessionSeconds = pricing.maxSessionSeconds === undefined ? undefined : requirePositiveInteger(pricing, 'maxSessionSeconds', errors);
  if (model === 'metered_seconds') {
    if (!velocity) errors.push('metered_seconds pricing requires velocityPerSecondBaseUnits');
    if (!maxSessionSeconds) errors.push('metered_seconds pricing requires maxSessionSeconds');
  }

  if (!isRecord(input.session)) errors.push('session must be an object');
  const session = isRecord(input.session) ? input.session : {};
  const heartbeatTimeoutMs = requirePositiveInteger(session, 'heartbeatTimeoutMs', errors);
  if (heartbeatTimeoutMs !== undefined && (heartbeatTimeoutMs < 1000 || heartbeatTimeoutMs > 300000)) {
    errors.push('session.heartbeatTimeoutMs must be between 1000 and 300000');
  }

  const scope = requireString(input, 'scope', errors);
  const permissions = input.permissions === undefined
    ? undefined
    : Array.isArray(input.permissions) && input.permissions.every((item) => typeof item === 'string')
      ? input.permissions as string[]
      : undefined;
  if (input.permissions !== undefined && permissions === undefined) errors.push('permissions must be an array of strings');

  if (!isRecord(input.openrails)) errors.push('openrails must be an object');
  const openrails = isRecord(input.openrails) ? input.openrails : {};
  const hubRaw = requireString(openrails, 'hub', errors);
  let hub = hubRaw;
  if (hubRaw) {
    try { hub = normalizeAddress(hubRaw, 'openrails.hub'); } catch (err) { errors.push((err as Error).message); }
  }
  const domainVersion = requireString(openrails, 'domainVersion', errors);
  if (domainVersion && !['1.0.0', '2.0.0'].includes(domainVersion)) errors.push('openrails.domainVersion must be 1.0.0 or 2.0.0');
  const supportedPrimitives = Array.isArray(openrails.supportedPrimitives)
    ? openrails.supportedPrimitives.filter((primitive): primitive is OpenRailsSupportedPrimitive => typeof primitive === 'string' && PRIMITIVES.includes(primitive as OpenRailsSupportedPrimitive))
    : [];
  if (!Array.isArray(openrails.supportedPrimitives) || supportedPrimitives.length !== openrails.supportedPrimitives.length || supportedPrimitives.length === 0) {
    errors.push(`openrails.supportedPrimitives must include one or more of: ${PRIMITIVES.join(', ')}`);
  }
  if (supportedPrimitives.includes('railsflow') && recipient === ethers.ZeroAddress) {
    errors.push('railsflow surfaces require a non-zero fixed recipient');
  }

  if (settlementChain && chainId && hub) {
    try { assertOpenRailsChainMatch({ settlementChain, chainId, hub }); } catch (err) { errors.push((err as Error).message); }
  }
  const chain = settlementChain ? findOpenRailsChainBySettlementChain(settlementChain) : undefined;
  if (chain && tokenSymbol && tokenAddress) {
    const known = chain.tokens[tokenSymbol];
    if (known && normalizeAddress(known.address, 'configured token') !== tokenAddress) {
      errors.push(`token.address does not match known ${tokenSymbol} for ${settlementChain}`);
    }
  }

  const endpoints = isRecord(input.endpoints) ? {
    verifySession: normalizeOptionalUrl(input.endpoints.verifySession, 'endpoints.verifySession', errors),
    receipt: normalizeOptionalUrl(input.endpoints.receipt, 'endpoints.receipt', errors),
    manifest: normalizeOptionalUrl(input.endpoints.manifest, 'endpoints.manifest', errors),
  } : undefined;
  const source = normalizeOptionalUrl(input.source, 'source', errors);
  const proofStatus = isRecord(input.proof) && ['local', 'demo', 'arc-testnet-proven', 'mainnet', 'audited'].includes(String(input.proof.status))
    ? input.proof.status as OpenRailsProofStatus
    : undefined;

  const manifest: OpenRailsSurfaceManifestV1 | undefined = errors.length === 0 ? {
    version: OPENRAILS_SURFACE_MANIFEST_VERSION,
    surfaceId: surfaceId!,
    name: name!,
    description: typeof input.description === 'string' ? input.description : undefined,
    type: type!,
    source,
    recipient: recipient!,
    settlementChain: settlementChain!,
    chainId: chainId!,
    token: { symbol: tokenSymbol!, address: tokenAddress!, decimals: tokenDecimals! },
    pricing: {
      model: model!,
      velocityPerSecondBaseUnits: velocity,
      amountBaseUnits: amount,
      requestPriceBaseUnits: requestPrice,
      displayRate: typeof pricing.displayRate === 'string' ? pricing.displayRate : undefined,
      maxSessionSeconds,
    },
    session: {
      heartbeatTimeoutMs: heartbeatTimeoutMs!,
      stopOnExitSupported: Boolean(session.stopOnExitSupported),
      residualReturn: ['stn-delta-flush', 'none', 'external'].includes(String(session.residualReturn))
        ? session.residualReturn as OpenRailsSessionSpec['residualReturn']
        : undefined,
    },
    scope: scope!,
    permissions,
    endpoints,
    openrails: {
      supportedPrimitives,
      hub: hub!,
      domainVersion: domainVersion as '1.0.0' | '2.0.0',
    },
    interop: isRecord(input.interop) ? {
      x402: Boolean(input.interop.x402),
      paymentLinkFallback: Boolean(input.interop.paymentLinkFallback),
      gatewayFallback: Boolean(input.interop.gatewayFallback),
    } : undefined,
    proof: isRecord(input.proof) ? {
      status: proofStatus,
      docs: typeof input.proof.docs === 'string' ? input.proof.docs : undefined,
    } : undefined,
  } : undefined;

  return { ok: errors.length === 0, errors, manifest };
}

export function assertOpenRailsSurfaceManifest(input: unknown): OpenRailsSurfaceManifestV1 {
  const result = validateOpenRailsSurfaceManifest(input);
  if (!result.ok || !result.manifest) throw new OpenRailsManifestError(result.errors);
  return result.manifest;
}

export function chooseDefaultPrimitive(manifest: OpenRailsSurfaceManifestV1): OpenRailsSupportedPrimitive {
  if (manifest.openrails.supportedPrimitives.includes('railsflow') && manifest.recipient !== ethers.ZeroAddress) return 'railsflow';
  if (manifest.openrails.supportedPrimitives.includes('railscard_recipient_bound')) return 'railscard_recipient_bound';
  if (manifest.openrails.supportedPrimitives.includes('railscard_bearer')) return 'railscard_bearer';
  if (manifest.openrails.supportedPrimitives.includes('x402')) return 'x402';
  return manifest.openrails.supportedPrimitives[0];
}
