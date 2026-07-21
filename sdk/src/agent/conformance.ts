/**
 * @module agent/conformance
 * @description Deterministic regression fixtures pinning the OpenRails Agent layer's exact
 * serialization/schema behavior against Arc testnet — the kind of fixture suite a mainnet-facing
 * SDK needs. Ported from the successor repo's X-Layer-targeted fixtures, re-targeted at Arc.
 */
import { ethers } from 'ethers';
import {
  buildOpenRailsDomain,
  buildSettlementIntentValue,
  createRailsCardIntent,
  createRailsFlowIntent,
  hashSettlementIntent,
  OPENRAILS_EIP712_TYPES,
  type OpenRailsIntentV1,
} from '../client';
import {
  buildMetadataBoundPaycardId,
  canonicalizeMetadata,
  hashOpenRailsMetadata,
  type CanonicalMetadataV1,
} from '../metadata';
import { createPaymentReceipt, type OpenRailsPaymentReceipt, createSettlementReceipt, createResidualRecoveryReceipt, type OpenRailsSettlementReceipt, type OpenRailsResidualReceipt } from '../receipts';
import { evaluatePolicyEnvelope, type PolicyEvaluationResult } from '../policy';
import { OPENRAILS_CHAINS } from './chains';

export interface OpenRailsConformanceFixtureV1 {
  version: 'openrails-conformance-v1';
  chain: {
    settlementChain: 'arc-testnet';
    chainId: 5042002;
    hub: string;
    token: string;
    domainVersion: '2.0.0';
  };
  payer: string;
  recipient: string;
  nonceChannel: number;
  nonceValue: number;
  salt: string;
  metadata: CanonicalMetadataV1;
  canonicalMetadata: string;
  metadataHash: string;
  paycardId: string;
  intent: OpenRailsIntentV1;
  eip712Domain: ethers.TypedDataDomain;
  eip712Types: typeof OPENRAILS_EIP712_TYPES;
  eip712Value: Record<string, unknown>;
  intentDigest: string;
  paymentReceipt: OpenRailsPaymentReceipt;
}

export interface OpenRailsConformanceValidationResult {
  ok: boolean;
  errors: string[];
}

export interface OpenRailsRailsCardConformanceFixtureV1 extends OpenRailsConformanceFixtureV1 {
  policy: {
    accepts: PolicyEvaluationResult;
    rejectsWithoutWildcard: PolicyEvaluationResult;
  };
}

export interface OpenRailsPolicyConformanceFixturesV1 {
  acceptsNativeRailsFlow: PolicyEvaluationResult;
  rejectsOverspend: PolicyEvaluationResult;
  rejectsExpiredPolicy: PolicyEvaluationResult;
  acceptsRailsCardWildcard: PolicyEvaluationResult;
}

export interface OpenRailsReceiptConformanceFixturesV1 {
  payment: OpenRailsPaymentReceipt;
  settlement: OpenRailsSettlementReceipt;
  residual: OpenRailsResidualReceipt;
}

export interface OpenRailsNonceConformanceFixtureV1 {
  lane: number;
  sequence: [number, number];
  firstPaycardId: string;
  secondPaycardId: string;
}

export interface OpenRailsSignedIntentFixtureV1 {
  metadata: CanonicalMetadataV1;
  canonicalMetadata: string;
  metadataHash: string;
  paycardId: string;
  intent: OpenRailsIntentV1;
  intentDigest: string;
  signature: string;
  recoveredSigner: string;
}

export interface OpenRailsSignatureConformanceFixturesV1 {
  signer: string;
  privateKeyLabel: 'hardhat-dev-key-0';
  railsflow: OpenRailsSignedIntentFixtureV1;
  railscard: OpenRailsSignedIntentFixtureV1;
}

export interface OpenRailsMarketplaceToolFixtureV1 {
  version: '0.1.0';
  generatedFor: 'openrails-agent-marketplace-conformance';
  positioning: {
    marketplaceLayer: 'discovery_and_routing';
    openrailsLayer: 'payable_session_lifecycle';
  };
  tools: Array<{
    name: string;
    side: 'consumer' | 'provider';
    endpoint: string;
    description: string;
  }>;
}

