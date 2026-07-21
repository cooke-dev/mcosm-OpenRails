/**
 * @module client
 * @description Core EIP-712 signing client for the current OpenRails permission-envelope layer.
 *
 * Produces cryptographic permission envelopes that authorize the on-chain
 * clearinghouse to stream funds from a payer's paycard to a recipient at a
 * specified flow velocity.
 */

import { ethers } from 'ethers';
import type { OpenRailsAccount } from './account';
import {
  type CanonicalMetadataV1,
  type OpenRailsEnvelopeMode,
  hashOpenRailsMetadata,
} from './metadata';
import { deserializeEnvelope, serializeEnvelope } from './serialization';
import {
  ClockSkewError,
  PayloadSerializationError,
  SignatureVerificationError,
} from './errors';

// ---------------------------------------------------------------------------
// Intent & envelope types
// ---------------------------------------------------------------------------

/**
 * On-chain settlement intent payload matching the `SettlementIntent` struct
 * expected by the Arc Clearinghouse contract.
 */
export interface OpenRailsIntentV1 {
  /** Unique bytes32 hex identifier for this paycard. */
  paycardId: string;
  /** Canonical invoice/card metadata hash. */
  metadataHash: string;
  /** Target merchant / recipient node address. */
  recipient: string;
  /** Total allocation pool in base units (includes STN-Delta protective buffer). */
  totalAllocationPool: string;
  /** Flow velocity R - consumption rate vector in base-units per second. */
  flowVelocityPerSecond: string;
  /** Epoch start time (unix seconds). */
  genesisTimestamp: number;
  /** Total track validity horizon in seconds. */
  lifespanSeconds: number;
  /** Recovery vault address for unspent buffer residual. */
  residualDeltaRecipient: string;
  /** Nonce channel for replay protection. */
  nonceChannel: number;
  /** Nonce value within the channel. */
  nonceValue: number;
}

/**
 * Complete cryptographic envelope containing the payer identity, the
 * EIP-712 signature, and the intent payload.
 */
export interface CryptographicEnvelopeV1 {
  payerAddress: string;
  envelopeSignature: string;
  intent: OpenRailsIntentV1;
  mode?: OpenRailsEnvelopeMode;
  metadata?: CanonicalMetadataV1;
}

export interface SignPermissionEnvelopeOptions {
  mode?: OpenRailsEnvelopeMode;
  metadata?: CanonicalMetadataV1;
}

export interface RailsCardClaimPayloadV1 {
  envelopeToken: string;
  claimRecipient: string;
}

export const OPENRAILS_ZERO_ADDRESS = ethers.ZeroAddress;

export const OPENRAILS_EIP712_TYPES = {
  SettlementIntent: [
    { name: 'paycardId', type: 'bytes32' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'totalAllocationPool', type: 'uint256' },
    { name: 'flowVelocityPerSecond', type: 'uint256' },
    { name: 'genesisTimestamp', type: 'uint256' },
    { name: 'lifespanSeconds', type: 'uint256' },
    { name: 'residualDeltaRecipient', type: 'address' },
    { name: 'nonceChannel', type: 'uint256' },
    { name: 'nonceValue', type: 'uint256' },
  ],
};

// Deployed hub addresses with a known-correct domain version, lowercased. Used only for the
// friendlier early warning below - the contract itself is the real enforcement (a mismatched
// domain version simply fails signature verification on-chain, per SignatureChecker).
const KNOWN_HUB_DOMAIN_VERSIONS: Record<string, string> = {
  '0x941c8029f0f912df3fab7423890ab2359b996d0b': '2.0.0', // V2 canonical hub
  '0x01ec54846524d043fd808152d41596bef603381d': '1.0.0', // V1 hub (frozen, draining)
};

export function buildOpenRailsDomain(
  chainId: number,
  verifyingContract: string,
  version = '2.0.0', // V2 default; pass '1.0.0' to target the frozen/draining V1 hub
): ethers.TypedDataDomain {
  const expectedVersion = KNOWN_HUB_DOMAIN_VERSIONS[verifyingContract.toLowerCase()];
  if (expectedVersion && expectedVersion !== version) {
    console.warn(
      `[openrails-sdk] EIP-712 domain version "${version}" looks mismatched for hub ` +
        `${verifyingContract} (expected "${expectedVersion}"). A mismatched domain will simply fail ` +
        'signature verification on-chain - this warning just surfaces it earlier. Pass the intended ' +
        'domain version explicitly if this is deliberate (e.g. deploying a new hub).',
    );
  }
  return {
    name: 'OpenRails Network',
    version,
    chainId,
    verifyingContract,
  };
}

