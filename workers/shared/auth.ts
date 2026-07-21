/**
 * Shared admin/webhook bearer-token check for OpenRails Cloudflare Workers.
 *
 * Each worker previously carried an identical copy of this function; a fix to one copy had no
 * way to propagate to the others. This is a plain relative-path import (no npm workspace) — each
 * worker is bundled independently by wrangler/esbuild from its own `src/index.ts`, which resolves
 * relative filesystem imports outside its own directory just fine.
 *
 * Accepts either `Authorization: Bearer <secret>` or a worker-specific fallback header (each
 * worker historically used its own name — `X-OpenRails-Webhook-Secret`,
 * `X-OpenRails-Admin-Token` — preserved here rather than unified, to avoid a breaking header
 * rename for existing integrators).
 */
export function authorized(request: Request, secret: string | undefined, fallbackHeader: string): boolean {
  if (!secret) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerSecret = request.headers.get(fallbackHeader) || '';
  return bearer === secret || headerSecret === secret;
}