const PAYER = '0x5cF7F9f0e5871c6Ca9afc4A3a86F16A821336f85';
const RECIPIENT = '0x08C07d545f3753D6B75aC27eeeF4733Bc3Af400d';
const NONCE_CHANNEL = 900719;
const NONCE_VALUE = 7;
const SALT = 'openrails-conformance-v1';
const GENESIS_TIMESTAMP = 1760000000;
const ISSUED_AT = 1760000030;
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
// Public Hardhat development key only. Never replace this with a live/private key.
const SIGNATURE_FIXTURE_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SIGNATURE_FIXTURE_SALT = 'openrails-signature-conformance-v1';

export function buildOpenRailsConformanceMetadata(): CanonicalMetadataV1 {
  return {
    version: 'openrails-metadata-v1',
    mode: 'railsflow',
    originator: PAYER,
    recipient: RECIPIENT,
    token: OPENRAILS_CHAINS['arc-testnet'].tokens.USDC.address,
    amount: '3000000',
    flowVelocityPerSecond: '10000',
    lifespanSeconds: 300,
    workflowId: 'agent-sdk-core-fixture',
    metadataRef: 'openrails://fixture/agent-sdk-core',
    descriptionHash: ethers.keccak256(ethers.toUtf8Bytes('OpenRails Agent SDK-core conformance fixture')),
    expiresAt: 1893456000,
  };
}

export function buildOpenRailsConformanceFixture(): OpenRailsConformanceFixtureV1 {
  const chain = OPENRAILS_CHAINS['arc-testnet'];
  if (!chain.contracts.hub) throw new Error('arc-testnet hub is not configured');
  const metadata = buildOpenRailsConformanceMetadata();
  const canonicalMetadata = canonicalizeMetadata(metadata);
  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({
    payer: PAYER,
    nonceChannel: NONCE_CHANNEL,
    nonceValue: NONCE_VALUE,
    metadataHash,
    salt: SALT,
  });
  const intent = createRailsFlowIntent({
    paycardId,
    metadataHash,
    recipient: RECIPIENT,
    totalAllocationPool: metadata.amount,
    flowVelocityPerSecond: metadata.flowVelocityPerSecond,
    genesisTimestamp: GENESIS_TIMESTAMP,
    lifespanSeconds: metadata.lifespanSeconds,
    residualDeltaRecipient: PAYER,
    nonceChannel: NONCE_CHANNEL,
    nonceValue: NONCE_VALUE,
  });
  const eip712Domain = buildOpenRailsDomain(chain.chainId, chain.contracts.hub, chain.eip712.domainVersion);
  const eip712Value = buildSettlementIntentValue(intent);
  const intentDigest = hashSettlementIntent(intent, chain.chainId, chain.contracts.hub, chain.eip712.domainVersion);
  const paymentReceipt = createPaymentReceipt({
    chainId: chain.chainId,
    hub: chain.contracts.hub,
    token: chain.tokens.USDC.address,
    paycardId,
    metadataHash,
    payer: PAYER,
    recipient: RECIPIENT,
    txHash: TX_HASH,
    blockNumber: 1234567,
    issuedAt: ISSUED_AT,
    totalAllocationPool: metadata.amount,
    flowVelocityPerSecond: metadata.flowVelocityPerSecond,
    lifespanSeconds: metadata.lifespanSeconds,
    residualDeltaRecipient: PAYER,
    nonceChannel: NONCE_CHANNEL,
    nonceValue: NONCE_VALUE,
    metadata,
  });

  return {
    version: 'openrails-conformance-v1',
    chain: {
      settlementChain: 'arc-testnet',
      chainId: chain.chainId as 5042002,
      hub: chain.contracts.hub,
      token: chain.tokens.USDC.address,
      domainVersion: chain.eip712.domainVersion as '2.0.0',
    },
    payer: PAYER,
    recipient: RECIPIENT,
    nonceChannel: NONCE_CHANNEL,
    nonceValue: NONCE_VALUE,
    salt: SALT,
    metadata,
    canonicalMetadata,
    metadataHash,
    paycardId,
    intent,
    eip712Domain,
    eip712Types: OPENRAILS_EIP712_TYPES,
    eip712Value,
    intentDigest,
    paymentReceipt,
  };
}