export function buildSettlementIntentValue(intent: OpenRailsIntentV1): Record<string, unknown> {
  return {
    paycardId: intent.paycardId,
    metadataHash: intent.metadataHash,
    recipient: intent.recipient,
    totalAllocationPool: intent.totalAllocationPool,
    flowVelocityPerSecond: intent.flowVelocityPerSecond,
    genesisTimestamp: intent.genesisTimestamp,
    lifespanSeconds: intent.lifespanSeconds,
    residualDeltaRecipient: intent.residualDeltaRecipient,
    nonceChannel: intent.nonceChannel,
    nonceValue: intent.nonceValue,
  };
}

export function hashSettlementIntent(
  intent: OpenRailsIntentV1,
  chainId: number,
  verifyingContract: string,
  version = '2.0.0',
): string {
  return ethers.TypedDataEncoder.hash(
    buildOpenRailsDomain(chainId, verifyingContract, version),
    OPENRAILS_EIP712_TYPES,
    buildSettlementIntentValue(intent),
  );
}

export function createRailsFlowIntent(params: OpenRailsIntentV1): OpenRailsIntentV1 {
  if (params.recipient === OPENRAILS_ZERO_ADDRESS) {
    throw new PayloadSerializationError('RailsFlow requires a fixed recipient', ['recipient']);
  }
  return { ...params };
}

export function createRailsCardIntent(params: Omit<OpenRailsIntentV1, 'recipient'>): OpenRailsIntentV1 {
  return {
    ...params,
    recipient: OPENRAILS_ZERO_ADDRESS,
  };
}

export function createInstantSettlementIntent(params: OpenRailsIntentV1): OpenRailsIntentV1 {
  return {
    ...params,
    lifespanSeconds: 0,
  };
}

