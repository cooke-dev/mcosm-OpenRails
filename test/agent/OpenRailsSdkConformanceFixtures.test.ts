import { expect } from "chai";
import {
  buildOpenRailsConformanceFixture,
  buildOpenRailsRailsCardConformanceFixture,
  buildOpenRailsPolicyConformanceFixtures,
  buildOpenRailsReceiptConformanceFixtures,
  buildOpenRailsNonceConformanceFixture,
  buildOpenRailsSignatureConformanceFixtures,
  buildOpenRailsMarketplaceToolFixture,
  validateOpenRailsMarketplaceToolFixture,
  validateOpenRailsConformanceFixture,
} from "../../sdk/src/agent/conformance";

// Vectors below are the real output of the ported fixture builders against Arc testnet
// (chain, hub, USDC, workflow labels) — computed once from a clean build and pinned here so any
// future drift in wire-format/serialization is caught, same discipline as the successor's
// original X-Layer-targeted vectors.
const EXPECTED_CANONICAL_METADATA = "{\"amount\":\"3000000\",\"descriptionHash\":\"0x98518a419ebc25723be46d1d896a34ab58565c43bac0fd93436f78709356b0f0\",\"expiresAt\":1893456000,\"flowVelocityPerSecond\":\"10000\",\"lifespanSeconds\":300,\"metadataRef\":\"openrails://fixture/agent-sdk-core\",\"mode\":\"railsflow\",\"originator\":\"0x5cF7F9f0e5871c6Ca9afc4A3a86F16A821336f85\",\"recipient\":\"0x08C07d545f3753D6B75aC27eeeF4733Bc3Af400d\",\"token\":\"0x3600000000000000000000000000000000000000\",\"version\":\"openrails-metadata-v1\",\"workflowId\":\"agent-sdk-core-fixture\"}";
const EXPECTED_METADATA_HASH = "0x632856bb6f8f9368c11fec3422fecad313117ccc54ca3c810538fda365a64bf2";
const EXPECTED_PAYCARD_ID = "0xd2206dd0c19cad57cca24a16ec1d98caaf977734b48ac4dbff08a5d9058ee873";
const EXPECTED_INTENT_DIGEST = "0xa29fc1e930d31f06502b1e6a501c7f67df2b6596bffb2e3e2b4a5d8a5c88b142";

