import { expect } from "chai";
import {
  createPaidResearchHandler,
  createProviderExampleApp,
  premiumResearchSurface,
  registerPremiumResearchSurface,
} from "../../examples/provider-express/server";

function makeResponse() {
  return {
    statusCode: 0,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  };
}

describe("OpenRails Agent provider Express example", () => {
  it("exports a valid premium research surface and registration payload", () => {
    const registration = registerPremiumResearchSurface({
      providerId: "research.provider.or",
      registerEndpoint: "https://agent.example/api/provider/register",
    });

    expect(premiumResearchSurface.surfaceId).to.equal("provider.premium-research");
    expect(registration.method).to.equal("POST");
    expect(registration.body.manifest.surfaceId).to.equal("provider.premium-research");
    expect(registration.body.manifest.scope).to.equal("premium.research.read");
  });

  it("serves paid research only after OpenRails provider middleware verifies the session", async () => {
    const app = createProviderExampleApp({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, sessionId: "sess_ok", surfaceId: "provider.premium-research", spent: "0.1", remaining: "2.9" }) }) as any,
    });
    const req: any = { query: { sessionId: "sess_ok" }, headers: {} };
    const res = makeResponse();

    await app.handlePremiumResearch(req, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.ok).to.equal(true);
    expect(res.body.result.surfaceId).to.equal("provider.premium-research");
    expect(res.body.result.receipt.sessionId).to.equal("sess_ok");
  });

  it("fails closed with 402 when no valid OpenRails session is attached", async () => {
    const app = createProviderExampleApp({
      verifyEndpoint: "https://agent.example/api/provider/verify-session",
      fetch: async () => ({ ok: false, status: 402, json: async () => ({ valid: false, reason: "session_not_found" }) }) as any,
    });
    const req: any = { query: {}, headers: {} };
    const res = makeResponse();

    await app.handlePremiumResearch(req, res);

    expect(res.statusCode).to.equal(402);
    expect(res.body).to.deep.include({ ok: false, error: "openrails_session_required", reason: "missing_session_id" });
  });

  it("exposes a copy-paste paid route handler that expects middleware-populated session state", async () => {
    const handler = createPaidResearchHandler();
    const req: any = { openrails: { session: { valid: true, sessionId: "sess_direct", spent: "0.25", remaining: "2.75" } } };
    const res = makeResponse();

    await handler(req, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.result.receipt.sessionId).to.equal("sess_direct");
  });
});