export function inferEnvelopeModeFromIntent(intent: OpenRailsIntentV1): OpenRailsEnvelopeMode {
  return intent.recipient === OPENRAILS_ZERO_ADDRESS ? 'railscard_bearer' : 'railsflow';
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * High-level client for building, signing, and verifying OpenRails
 * permission envelopes.
 *
 * @example
 * ```ts
 * const client = new LeptonOpenRailsClient(PRIVATE_KEY, CONTRACT, 1);
 * const token  = await client.signPermissionEnvelope(intent);
 * ```
 */
export class LeptonOpenRailsClient {
  /** The signing account. An ethers.Wallet (private-key path) already satisfies this. */
  private account: OpenRailsAccount;
  /** Checksummed signer address, resolved once at construction (kept for sync `getAddress`). */
  private address: string;
  private contractAddress: string;
  private chainId: number;
  private clockSkewBufferSeconds: number;
  /** EIP-712 domain version. Default '2.0.0' (V2 hub); pass '1.0.0' to target the frozen V1 hub. */
  private domainVersion: string;

  /**
   * @param privateKey              - hex-encoded ECDSA private key
   * @param contractAddress         - address of the on-chain clearinghouse
   * @param chainId                 - EIP-155 chain identifier
   * @param provider                - optional JSON-RPC provider
   * @param clockSkewBufferSeconds  - maximum acceptable future-dating of
   *                                  `genesisTimestamp` relative to local
   *                                  clock (default `60`).
   */
  constructor(
    privateKey: string,
    contractAddress: string,
    chainId: number,
    provider?: ethers.Provider,
    clockSkewBufferSeconds: number = 60,
    domainVersion: string = '2.0.0',
  ) {
    const wallet = new ethers.Wallet(privateKey, provider);
    this.account = wallet;
    this.address = wallet.address;
    this.contractAddress = contractAddress;
    this.chainId = chainId;
    this.clockSkewBufferSeconds = clockSkewBufferSeconds;
    this.domainVersion = domainVersion;
  }

  /**
   * Construct a client from any {@link OpenRailsAccount} - an embedded wallet
   * (Privy/Turnkey), a server wallet, or an adapter-wrapped signer. This is the
   * seam that lets OpenRails onboard users/agents without a raw private key.
   *
   * Async because a generic account resolves its address asynchronously.
   */
  public static async fromAccount(
    account: OpenRailsAccount,
    contractAddress: string,
    chainId: number,
    clockSkewBufferSeconds: number = 60,
    domainVersion: string = '2.0.0',
  ): Promise<LeptonOpenRailsClient> {
    const client = Object.create(LeptonOpenRailsClient.prototype) as LeptonOpenRailsClient;
    client.account = account;
    client.address = ethers.getAddress(await account.getAddress());
    client.contractAddress = contractAddress;
    client.chainId = chainId;
    client.clockSkewBufferSeconds = clockSkewBufferSeconds;
    client.domainVersion = domainVersion;
    return client;
  }

  /** Returns the checksummed signer address. */
  public getAddress(): string {
    return this.address;
  }

  // -----------------------------------------------------------------------
  // Signing
  // -----------------------------------------------------------------------

  /**
   * Generates a fully typed EIP-712 signature matrix matching the Arc
   * Clearinghouse state parameters, performs post-sign verification and
   * clock-skew checks, and returns a Base64 URL-safe transport token.
   *
   * @param intent - settlement intent to sign
   * @returns Base64 URL-safe envelope token
   *
   * @throws {ClockSkewError}              if the intent is future-dated
   * @throws {SignatureVerificationError}   if the sanity-check recovery
   *                                        yields an unexpected signer
   * @throws {PayloadSerializationError}    if envelope encoding fails
   */
  public async signPermissionEnvelope(
    intent: OpenRailsIntentV1,
    options: SignPermissionEnvelopeOptions = {},
  ): Promise<string> {
    // ----- Clock-skew guard -----
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (intent.genesisTimestamp > nowSeconds + this.clockSkewBufferSeconds) {
      throw new ClockSkewError(
        nowSeconds,
        intent.genesisTimestamp,
        this.clockSkewBufferSeconds,
      );
    }

    // ----- EIP-712 domain -----
    const domain = buildOpenRailsDomain(this.chainId, this.contractAddress, this.domainVersion);

    if (intent.nonceChannel === undefined || intent.nonceValue === undefined) {
      throw new PayloadSerializationError('nonceChannel and nonceValue are required', [
        'nonceChannel',
        'nonceValue',
      ]);
    }

    if (options.metadata && hashOpenRailsMetadata(options.metadata) !== intent.metadataHash) {
      throw new PayloadSerializationError('metadata does not match intent.metadataHash', [
        'metadataHash',
      ]);
    }

    const mode =
      options.mode ?? options.metadata?.mode ?? inferEnvelopeModeFromIntent(intent);

    const types = OPENRAILS_EIP712_TYPES;

    // ----- Structured value (mirrors type field order) -----
    const value = buildSettlementIntentValue(intent);

    // ----- Sign (through the pluggable account) -----
    const signature = await this.account.signTypedData(domain, types, value);

    // ----- Signature sanity check -----
    if (!this.account.isSmartAccount) {
      const recoveredSigner = ethers.verifyTypedData(domain, types, value, signature);
      if (recoveredSigner.toLowerCase() !== this.address.toLowerCase()) {
        throw new SignatureVerificationError(this.address, recoveredSigner);
      }
    }

    // ----- Build envelope & serialize -----
    const completePayload: CryptographicEnvelopeV1 = {
      payerAddress: this.address,
      envelopeSignature: signature,
      intent,
      mode,
      metadata: options.metadata,
    };

    return serializeEnvelope(completePayload);
  }

  // -----------------------------------------------------------------------
  // Static deserialization
  // -----------------------------------------------------------------------

  /**
   * Decodes an inbound transport token back into its structured validation
   * elements.
   *
   * @param token - Base64 URL-safe encoded envelope token
   * @returns parsed {@link CryptographicEnvelopeV1}
   * @throws {PayloadSerializationError} if the token cannot be decoded
   */
  public static deserializePayload(token: string): CryptographicEnvelopeV1 {
    return deserializeEnvelope<CryptographicEnvelopeV1>(token);
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible alias (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use {@link LeptonOpenRailsClient} instead.
 */
export type OpenRailsArcClient = LeptonOpenRailsClient;

/**
 * @deprecated Use {@link LeptonOpenRailsClient} instead.
 *
 * Re-exported constructor alias so that `new OpenRailsArcClient(...)` still
 * compiles for existing consumers.
 */
export const OpenRailsArcClient: typeof LeptonOpenRailsClient = LeptonOpenRailsClient;
