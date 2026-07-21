import { expect } from "chai";
import {
  buildOpenRailsProviderSurfaceRegistration,
  createOpenRailsProviderMiddleware,
  verifyOpenRailsProviderSession,
} from "../../sdk/src/agent/provider";
import { OPENRAILS_CHAINS } from "../../sdk/src/agent/chains";
import type { OpenRailsSurfaceManifestV1 } from "../../sdk/src/agent/manifest";

const chain = OPENRAILS_CHAINS["arc-testnet"];

function validSurface(overrides: Partial<OpenRailsSurfaceManifestV1> = {}): OpenRailsSurfaceManifestV1 {
  return {
    version: "openrails-surface-v1",
    surfaceId: "provider.premium-research",
    name: "Provider Premium Research",
    description: "Paid provider research route protected by OpenRails session verification.",
    type: "api",
    recipient: "0x08C07d545f3753D6B75aC27eeeF4733Bc3Af400d",
    settlementChain: "arc-testnet",
    chainId: chain.chainId,
    token: { symbol: "USDC", address: chain.tokens.USDC.address, decimals: 6 },
    pricing: {
      model: "metered_seconds",
      velocityPerSecondBaseUnits: "10000",
      maxSessionSeconds: 300,
      displayRate: "0.01 USDC/sec",
    },
    session: { heartbeatTimeoutMs: 30000, stopOnExitSupported: true, residualReturn: "stn-delta-flush" },
    scope: "premium.research.read",
    endpoints: { verifySession: "https://provider.example/api/provider/verify-session" },
    openrails: { supportedPrimitives: ["railsflow", "railscard_bearer"], hub: chain.contracts.hub!, domainVersion: "2.0.0" },
    proof: { status: "arc-testnet-proven" },
    ...overrides,
  };
}

describe("OpenRails Agent provider SDK/middleware", () => {
  it("builds a valid provider surface registration payload", () => {
    const registration = buildOpenRailsProviderSurfaceRegistration(validSurface(), {
      providerId: "research.provider.or",
      registerEndpoint: "https://agent.example/api/provider/register",
    });

    expect(registration).to.deep.include({
      method: "POST",
      providerId: "research.provider.or",
      registerEndpoint: "https://agent.example/api/provider/register",
    });
    expect(registration.headers).to.deep.equal({ "content-type": "application/json" });
    expect(registration.body.manifest.surfaceId).to.equal("provider.premium-research");
    expect(registration.body.manifest.openrails.hub).to.equal(chain.contracts.hub);
  });

  it("rejects invalid surface registration payloads before providers publish them", () => {
    expect(() => buildOpenRailsProviderSurfaceRegistration(validSurface({ recipient: "0x0000000000000000000000000000000000000000" }), {
      providerId: "research.provider.or",
      registerEndpoint: "https://agent.example/api/provider/register",
    })).to.throw("Invalid OpenRails surface manifest");
  });

  it("verifies provider sessions by posting fail-closed verify_session requests", async () => {
    const calls: any[] = [];
    const result = await verifyOpenRailsProviderSession({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      sessionId: "sess_123",
      surfaceId: "provider.premium-research",
      scope: "premium.research.read",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ valid: true, sessionId: "sess_123", surfaceId: "provider.premium-research", spent: "0.1", remaining: "2.9" }),
        } as any;
      },
    });

    expect(result.allowed).to.equal(true);
    expect(result.status).to.equal(200);
    expect(calls[0].url).to.equal("https://agent.example/api/provider/verify-session");
    expect(JSON.parse(calls[0].init.body)).to.deep.equal({ sessionId: "sess_123", surfaceId: "provider.premium-research", scope: "premium.research.read" });
  });

  it("fails closed when verify_session rejects or is unreachable", async () => {
    const rejected = await verifyOpenRailsProviderSession({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      sessionId: "bad",
      surfaceId: "provider.premium-research",
      fetch: async () => ({ ok: false, status: 402, json: async () => ({ valid: false, reason: "session_not_found" }) }) as any,
    });
    const unreachable = await verifyOpenRailsProviderSession({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      sessionId: "bad",
      surfaceId: "provider.premium-research",
      fetch: async () => { throw new Error("network down"); },
    });

    expect(rejected).to.deep.include({ allowed: false, status: 402, reason: "session_not_found" });
    expect(unreachable).to.deep.include({ allowed: false, status: 503, reason: "verify_unreachable" });
  });

  it("wraps provider routes with fail-closed middleware", async () => {
    let nextCalled = false;
    const middleware = createOpenRailsProviderMiddleware({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      surfaceId: "provider.premium-research",
      scope: "premium.research.read",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, sessionId: "sess_123", surfaceId: "provider.premium-research" }) }) as any,
    });
    const req: any = { query: { sessionId: "sess_123" }, headers: {} };
    const res: any = { statusCode: 0, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };

    await middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).to.equal(true);
    expect(req.openrails.session.valid).to.equal(true);

    const closed = createOpenRailsProviderMiddleware({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      surfaceId: "provider.premium-research",
      fetch: async () => ({ ok: false, status: 402, json: async () => ({ valid: false, reason: "session_not_found" }) }) as any,
    });
    const deniedReq: any = { query: {}, headers: {} };
    const deniedRes: any = { statusCode: 0, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
    await closed(deniedReq, deniedRes, () => { throw new Error("must not call next"); });

    expect(deniedRes.statusCode).to.equal(402);
    expect(deniedRes.body).to.deep.include({ ok: false, error: "openrails_session_required", reason: "missing_session_id" });
  });
});
