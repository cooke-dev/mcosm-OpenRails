/**
 * @module agent/provider
 * @description Provider SDK for the OpenRails Agent layer — turns a third-party HTTP service
 * into "payable by agents": register a manifest with a marketplace, and gate routes behind a
 * fail-closed `verify_session` check (denies on any verify failure or network error, never
 * fails open). See `examples/provider-express/` for a full reference server.
 */
import { assertOpenRailsSurfaceManifest, type OpenRailsSurfaceManifestV1 } from './manifest';

export interface OpenRailsProviderSurfaceRegistrationOptions {
  providerId: string;
  registerEndpoint: string;
}

export interface OpenRailsProviderSurfaceRegistration {
  method: 'POST';
  providerId: string;
  registerEndpoint: string;
  headers: { 'content-type': 'application/json' };
  body: {
    providerId: string;
    manifest: OpenRailsSurfaceManifestV1;
  };
}

export interface OpenRailsProviderVerifyRequest {
  verifyEndpoint: string;
  sessionId?: string;
  surfaceId: string;
  scope?: string;
  fetch?: typeof fetch;
}

export interface OpenRailsProviderVerifyResult {
  allowed: boolean;
  status: number;
  reason?: string;
  session?: unknown;
  raw?: unknown;
}

export interface OpenRailsProviderMiddlewareOptions {
  verifyEndpoint: string;
  surfaceId: string;
  scope?: string;
  sessionIdParam?: string;
  sessionIdHeader?: string;
  fetch?: typeof fetch;
}

type MinimalRequest = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  openrails?: Record<string, unknown>;
};

type MinimalResponse = {
  status(code: number): MinimalResponse;
  json(body: unknown): unknown;
};

type MinimalNext = () => void | Promise<void>;

function normalizeEndpoint(endpoint: string, field: string): string {
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${field} must be http(s)`);
    return endpoint;
  } catch (err) {
    if ((err as Error).message.includes('http(s)')) throw err;
    throw new Error(`${field} must be a valid URL`);
  }
}

function extractReason(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.reason === 'string') return record.reason;
    if (typeof record.error === 'string') return record.error;
  }
  return status === 403 ? 'session_forbidden' : 'session_not_verified';
}

function extractSessionId(req: MinimalRequest, param: string, header: string): string | undefined {
  const fromQuery = req.query?.[param];
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery;
  const headers = req.headers || {};
  const exact = headers[header] ?? headers[header.toLowerCase()] ?? headers[header.toUpperCase()];
  if (typeof exact === 'string' && exact.trim()) return exact;
  const auth = headers.authorization ?? headers.Authorization;
  if (typeof auth === 'string' && auth.startsWith('OpenRails ')) return auth.slice('OpenRails '.length).trim();
  return undefined;
}

export function buildOpenRailsProviderSurfaceRegistration(
  manifest: OpenRailsSurfaceManifestV1,
  options: OpenRailsProviderSurfaceRegistrationOptions,
): OpenRailsProviderSurfaceRegistration {
  const validManifest = assertOpenRailsSurfaceManifest(manifest);
  const registerEndpoint = normalizeEndpoint(options.registerEndpoint, 'registerEndpoint');
  if (!options.providerId.trim()) throw new Error('providerId is required');
  return {
    method: 'POST',
    providerId: options.providerId,
    registerEndpoint,
    headers: { 'content-type': 'application/json' },
    body: {
      providerId: options.providerId,
      manifest: validManifest,
    },
  };
}

export async function verifyOpenRailsProviderSession(
  request: OpenRailsProviderVerifyRequest,
): Promise<OpenRailsProviderVerifyResult> {
  const verifyEndpoint = normalizeEndpoint(request.verifyEndpoint, 'verifyEndpoint');
  if (!request.sessionId) return { allowed: false, status: 402, reason: 'missing_session_id' };
  const fetchImpl = request.fetch ?? globalThis.fetch;
  if (!fetchImpl) return { allowed: false, status: 503, reason: 'fetch_unavailable' };
  try {
    const response = await fetchImpl(verifyEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: request.sessionId, surfaceId: request.surfaceId, ...(request.scope ? { scope: request.scope } : {}) }),
    });
    const body = await response.json().catch(() => undefined);
    const valid = Boolean((body as Record<string, unknown> | undefined)?.valid);
    if (!response.ok || !valid) {
      return { allowed: false, status: response.status || 402, reason: extractReason(response.status || 402, body), raw: body };
    }
    return { allowed: true, status: response.status || 200, session: body, raw: body };
  } catch {
    return { allowed: false, status: 503, reason: 'verify_unreachable' };
  }
}

export function createOpenRailsProviderMiddleware(options: OpenRailsProviderMiddlewareOptions) {
  const sessionIdParam = options.sessionIdParam ?? 'sessionId';
  const sessionIdHeader = options.sessionIdHeader ?? 'x-openrails-session-id';
  return async function openRailsProviderMiddleware(req: MinimalRequest, res: MinimalResponse, next: MinimalNext) {
    const sessionId = extractSessionId(req, sessionIdParam, sessionIdHeader);
    const result = await verifyOpenRailsProviderSession({
      verifyEndpoint: options.verifyEndpoint,
      sessionId,
      surfaceId: options.surfaceId,
      scope: options.scope,
      fetch: options.fetch,
    });
    req.openrails = { ...(req.openrails || {}), session: result.session ?? result.raw ?? { valid: false, reason: result.reason } };
    if (result.allowed) return next();
    return res.status(result.status).json({
      ok: false,
      error: 'openrails_session_required',
      reason: result.reason,
      surfaceId: options.surfaceId,
      hint: 'open or attach a valid OpenRails payable session before calling this provider route',
    });
  };
}
