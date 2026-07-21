/**
 * @module agent/discovery
 * @description Service-discovery protocol for the OpenRails Agent layer — a *discovery*
 * mechanism, not a payment mechanism. RailsFlow/RailsCard remain the only payment primitives;
 * this module only builds marketplace indexes and notifications that describe payable surfaces.
 *
 * Safety is enforced by the type system, not convention: `OpenRailsNotificationPayloadV1` hardcodes
 * `requiresUserApproval: true` and `authorizesPayment: false` as literal types — a notification
 * can never carry payment authority by construction.
 */
import { assertOpenRailsSurfaceManifest, type OpenRailsSurfaceManifestV1, type OpenRailsProofStatus, type OpenRailsSupportedPrimitive } from './manifest';

export type OpenRailsDiscoveryEventType =
  | 'marketplace.service_arrived'
  | 'peer.capability_exposed'
  | 'service.terms_changed'
  | 'service.proof_updated'
  | 'service.retired';

export type OpenRailsDiscoveryActionId = 'inspect' | 'quote' | 'negotiate' | 'ignore' | 'mute';
export type OpenRailsNotificationChannel = 'telegram' | 'discord' | 'gmail' | 'local_webhook';

export interface OpenRailsMarketplaceIndexSurface {
  surfaceId: string;
  name: string;
  description?: string;
  type: string;
  scope: string;
  settlementChain: string;
  chainId: number;
  token: OpenRailsSurfaceManifestV1['token'];
  pricing: OpenRailsSurfaceManifestV1['pricing'];
  supportedPrimitives: OpenRailsSupportedPrimitive[];
  proofStatus: OpenRailsProofStatus | 'unknown';
  endpoints?: OpenRailsSurfaceManifestV1['endpoints'];
}

export interface OpenRailsMarketplaceIndexV1 {
  version: 'openrails-marketplace-index-v1';
  marketplaceId: string;
  generatedAt: string;
  surfaces: OpenRailsMarketplaceIndexSurface[];
}

export interface BuildOpenRailsMarketplaceIndexInput {
  marketplaceId: string;
  generatedAt?: string;
  surfaces: OpenRailsSurfaceManifestV1[];
}

export interface OpenRailsDiscoveryEventV1 {
  version: 'openrails-discovery-event-v1';
  type: OpenRailsDiscoveryEventType;
  occurredAt: string;
  openrailsId: string;
  providerId: string;
  surfaceId: string;
  name: string;
  summary?: string;
  proofStatus: OpenRailsProofStatus | 'unknown';
  payment: {
    pricing: OpenRailsSurfaceManifestV1['pricing'];
    token: OpenRailsSurfaceManifestV1['token'];
    settlementChain: string;
    chainId: number;
    supportedPrimitives: OpenRailsSupportedPrimitive[];
  };
  nextActions: OpenRailsDiscoveryActionId[];
  manifest: OpenRailsSurfaceManifestV1;
}

export interface BuildOpenRailsDiscoveryEventInput {
  type: OpenRailsDiscoveryEventType;
  openrailsId: string;
  providerId: string;
  surface: OpenRailsSurfaceManifestV1;
  occurredAt?: string;
}

export interface OpenRailsNotificationPayloadV1 {
  version: 'openrails-notification-v1';
  channel: OpenRailsNotificationChannel;
  title: string;
  markdown: string;
  requiresUserApproval: true;
  authorizesPayment: false;
  actions: Array<{ id: OpenRailsDiscoveryActionId; label: string }>;
  event: OpenRailsDiscoveryEventV1;
}

export type OpenRailsDiscoveryTask =
  | { kind: 'inspect_surface'; surfaceId: string; openrailsId: string; requiresUserApproval: false }
  | { kind: 'quote_surface'; surfaceId: string; openrailsId: string; requiresUserApproval: false }
  | { kind: 'negotiate_terms'; surfaceId: string; openrailsId: string; providerId: string; requiresUserApproval: true }
  | { kind: 'ignore_surface'; surfaceId: string; openrailsId: string; requiresUserApproval: false }
  | { kind: 'mute_surface'; surfaceId: string; openrailsId: string; requiresUserApproval: true };

const DEFAULT_ACTIONS: OpenRailsDiscoveryActionId[] = ['inspect', 'quote', 'negotiate', 'ignore', 'mute'];
const ACTION_LABELS: Record<OpenRailsDiscoveryActionId, string> = {
  inspect: 'Inspect',
  quote: 'Quote',
  negotiate: 'Negotiate terms',
  ignore: 'Ignore',
  mute: 'Mute',
};