export function validateOpenRailsConformanceFixture(
  fixture: OpenRailsConformanceFixtureV1,
): OpenRailsConformanceValidationResult {
  const errors: string[] = [];
  const canonicalMetadata = canonicalizeMetadata(fixture.metadata);
  if (fixture.canonicalMetadata !== canonicalMetadata) errors.push('canonicalMetadata mismatch');

  const metadataHash = hashOpenRailsMetadata(fixture.metadata);
  if (fixture.metadataHash !== metadataHash) errors.push('metadataHash mismatch');

  const paycardId = buildMetadataBoundPaycardId({
    payer: fixture.payer,
    nonceChannel: fixture.nonceChannel,
    nonceValue: fixture.nonceValue,
    metadataHash: fixture.metadataHash,
    salt: fixture.salt,
  });
  if (fixture.paycardId !== paycardId) errors.push('paycardId mismatch');
  if (fixture.intent.paycardId !== fixture.paycardId) errors.push('intent.paycardId mismatch');
  if (fixture.intent.metadataHash !== fixture.metadataHash) errors.push('intent.metadataHash mismatch');

  const intentDigest = hashSettlementIntent(
    fixture.intent,
    fixture.chain.chainId,
    fixture.chain.hub,
    fixture.chain.domainVersion,
  );
  if (fixture.intentDigest !== intentDigest) errors.push('intentDigest mismatch');

  if (fixture.paymentReceipt.metadataHash !== fixture.metadataHash) errors.push('paymentReceipt.metadataHash mismatch');
  if (fixture.paymentReceipt.paycardId !== fixture.paycardId) errors.push('paymentReceipt.paycardId mismatch');

  return { ok: errors.length === 0, errors };
}

export function buildOpenRailsRailsCardConformanceFixture(): OpenRailsRailsCardConformanceFixtureV1 {
  const chain = OPENRAILS_CHAINS['arc-testnet'];
  if (!chain.contracts.hub) throw new Error('arc-testnet hub is not configured');
  const zero = ethers.ZeroAddress;
  const metadata: CanonicalMetadataV1 = {
    ...buildOpenRailsConformanceMetadata(),
    mode: 'railscard_bearer',
    recipient: zero,
    workflowId: 'agent-sdk-core-railscard-fixture',
    metadataRef: 'openrails://fixture/agent-sdk-core/railscard',
    descriptionHash: ethers.keccak256(ethers.toUtf8Bytes('OpenRails Agent SDK-core RailsCard bearer conformance fixture')),
  };
  const canonicalMetadata = canonicalizeMetadata(metadata);
  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({
    payer: PAYER,
    nonceChannel: NONCE_CHANNEL + 1,
    nonceValue: NONCE_VALUE,
    metadataHash,
    salt: SALT,
  });
  const intent = createRailsCardIntent({
    paycardId,
    metadataHash,
    totalAllocationPool: metadata.amount,
    flowVelocityPerSecond: metadata.flowVelocityPerSecond,
    genesisTimestamp: GENESIS_TIMESTAMP,
    lifespanSeconds: metadata.lifespanSeconds,
    residualDeltaRecipient: PAYER,
    nonceChannel: NONCE_CHANNEL + 1,
    nonceValue: NONCE_VALUE,
  });
  const eip712Domain = buildOpenRailsDomain(chain.chainId, chain.contracts.hub, chain.eip712.domainVersion);
  const eip712Value = buildSettlementIntentValue(intent);
  const intentDigest = hashSettlementIntent(intent, chain.chainId, chain.contracts.hub, chain.eip712.domainVersion);
  const paymentReceipt = createPaymentReceipt({
    chainId: chain.chainId,
    hub: chain.contracts.hub,
    token: chain.tokens.USDC.address,
    paycardId,
    metadataHash,
    payer: PAYER,
    recipient: zero,
    txHash: TX_HASH,
    blockNumber: 1234568,
    issuedAt: ISSUED_AT,
    totalAllocationPool: metadata.amount,
    flowVelocityPerSecond: metadata.flowVelocityPerSecond,
    lifespanSeconds: metadata.lifespanSeconds,
    residualDeltaRecipient: PAYER,
    nonceChannel: NONCE_CHANNEL + 1,
    nonceValue: NONCE_VALUE,
    metadata,
  });
  return {
    version: 'openrails-conformance-v1',
    chain: {
      settlementChain: 'arc-testnet',
      chainId: chain.chainId as 5042002,
      hub: chain.contracts.hub,
      token: chain.tokens.USDC.address,
      domainVersion: chain.eip712.domainVersion as '2.0.0',
    },
    payer: PAYER,
    recipient: zero,
    nonceChannel: NONCE_CHANNEL + 1,
    nonceValue: NONCE_VALUE,
    salt: SALT,
    metadata,
    canonicalMetadata,
    metadataHash,
    paycardId,
    intent,
    eip712Domain,
    eip712Types: OPENRAILS_EIP712_TYPES,
    eip712Value,
    intentDigest,
    paymentReceipt,
    policy: {
      accepts: evaluatePolicyEnvelope(intent, {
        maxAllocationPool: '3000000',
        maxFlowVelocityPerSecond: '10000',
        maxLifespanSeconds: 300,
        allowWildcardRecipient: true,
        expiresAt: 1893456000,
      }, GENESIS_TIMESTAMP),
      rejectsWithoutWildcard: evaluatePolicyEnvelope(intent, {
        maxAllocationPool: '3000000',
        maxFlowVelocityPerSecond: '10000',
        maxLifespanSeconds: 300,
        allowWildcardRecipient: false,
        expiresAt: 1893456000,
      }, GENESIS_TIMESTAMP),
    },
  };
}

