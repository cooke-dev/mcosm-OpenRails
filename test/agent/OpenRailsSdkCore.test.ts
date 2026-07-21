import { expect } from "chai";
import {
  assertOpenRailsChainMatch,
  getOpenRailsChainConfig,
} from "../../sdk/src/agent/chains";
import {
  assertOpenRailsSurfaceManifest,
  chooseDefaultPrimitive,
  validateOpenRailsSurfaceManifest,
} from "../../sdk/src/agent/manifest";

const ARC_HUB = "0x941C8029F0f912df3fAb7423890ab2359b996D0b";
const USDC = "0x3600000000000000000000000000000000000000";
const PROVIDER = "0x5cF7F9f0e5871c6Ca9afc4A3a86F16A821336f85";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    version: "openrails-surface-v1",
    surfaceId: "premium-research-api",
    name: "Premium Research API",
    description: "Paid research result endpoint for agent callers.",
    type: "api",
    source: "https://provider.example/premium/research",
    recipient: PROVIDER,
    settlementChain: "arc-testnet",
    chainId: 5042002,
    token: {
      symbol: "USDC",
      address: USDC,
      decimals: 6,
    },
    pricing: {
      model: "metered_seconds",
      velocityPerSecondBaseUnits: "10000",
      displayRate: "0.01 USDC/sec",
      maxSessionSeconds: 7200,
    },
    session: {
      heartbeatTimeoutMs: 15000,
      stopOnExitSupported: true,
      residualReturn: "stn-delta-flush",
    },
    scope: "premium:research:read",
    permissions: ["read", "summarize"],
    endpoints: {
      verifySession: "https://provider.example/openrails/verify-session",
      receipt: "https://provider.example/openrails/receipt",
    },
    openrails: {
      supportedPrimitives: ["railsflow", "railscard_bearer"],
      hub: ARC_HUB,
      domainVersion: "2.0.0",
    },
    interop: {
      x402: false,
      paymentLinkFallback: true,
      gatewayFallback: true,
    },
    proof: {
      status: "arc-testnet-proven",
      docs: "https://provider.example/openrails/proof",
    },
    ...overrides,
  };
}

describe("OpenRails Agent sdk-core chain registry", () => {
  it("pins Arc testnet V2 hub, token and EIP-712 domain version", () => {
    const chain = getOpenRailsChainConfig("arc-testnet");

    expect(chain.chainId).to.equal(5042002);
    expect(chain.settlementChain).to.equal("arc-testnet");
    expect(chain.contracts.hub).to.equal(ARC_HUB);
    expect(chain.tokens.USDC.address).to.equal(USDC);
    expect(chain.eip712.domainVersion).to.equal("2.0.0");
  });

  it("rejects wrong chain/hub combinations", () => {
    expect(() => assertOpenRailsChainMatch({
      settlementChain: "arc-testnet",
      chainId: 1,
      hub: ARC_HUB,
    })).to.throw("chainId 1 does not match arc-testnet");

    expect(() => assertOpenRailsChainMatch({
      settlementChain: "arc-testnet",
      chainId: 5042002,
      hub: "0x0000000000000000000000000000000000000001",
    })).to.throw("does not match arc-testnet hub");
  });
});

describe("OpenRails Agent sdk-core surface manifest validation", () => {
  it("accepts a marketplace-indexable Arc payable surface manifest", () => {
    const manifest = assertOpenRailsSurfaceManifest(validManifest());

    expect(manifest.surfaceId).to.equal("premium-research-api");
    expect(manifest.recipient).to.equal(PROVIDER);
    expect(manifest.openrails.hub).to.equal(ARC_HUB);
    expect(manifest.token.address).to.equal(USDC);
    expect(chooseDefaultPrimitive(manifest)).to.equal("railsflow");
  });

  it("rejects malformed or unsafe manifests", () => {
    const result = validateOpenRailsSurfaceManifest(validManifest({
      surfaceId: "Bad Surface!",
      chainId: 1,
      recipient: "0x0000000000000000000000000000000000000000",
      pricing: {
        model: "metered_seconds",
        velocityPerSecondBaseUnits: "0",
      },
      session: {
        heartbeatTimeoutMs: 500,
      },
    }));

    expect(result.ok).to.equal(false);
    expect(result.errors.join("\n")).to.include("surfaceId must be URL-safe");
    expect(result.errors.join("\n")).to.include("recipient must be a non-zero EVM address");
    expect(result.errors.join("\n")).to.include("pricing.velocityPerSecondBaseUnits must be greater than zero");
    expect(result.errors.join("\n")).to.include("metered_seconds pricing requires maxSessionSeconds");
    expect(result.errors.join("\n")).to.include("session.heartbeatTimeoutMs must be between 1000 and 300000");
    expect(result.errors.join("\n")).to.include("chainId 1 does not match arc-testnet");
  });
});