function summarizeSurface(surface: OpenRailsSurfaceManifestV1): OpenRailsMarketplaceIndexSurface {
  return {
    surfaceId: surface.surfaceId,
    name: surface.name,
    description: surface.description,
    type: surface.type,
    scope: surface.scope,
    settlementChain: surface.settlementChain,
    chainId: surface.chainId,
    token: surface.token,
    pricing: surface.pricing,
    supportedPrimitives: [...surface.openrails.supportedPrimitives],
    proofStatus: surface.proof?.status ?? 'unknown',
    endpoints: surface.endpoints,
  };
}

export function buildOpenRailsMarketplaceIndex(input: BuildOpenRailsMarketplaceIndexInput): OpenRailsMarketplaceIndexV1 {
  if (!input.marketplaceId.trim()) throw new Error('marketplaceId is required');
  return {
    version: 'openrails-marketplace-index-v1',
    marketplaceId: input.marketplaceId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    surfaces: input.surfaces.map((surface) => summarizeSurface(assertOpenRailsSurfaceManifest(surface))),
  };
}

export function buildOpenRailsDiscoveryEvent(input: BuildOpenRailsDiscoveryEventInput): OpenRailsDiscoveryEventV1 {
  const surface = assertOpenRailsSurfaceManifest(input.surface);
  if (!input.openrailsId.trim()) throw new Error('openrailsId is required');
  if (!input.providerId.trim()) throw new Error('providerId is required');
  return {
    version: 'openrails-discovery-event-v1',
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    openrailsId: input.openrailsId,
    providerId: input.providerId,
    surfaceId: surface.surfaceId,
    name: surface.name,
    summary: surface.description,
    proofStatus: surface.proof?.status ?? 'unknown',
    payment: {
      pricing: surface.pricing,
      token: surface.token,
      settlementChain: surface.settlementChain,
      chainId: surface.chainId,
      supportedPrimitives: [...surface.openrails.supportedPrimitives],
    },
    nextActions: [...DEFAULT_ACTIONS],
    manifest: surface,
  };
}

export function buildOpenRailsNotificationPayload(
  event: OpenRailsDiscoveryEventV1,
  options: { channel: OpenRailsNotificationChannel },
): OpenRailsNotificationPayloadV1 {
  const rate = event.payment.pricing.displayRate
    ?? event.payment.pricing.velocityPerSecondBaseUnits
    ?? event.payment.pricing.amountBaseUnits
    ?? event.payment.pricing.requestPriceBaseUnits
    ?? 'pricing available in manifest';
  return {
    version: 'openrails-notification-v1',
    channel: options.channel,
    title: `New payable service: ${event.name}`,
    requiresUserApproval: true,
    authorizesPayment: false,
    actions: event.nextActions.map((id) => ({ id, label: ACTION_LABELS[id] })),
    event,
    markdown: [
      `## New payable service: ${event.name}`,
      '',
      `OpenRails ID: ${event.openrailsId}`,
      `Provider: ${event.providerId}`,
      `Surface: ${event.surfaceId}`,
      `Pricing: ${rate}`,
      `Token/chain: ${event.payment.token.symbol} on ${event.payment.settlementChain}`,
      `Primitives: ${event.payment.supportedPrimitives.join(', ')}`,
      `Proof: ${event.proofStatus}`,
      '',
      'No payment is authorized by this notification. Choose quote or negotiate before paying.',
    ].join('\n'),
  };
}

export function resolveOpenRailsDiscoveryAction(
  event: OpenRailsDiscoveryEventV1,
  action: OpenRailsDiscoveryActionId,
): OpenRailsDiscoveryTask {
  switch (action) {
    case 'inspect':
      return { kind: 'inspect_surface', surfaceId: event.surfaceId, openrailsId: event.openrailsId, requiresUserApproval: false };
    case 'quote':
      return { kind: 'quote_surface', surfaceId: event.surfaceId, openrailsId: event.openrailsId, requiresUserApproval: false };
    case 'negotiate':
      return { kind: 'negotiate_terms', surfaceId: event.surfaceId, openrailsId: event.openrailsId, providerId: event.providerId, requiresUserApproval: true };
    case 'ignore':
      return { kind: 'ignore_surface', surfaceId: event.surfaceId, openrailsId: event.openrailsId, requiresUserApproval: false };
    case 'mute':
      return { kind: 'mute_surface', surfaceId: event.surfaceId, openrailsId: event.openrailsId, requiresUserApproval: true };
  }
}
