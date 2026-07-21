import {
  buildOpenRailsProviderSurfaceRegistration,
  createOpenRailsProviderMiddleware,
  type OpenRailsProviderMiddlewareOptions,
} from '../../sdk/src/agent/provider';
import { OPENRAILS_CHAINS } from '../../sdk/src/agent/chains';
import type { OpenRailsSurfaceManifestV1 } from '../../sdk/src/agent/manifest';

const chain = OPENRAILS_CHAINS['arc-testnet'];

export const premiumResearchSurface: OpenRailsSurfaceManifestV1 = {
  version: 'openrails-surface-v1',
  surfaceId: 'provider.premium-research',
  name: 'Provider Premium Research',
  description: 'Copy-paste provider example: paid research route protected by OpenRails verify_session.',
  type: 'api',
  recipient: '0x08C07d545f3753D6B75aC27eeeF4733Bc3Af400d',
  settlementChain: 'arc-testnet',
  chainId: chain.chainId,
  token: { symbol: 'USDC', address: chain.tokens.USDC.address, decimals: 6 },
  pricing: {
    model: 'metered_seconds',
    velocityPerSecondBaseUnits: '10000',
    maxSessionSeconds: 300,
    displayRate: '0.01 USDC/sec',
  },
  session: {
    heartbeatTimeoutMs: 30000,
    stopOnExitSupported: true,
    residualReturn: 'stn-delta-flush',
  },
  scope: 'premium.research.read',
  endpoints: {
    verifySession: 'https://provider.example/api/provider/verify-session',
    receipt: 'https://provider.example/api/provider/receipt',
    manifest: 'https://provider.example/.well-known/openrails-surface.json',
  },
  openrails: {
    supportedPrimitives: ['railsflow', 'railscard_bearer'],
    hub: chain.contracts.hub!,
    domainVersion: '2.0.0',
  },
  interop: {
    x402: true,
    paymentLinkFallback: true,
    gatewayFallback: true,
  },
  proof: {
    status: 'arc-testnet-proven',
    docs: 'https://provider.example/docs/openrails-proof',
  },
};

type ExampleRequest = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  openrails?: Record<string, any>;
};

type ExampleResponse = {
  status(code: number): ExampleResponse;
  json(body: unknown): unknown;
};

export function registerPremiumResearchSurface(options: { providerId: string; registerEndpoint: string }) {
  return buildOpenRailsProviderSurfaceRegistration(premiumResearchSurface, options);
}

export function createPaidResearchHandler() {
  return async function paidResearchHandler(req: ExampleRequest, res: ExampleResponse) {
    const session = req.openrails?.session || {};
    return res.status(200).json({
      ok: true,
      result: {
        title: 'Premium Research Result',
        summary: 'This provider response is served only after OpenRails verify_session approves the payable session.',
        surfaceId: premiumResearchSurface.surfaceId,
        scope: premiumResearchSurface.scope,
        receipt: {
          sessionId: session.sessionId,
          spent: session.spent,
          remaining: session.remaining,
        },
      },
    });
  };
}

export function createProviderExampleApp(options: Pick<OpenRailsProviderMiddlewareOptions, 'verifyEndpoint' | 'fetch'>) {
  const middleware = createOpenRailsProviderMiddleware({
    verifyEndpoint: options.verifyEndpoint,
    surfaceId: premiumResearchSurface.surfaceId,
    scope: premiumResearchSurface.scope,
    fetch: options.fetch,
  });
  const paidResearchHandler = createPaidResearchHandler();

  return {
    surface: premiumResearchSurface,
    registerSurface: (input: { providerId: string; registerEndpoint: string }) => registerPremiumResearchSurface(input),
    async handlePremiumResearch(req: ExampleRequest, res: ExampleResponse) {
      let allowed = false;
      await middleware(req, res, async () => {
        allowed = true;
        await paidResearchHandler(req, res);
      });
      return allowed;
    },
  };
}