export function buildOpenRailsPolicyConformanceFixtures(): OpenRailsPolicyConformanceFixturesV1 {
  const railsflow = buildOpenRailsConformanceFixture();
  const railscard = buildOpenRailsRailsCardConformanceFixture();
  return {
    acceptsNativeRailsFlow: evaluatePolicyEnvelope(railsflow.intent, {
      maxAllocationPool: '3000000',
      maxFlowVelocityPerSecond: '10000',
      maxLifespanSeconds: 300,
      allowWildcardRecipient: false,
      expiresAt: 1893456000,
    }, GENESIS_TIMESTAMP),
    rejectsOverspend: evaluatePolicyEnvelope(railsflow.intent, {
      maxAllocationPool: '2999999',
      maxFlowVelocityPerSecond: '9999',
      maxLifespanSeconds: 299,
      allowWildcardRecipient: false,
      expiresAt: 1893456000,
    }, GENESIS_TIMESTAMP),
    rejectsExpiredPolicy: evaluatePolicyEnvelope(railsflow.intent, {
      maxAllocationPool: '3000000',
      maxFlowVelocityPerSecond: '10000',
      maxLifespanSeconds: 300,
      allowWildcardRecipient: false,
      expiresAt: GENESIS_TIMESTAMP - 1,
    }, GENESIS_TIMESTAMP),
    acceptsRailsCardWildcard: evaluatePolicyEnvelope(railscard.intent, {
      maxAllocationPool: '3000000',
      maxFlowVelocityPerSecond: '10000',
      maxLifespanSeconds: 300,
      allowWildcardRecipient: true,
      expiresAt: 1893456000,
    }, GENESIS_TIMESTAMP),
  };
}

export function buildOpenRailsReceiptConformanceFixtures(): OpenRailsReceiptConformanceFixturesV1 {
  const base = buildOpenRailsConformanceFixture();
  const settlement = createSettlementReceipt({
    chainId: base.chain.chainId,
    hub: base.chain.hub,
    token: base.chain.token,
    paycardId: base.paycardId,
    metadataHash: base.metadataHash,
    payer: base.payer,
    recipient: base.recipient,
    txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    blockNumber: 1234570,
    issuedAt: ISSUED_AT + 120,
    settledAmount: '1200000',
    remainingAvailableBalance: '1800000',
    metadata: base.metadata,
  });
  const residual = createResidualRecoveryReceipt({
    chainId: base.chain.chainId,
    hub: base.chain.hub,
    token: base.chain.token,
    paycardId: base.paycardId,
    metadataHash: base.metadataHash,
    payer: base.payer,
    recipient: base.recipient,
    txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    blockNumber: 1234571,
    issuedAt: ISSUED_AT + 121,
    recoveredAmount: '1800000',
    recoveryStatus: 'residual_recovered',
    metadata: base.metadata,
  });
  return { payment: base.paymentReceipt, settlement, residual };
}