describe("OpenRails Agent sdk-core deterministic conformance fixture", () => {
  it("emits stable metadata, Paycard ID, and EIP-712 digest vectors", () => {
    const fixture = buildOpenRailsConformanceFixture();

    expect(fixture.canonicalMetadata).to.equal(EXPECTED_CANONICAL_METADATA);
    expect(fixture.metadataHash).to.equal(EXPECTED_METADATA_HASH);
    expect(fixture.paycardId).to.equal(EXPECTED_PAYCARD_ID);
    expect(fixture.intentDigest).to.equal(EXPECTED_INTENT_DIGEST);
    expect(fixture.intent).to.deep.equal({
      paycardId: EXPECTED_PAYCARD_ID,
      metadataHash: EXPECTED_METADATA_HASH,
      recipient: "0x08C07d545f3753D6B75aC27eeeF4733Bc3Af400d",
      totalAllocationPool: "3000000",
      flowVelocityPerSecond: "10000",
      genesisTimestamp: 1760000000,
      lifespanSeconds: 300,
      residualDeltaRecipient: "0x5cF7F9f0e5871c6Ca9afc4A3a86F16A821336f85",
      nonceChannel: 900719,
      nonceValue: 7,
    });
  });

  it("validates a fixture and detects drift in any wire-format field", () => {
    const fixture = buildOpenRailsConformanceFixture();
    expect(validateOpenRailsConformanceFixture(fixture)).to.deep.equal({ ok: true, errors: [] });

    const drifted = {
      ...fixture,
      intent: {
        ...fixture.intent,
        flowVelocityPerSecond: "10001",
      },
    };
    const result = validateOpenRailsConformanceFixture(drifted);

    expect(result.ok).to.equal(false);
    expect(result.errors).to.include("intentDigest mismatch");
  });

  it("emits a stable RailsCard bearer fixture with zero signed recipient", () => {
    const fixture = buildOpenRailsRailsCardConformanceFixture();

    expect(fixture.metadata.mode).to.equal("railscard_bearer");
    expect(fixture.metadata.recipient).to.equal("0x0000000000000000000000000000000000000000");
    expect(fixture.intent.recipient).to.equal("0x0000000000000000000000000000000000000000");
    expect(fixture.policy.accepts.approved).to.equal(true);
    expect(fixture.policy.rejectsWithoutWildcard.approved).to.equal(false);
    expect(fixture.policy.rejectsWithoutWildcard.reasons).to.include("wildcard_recipient_disallowed");
    expect(fixture.intentDigest).to.match(/^0x[0-9a-f]{64}$/);
    expect(fixture.paycardId).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("pins policy accept/reject fixtures for caps, velocity, lifespan and expiry", () => {
    const fixtures = buildOpenRailsPolicyConformanceFixtures();

    expect(fixtures.acceptsNativeRailsFlow).to.deep.equal({ approved: true, reasons: [] });
    expect(fixtures.rejectsOverspend.reasons).to.deep.equal([
      "allocation_exceeds_policy",
      "velocity_exceeds_policy",
      "lifespan_exceeds_policy",
    ]);
    expect(fixtures.rejectsExpiredPolicy).to.deep.equal({ approved: false, reasons: ["policy_expired"] });
    expect(fixtures.acceptsRailsCardWildcard).to.deep.equal({ approved: true, reasons: [] });
  });

  it("emits settlement and residual receipt fixtures bound to the same Paycard", () => {
    const receipts = buildOpenRailsReceiptConformanceFixtures();

    expect(receipts.payment.type).to.equal("payment_opened");
    expect(receipts.settlement.type).to.equal("settlement_processed");
    expect(receipts.residual.type).to.equal("residual_recovered");
    expect(receipts.settlement.paycardId).to.equal(receipts.payment.paycardId);
    expect(receipts.residual.paycardId).to.equal(receipts.payment.paycardId);
    expect(receipts.settlement.settledAmount).to.equal("1200000");
    expect(receipts.residual.recoveredAmount).to.equal("1800000");
    expect(receipts.residual.finalStatus).to.equal("Terminated");
  });

  it("pins nonce lane fixtures and detects nonce drift through Paycard ID changes", () => {
    const fixture = buildOpenRailsNonceConformanceFixture();

    expect(fixture.lane).to.equal(900719);
    expect(fixture.sequence).to.deep.equal([7, 8]);
    expect(fixture.firstPaycardId).to.not.equal(fixture.secondPaycardId);
    expect(fixture.firstPaycardId).to.equal(EXPECTED_PAYCARD_ID);
  });

  it("pins deterministic RailsFlow and RailsCard signature fixtures", async () => {
    const signatures = await buildOpenRailsSignatureConformanceFixtures();

    expect(signatures.signer).to.equal("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(signatures.railsflow.signature).to.equal("0xfdabfa076b02eb89e7750ade1bffa18616fef7fe6a573537d365235718022924379c52b77451871c26114034d64bc88eef19d568bae1a66c0ee5b7b0f2454cb11b");
    expect(signatures.railsflow.recoveredSigner).to.equal(signatures.signer);
    expect(signatures.railsflow.intentDigest).to.equal("0xa5499f4fdf2a56677c4be37513b3ec4c48d0bd5275ef313d775c42dd9984cce6");
    expect(signatures.railsflow.paycardId).to.equal("0xb85cca7bf39e7f411af63c5e23c35710ba14da9ad7f72835c6c6f3df7fbb9243");

    expect(signatures.railscard.signature).to.equal("0xc388101a18e9ee4d84fb375cc827d27020118566034fb207aa868e170c3495a341d7ecaa9381d3a20179751d3882ea188c6a3d964cbe211d1cb40a81985953e81c");
    expect(signatures.railscard.recoveredSigner).to.equal(signatures.signer);
    expect(signatures.railscard.intent.recipient).to.equal("0x0000000000000000000000000000000000000000");
    expect(signatures.railscard.intentDigest).to.equal("0x86d2499fc03d87b527e89cec835345dbd05a92ce4f5bb38a06154cb234b31dbc");
    expect(signatures.railscard.paycardId).to.equal("0x0aee1687c205727271445f9713bc4de35378eb7e655ba14c6fbb27f04ff374c9");
  });

  it("emits and validates the marketplace tool manifest fixture", () => {
    const tools = buildOpenRailsMarketplaceToolFixture();
    const validation = validateOpenRailsMarketplaceToolFixture(tools);

    expect(validation).to.deep.equal({ ok: true, errors: [] });
    expect(tools.tools.map((tool) => tool.name)).to.deep.equal([
      "quote_surface",
      "create_payable_session",
      "open_paid_session",
      "heartbeat",
      "stop_session",
      "show_receipt",
      "verify_session",
      "settle_receipt",
    ]);
    expect(tools.positioning.marketplaceLayer).to.equal("discovery_and_routing");
    expect(tools.positioning.openrailsLayer).to.equal("payable_session_lifecycle");
  });
});
