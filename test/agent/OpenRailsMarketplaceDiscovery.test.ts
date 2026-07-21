import { expect } from "chai";
import {
  buildOpenRailsMarketplaceIndex,
  buildOpenRailsDiscoveryEvent,
  buildOpenRailsNotificationPayload,
  resolveOpenRailsDiscoveryAction,
} from "../../sdk/src/agent/discovery";
import { premiumResearchSurface } from "../../examples/provider-express/server";

describe("OpenRails Agent marketplace discovery", () => {
  it("builds a local marketplace index from provider surfaces", () => {
    const index = buildOpenRailsMarketplaceIndex({
      marketplaceId: "local.openrails.market",
      generatedAt: "2026-07-10T00:00:00.000Z",
      surfaces: [premiumResearchSurface],
    });

    expect(index.version).to.equal("openrails-marketplace-index-v1");
    expect(index.marketplaceId).to.equal("local.openrails.market");
    expect(index.surfaces).to.have.length(1);
    expect(index.surfaces[0]).to.deep.include({
      surfaceId: "provider.premium-research",
      name: "Provider Premium Research",
      settlementChain: "arc-testnet",
      scope: "premium.research.read",
      proofStatus: "arc-testnet-proven",
    });
    expect(index.surfaces[0].supportedPrimitives).to.deep.equal(["railsflow", "railscard_bearer"]);
    expect(index.surfaces[0].pricing).to.deep.include({ model: "metered_seconds", displayRate: "0.01 USDC/sec" });
  });

  it("emits service_arrived discovery events with openrailsId identity and next actions", () => {
    const event = buildOpenRailsDiscoveryEvent({
      type: "marketplace.service_arrived",
      openrailsId: "premium-research.openrails.or",
      providerId: "research.provider.or",
      surface: premiumResearchSurface,
      occurredAt: "2026-07-10T00:01:00.000Z",
    });

    expect(event).to.deep.include({
      version: "openrails-discovery-event-v1",
      type: "marketplace.service_arrived",
      openrailsId: "premium-research.openrails.or",
      providerId: "research.provider.or",
      surfaceId: "provider.premium-research",
      proofStatus: "arc-testnet-proven",
    });
    expect(event.nextActions).to.deep.equal(["inspect", "quote", "negotiate", "ignore", "mute"]);
    expect(event.payment.supportedPrimitives).to.deep.equal(["railsflow", "railscard_bearer"]);
  });

  it("formats notification payloads without authorizing payment", () => {
    const event = buildOpenRailsDiscoveryEvent({
      type: "marketplace.service_arrived",
      openrailsId: "premium-research.openrails.or",
      providerId: "research.provider.or",
      surface: premiumResearchSurface,
      occurredAt: "2026-07-10T00:01:00.000Z",
    });
    const payload = buildOpenRailsNotificationPayload(event, { channel: "telegram" });

    expect(payload.channel).to.equal("telegram");
    expect(payload.title).to.equal("New payable service: Provider Premium Research");
    expect(payload.requiresUserApproval).to.equal(true);
    expect(payload.authorizesPayment).to.equal(false);
    expect(payload.markdown).to.contain("premium-research.openrails.or");
    expect(payload.markdown).to.contain("0.01 USDC/sec");
    expect(payload.actions.map((action) => action.id)).to.deep.equal(["inspect", "quote", "negotiate", "ignore", "mute"]);
  });

  it("turns discovery actions into safe negotiation tasks", () => {
    const event = buildOpenRailsDiscoveryEvent({
      type: "marketplace.service_arrived",
      openrailsId: "premium-research.openrails.or",
      providerId: "research.provider.or",
      surface: premiumResearchSurface,
      occurredAt: "2026-07-10T00:01:00.000Z",
    });

    expect(resolveOpenRailsDiscoveryAction(event, "quote")).to.deep.include({
      kind: "quote_surface",
      surfaceId: "provider.premium-research",
      requiresUserApproval: false,
    });
    expect(resolveOpenRailsDiscoveryAction(event, "negotiate")).to.deep.include({
      kind: "negotiate_terms",
      openrailsId: "premium-research.openrails.or",
      requiresUserApproval: true,
    });
  });
});