export function buildOpenRailsNonceConformanceFixture(): OpenRailsNonceConformanceFixtureV1 {
  const base = buildOpenRailsConformanceFixture();
  const secondPaycardId = buildMetadataBoundPaycardId({
    payer: PAYER,
    nonceChannel: NONCE_CHANNEL,
    nonceValue: NONCE_VALUE + 1,
    metadataHash: base.metadataHash,
    salt: SALT,
  });
  return {
    lane: NONCE_CHANNEL,
    sequence: [NONCE_VALUE, NONCE_VALUE + 1],
    firstPaycardId: base.paycardId,
    secondPaycardId,
  };
}

function buildSignatureFixtureIntent(params: {
  mode: 'railsflow' | 'railscard_bearer';
  signer: string;
}): Omit<OpenRailsSignedIntentFixtureV1, 'signature' | 'recoveredSigner'> {
  const chain = OPENRAILS_CHAINS['arc-testnet'];
  if (!chain.contracts.hub) throw new Error('arc-testnet hub is not configured');
  const isRailsCard = params.mode === 'railscard_bearer';
  const nonceChannel = isRailsCard ? 910002 : 910001;
  const metadata: CanonicalMetadataV1 = {
    version: 'openrails-metadata-v1',
    mode: params.mode,
    originator: params.signer,
    recipient: isRailsCard ? ethers.ZeroAddress : RECIPIENT,
    token: chain.tokens.USDC.address,
    amount: '3000000',
    flowVelocityPerSecond: '10000',
    lifespanSeconds: 300,
    workflowId: `agent-sdk-core-signature-${isRailsCard ? 'railscard' : 'railsflow'}`,
    metadataRef: `openrails://fixture/agent-sdk-core/signature/${isRailsCard ? 'railscard' : 'railsflow'}`,
    descriptionHash: ethers.keccak256(ethers.toUtf8Bytes(`OpenRails Agent SDK-core ${isRailsCard ? 'RailsCard bearer' : 'RailsFlow'} signature fixture`)),
    expiresAt: 1893456000,
  };
  const canonicalMetadata = canonicalizeMetadata(metadata);
  const metadataHash = hashOpenRailsMetadata(metadata);
  const paycardId = buildMetadataBoundPaycardId({
    payer: params.signer,
    nonceChannel,
    nonceValue: 1,
    metadataHash,
    salt: SIGNATURE_FIXTURE_SALT,
  });
  const intent = isRailsCard
    ? createRailsCardIntent({
      paycardId,
      metadataHash,
      totalAllocationPool: metadata.amount,
      flowVelocityPerSecond: metadata.flowVelocityPerSecond,
      genesisTimestamp: GENESIS_TIMESTAMP,
      lifespanSeconds: metadata.lifespanSeconds,
      residualDeltaRecipient: params.signer,
      nonceChannel,
      nonceValue: 1,
    })
    : createRailsFlowIntent({
      paycardId,
      metadataHash,
      recipient: RECIPIENT,
      totalAllocationPool: metadata.amount,
      flowVelocityPerSecond: metadata.flowVelocityPerSecond,
      genesisTimestamp: GENESIS_TIMESTAMP,
      lifespanSeconds: metadata.lifespanSeconds,
      residualDeltaRecipient: params.signer,
      nonceChannel,
      nonceValue: 1,
    });
  const intentDigest = hashSettlementIntent(intent, chain.chainId, chain.contracts.hub, chain.eip712.domainVersion);
  return { metadata, canonicalMetadata, metadataHash, paycardId, intent, intentDigest };
}

export async function buildOpenRailsSignatureConformanceFixtures(): Promise<OpenRailsSignatureConformanceFixturesV1> {
  const chain = OPENRAILS_CHAINS['arc-testnet'];
  if (!chain.contracts.hub) throw new Error('arc-testnet hub is not configured');
  const wallet = new ethers.Wallet(SIGNATURE_FIXTURE_PRIVATE_KEY);
  const signer = wallet.address;
  async function sign(mode: 'railsflow' | 'railscard_bearer'): Promise<OpenRailsSignedIntentFixtureV1> {
    const fixture = buildSignatureFixtureIntent({ mode, signer });
    const domain = buildOpenRailsDomain(chain.chainId, chain.contracts.hub!, chain.eip712.domainVersion);
    const signature = await wallet.signTypedData(domain, OPENRAILS_EIP712_TYPES, fixture.intent);
    const recoveredSigner = ethers.verifyTypedData(domain, OPENRAILS_EIP712_TYPES, fixture.intent, signature);
    return { ...fixture, signature, recoveredSigner };
  }
  return {
    signer,
    privateKeyLabel: 'hardhat-dev-key-0',
    railsflow: await sign('railsflow'),
    railscard: await sign('railscard_bearer'),
  };
}

const REQUIRED_MARKETPLACE_TOOLS = [
  'quote_surface',
  'create_payable_session',
  'open_paid_session',
  'heartbeat',
  'stop_session',
  'show_receipt',
  'verify_session',
  'settle_receipt',
];

export function buildOpenRailsMarketplaceToolFixture(): OpenRailsMarketplaceToolFixtureV1 {
  return {
    version: '0.1.0',
    generatedFor: 'openrails-agent-marketplace-conformance',
    positioning: {
      marketplaceLayer: 'discovery_and_routing',
      openrailsLayer: 'payable_session_lifecycle',
    },
    tools: [
      { name: 'quote_surface', side: 'consumer', endpoint: '/api/agent/quote', description: 'Quote a payable surface before opening payment.' },
      { name: 'create_payable_session', side: 'consumer', endpoint: '/api/agent/create-payable-session', description: 'Map natural intent/link/manifest to quote, safe policy, OpenRails primitive plan, and invite.' },
      { name: 'open_paid_session', side: 'consumer', endpoint: '/api/agent/session', description: 'Open a bounded paid session from an approved plan/manifest.' },
      { name: 'heartbeat', side: 'consumer', endpoint: '/api/agent/session/:id/heartbeat', description: 'Keep an active payable session alive while the user or agent is present.' },
      { name: 'stop_session', side: 'consumer', endpoint: '/api/agent/session/:id/stop', description: 'Stop a payable session and trigger settlement/residual return.' },
      { name: 'show_receipt', side: 'consumer', endpoint: '/api/agent/session/:id', description: 'Read session state, events, accounting, and receipt handles.' },
      { name: 'verify_session', side: 'provider', endpoint: '/api/provider/verify-session', description: 'Verify active session, surface, recipient, scope, heartbeat, and accounting before serving paid output.' },
      { name: 'settle_receipt', side: 'provider', endpoint: '/api/demo/premium/research?sessionId=...', description: 'Demo provider result path: only serves after OpenRails session verification.' },
    ],
  };
}

export function validateOpenRailsMarketplaceToolFixture(
  fixture: OpenRailsMarketplaceToolFixtureV1,
): OpenRailsConformanceValidationResult {
  const errors: string[] = [];
  if (fixture.version !== '0.1.0') errors.push('version mismatch');
  if (fixture.positioning.marketplaceLayer !== 'discovery_and_routing') errors.push('marketplaceLayer mismatch');
  if (fixture.positioning.openrailsLayer !== 'payable_session_lifecycle') errors.push('openrailsLayer mismatch');
  const names = fixture.tools.map((tool) => tool.name);
  for (const required of REQUIRED_MARKETPLACE_TOOLS) {
    if (!names.includes(required)) errors.push(`missing tool: ${required}`);
  }
  if (names.length !== new Set(names).size) errors.push('duplicate tool names');
  for (const tool of fixture.tools) {
    if (!tool.description.trim()) errors.push(`tool ${tool.name} missing description`);
    if (!tool.endpoint.startsWith('/')) errors.push(`tool ${tool.name} endpoint must be relative path`);
    if (tool.side !== 'consumer' && tool.side !== 'provider') errors.push(`tool ${tool.name} side invalid`);
  }
  return { ok: errors.length === 0, errors };
}
