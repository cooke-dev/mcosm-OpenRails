import { ethers } from 'ethers';
import {
  EthersAuthoritySignatureVerifier,
  GIWA_SEPOLIA,
  GiwaIdentityResolver,
  JsonFileKernelStore,
  OpenRailsAgentKernel,
  VerificationPluginRegistry,
  type Address,
  type OpenRailsChainVerifier,
  type OpenRailsOpeningObservationV1,
  type OpenRailsSettlementObservationV1,
  type PactV1,
  type VerificationPlugin,
  type VerificationPluginManifestV1,
} from '../../agent-kernel/dist/index.js';
import type { OpenRailsContext } from './context.js';

const dojangScrollAbi = [
  'function isVerified(address account, bytes32 attesterId) view returns (bool)',
  'function getVerifiedAddressAttestationUid(address account, bytes32 attesterId) view returns (bytes32)',
] as const;
const openRailsAbi = [
  'event PaycardProvisioned(bytes32 indexed paycardId,address indexed payer,address indexed recipient,bytes32 metadataHash,uint256 poolAllocation,uint256 flowVelocityPerSecond,uint256 genesisTimestamp,uint256 lifespanSeconds)',
  'event SettlementFlushed(bytes32 indexed paycardId,address indexed recipient,uint256 amountWithdrawn)',
  'function registry(bytes32 paycardId) view returns (address payer,address recipient,bytes32 metadataHash,uint256 totalAllocationPool,uint256 availableBalance,uint256 flowVelocityPerSecond,uint256 genesisTimestamp,uint256 lifespanSeconds,uint256 lastCheckpointEpoch,address residualDeltaRecipient,uint8 operationalStatus)',
] as const;
const openRailsEvents = new ethers.Interface(openRailsAbi);

function statePath(): string {
  return process.env.OPENRAILS_AGENT_KERNEL_STATE_PATH ?? 'artifacts/giwa-agent-kernel/mcp-state.json';
}

function sameAddress(left: string, right: string): boolean {
  return ethers.getAddress(left) === ethers.getAddress(right);
}

function asSafeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} exceeds the safe integer range`);
  return number;
}

function requirePreparedPayment(pact: PactV1) {
  if (!pact.openRails) throw new Error('Pact has no prepared OpenRails payment');
  return pact.openRails;
}

async function assertCanonicalNetwork(ctx: OpenRailsContext): Promise<void> {
  const network = await ctx.provider.getNetwork();
  if (Number(network.chainId) !== GIWA_SEPOLIA.chainId) {
    throw new Error(`GIWA chain mismatch: expected ${GIWA_SEPOLIA.chainId}, received ${network.chainId}`);
  }
}

function createChainVerifier(ctx: OpenRailsContext): OpenRailsChainVerifier {
  const vault = new ethers.Contract(ctx.config.vaultAddress, openRailsAbi, ctx.provider);

  return {
    async verifyOpening(input): Promise<OpenRailsOpeningObservationV1> {
      await assertCanonicalNetwork(ctx);
      const prepared = requirePreparedPayment(input.pact);
      const receipt = await ctx.provider.getTransactionReceipt(input.openingTxHash);
      if (!receipt) throw new Error('opening transaction is not canonically confirmed on GIWA');
      if (receipt.status !== 1) throw new Error('opening transaction reverted');
      if (!receipt.to || !sameAddress(receipt.to, ctx.config.vaultAddress)) throw new Error('opening transaction target is not the canonical OpenRails vault');

      let eventMatched = false;
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, ctx.config.vaultAddress)) continue;
        try {
          const parsed = openRailsEvents.parseLog(log);
          if (!parsed || parsed.name !== 'PaycardProvisioned') continue;
          eventMatched =
            parsed.args.paycardId === input.paycardId &&
            parsed.args.metadataHash === input.metadataHash &&
            sameAddress(parsed.args.payer, input.pact.paymentTerms.payer) &&
            sameAddress(parsed.args.recipient, input.pact.paymentTerms.recipient) &&
            parsed.args.poolAllocation.toString() === input.pact.paymentTerms.maximumAllocationBaseUnits &&
            parsed.args.flowVelocityPerSecond.toString() === input.pact.paymentTerms.velocityBaseUnitsPerSecond &&
            asSafeNumber(parsed.args.genesisTimestamp, 'opening genesisTimestamp') === prepared.genesisTimestamp &&
            asSafeNumber(parsed.args.lifespanSeconds, 'opening lifespanSeconds') === input.pact.paymentTerms.lifespanSeconds;
          if (eventMatched) break;
        } catch {
          // Ignore unrelated logs from the canonical vault transaction.
        }
      }
      if (!eventMatched) throw new Error('opening transaction does not contain the exact Pact-bound PaycardProvisioned event');

      const card = await vault.registry(input.paycardId);
      if (!sameAddress(card.payer, input.pact.paymentTerms.payer)) throw new Error('canonical Paycard payer does not match the Pact');
      if (!sameAddress(card.recipient, input.pact.paymentTerms.recipient)) throw new Error('canonical Paycard recipient does not match the Pact');
      if (card.metadataHash !== input.metadataHash) throw new Error('canonical Paycard metadata hash does not match the Pact');
      if (card.totalAllocationPool.toString() !== input.pact.paymentTerms.maximumAllocationBaseUnits) throw new Error('canonical Paycard allocation does not match the Pact');
      if (card.flowVelocityPerSecond.toString() !== input.pact.paymentTerms.velocityBaseUnitsPerSecond) throw new Error('canonical Paycard velocity does not match the Pact');
      if (asSafeNumber(card.genesisTimestamp, 'registry genesisTimestamp') !== prepared.genesisTimestamp) throw new Error('canonical Paycard genesis does not match the prepared payment');
      if (asSafeNumber(card.lifespanSeconds, 'registry lifespanSeconds') !== input.pact.paymentTerms.lifespanSeconds) throw new Error('canonical Paycard lifespan does not match the Pact');
      if (!sameAddress(card.residualDeltaRecipient, input.pact.paymentTerms.residualRecipient)) throw new Error('canonical Paycard residual recipient does not match the Pact');
      const operationalStatus = asSafeNumber(card.operationalStatus, 'registry operationalStatus');
      if (operationalStatus !== 0) throw new Error('canonical Paycard is no longer active');
      if (card.availableBalance === 0n) throw new Error('canonical Paycard has no available balance');

      return {
        version: 'openrails-opening-observation-v1',
        transactionHash: input.openingTxHash,
        chainId: ctx.config.chainId,
        vault: ctx.config.vaultAddress as Address,
        paycardId: input.paycardId,
        metadataHash: input.metadataHash,
        payer: ethers.getAddress(card.payer) as Address,
        recipient: ethers.getAddress(card.recipient) as Address,
        residualRecipient: ethers.getAddress(card.residualDeltaRecipient) as Address,
        poolAllocationBaseUnits: card.totalAllocationPool.toString(),
        flowVelocityBaseUnitsPerSecond: card.flowVelocityPerSecond.toString(),
        genesisTimestamp: asSafeNumber(card.genesisTimestamp, 'opening genesisTimestamp'),
        lifespanSeconds: asSafeNumber(card.lifespanSeconds, 'opening lifespanSeconds'),
        availableBalanceBaseUnits: card.availableBalance.toString(),
        operationalStatus,
        blockNumber: receipt.blockNumber,
        observedAt: new Date().toISOString(),
      };
    },

    async verifySettlement(input): Promise<OpenRailsSettlementObservationV1> {
      await assertCanonicalNetwork(ctx);
      const prepared = requirePreparedPayment(input.pact);
      const receipt = await ctx.provider.getTransactionReceipt(input.txHash);
      if (!receipt) throw new Error('settlement transaction is not canonically confirmed on GIWA');
      if (receipt.status !== 1) throw new Error('settlement transaction reverted');
      if (!receipt.to || !sameAddress(receipt.to, ctx.config.vaultAddress)) throw new Error('settlement transaction target is not the canonical OpenRails vault');

      let settled = 0n;
      for (const log of receipt.logs) {
        if (!sameAddress(log.address, ctx.config.vaultAddress)) continue;
        try {
          const parsed = openRailsEvents.parseLog(log);
          if (!parsed || parsed.name !== 'SettlementFlushed') continue;
          if (parsed.args.paycardId !== prepared.paycardId) continue;
          if (!sameAddress(parsed.args.recipient, input.pact.paymentTerms.recipient)) throw new Error('settlement recipient does not match the Pact');
          settled += parsed.args.amountWithdrawn;
        } catch (error) {
          if (error instanceof Error && error.message === 'settlement recipient does not match the Pact') throw error;
        }
      }
      if (settled === 0n) throw new Error('settlement transaction contains no Pact-bound SettlementFlushed event');
      if (settled.toString() !== input.settledAmountBaseUnits) throw new Error('settlement amount does not match the canonical event');

      const card = await vault.registry(prepared.paycardId);
      if (!sameAddress(card.recipient, input.pact.paymentTerms.recipient)) throw new Error('canonical Paycard recipient changed');
      const final = Number(card.operationalStatus) === 1;

      return {
        version: 'openrails-settlement-observation-v1',
        transactionHash: input.txHash,
        chainId: ctx.config.chainId,
        vault: ctx.config.vaultAddress as Address,
        paycardId: prepared.paycardId,
        recipient: ethers.getAddress(card.recipient) as Address,
        settledAmountBaseUnits: settled.toString(),
        final,
        blockNumber: receipt.blockNumber,
        observedAt: new Date().toISOString(),
      };
    },
  };
}

export function buildAgentKernel(ctx: OpenRailsContext): {
  kernel: OpenRailsAgentKernel;
  plugins: VerificationPluginRegistry;
} {
  const plugins = new VerificationPluginRegistry();
  if (ctx.config.chainId !== GIWA_SEPOLIA.chainId) throw new Error(`Agent Kernel requires GIWA Sepolia chain ${GIWA_SEPOLIA.chainId}`);
  if (!sameAddress(ctx.config.vaultAddress, GIWA_SEPOLIA.vaultAddress)) throw new Error("Agent Kernel vault configuration does not match the canonical GIWA deployment");
  if (!sameAddress(ctx.config.tokenAddress, GIWA_SEPOLIA.tokenAddress)) throw new Error("Agent Kernel token configuration does not match the canonical GIWA deployment");
  const dojang = new ethers.Contract(GIWA_SEPOLIA.dojangScrollAddress, dojangScrollAbi, ctx.provider);
  const upIdRpc = process.env.OPENRAILS_UPID_RPC_URL?.trim();
  const upIdProvider = upIdRpc ? new ethers.JsonRpcProvider(upIdRpc) : undefined;

  const identityResolver = new GiwaIdentityResolver({
    async isDojangVerified(address: Address) {
      await assertCanonicalNetwork(ctx);
      const [verified, uid] = await Promise.all([
        dojang.isVerified(address, GIWA_SEPOLIA.upbitKoreaAttesterId) as Promise<boolean>,
        dojang.getVerifiedAddressAttestationUid(address, GIWA_SEPOLIA.upbitKoreaAttesterId) as Promise<string>,
      ]);
      return {
        verified,
        ...(uid && uid !== ethers.ZeroHash ? { reference: uid } : {}),
      };
    },
    async resolveUpId(address: Address) {
      if (!upIdProvider) return {};
      try {
        const name = await upIdProvider.lookupAddress(address);
        if (!name || !name.toLowerCase().endsWith('.up.id')) return {};
        const forward = await upIdProvider.resolveName(name);
        return {
          name,
          forwardResolutionMatches: Boolean(forward && ethers.getAddress(forward) === ethers.getAddress(address)),
        };
      } catch {
        return {};
      }
    },
  });

  return {
    kernel: new OpenRailsAgentKernel({
      store: new JsonFileKernelStore(statePath()),
      signatureVerifier: new EthersAuthoritySignatureVerifier(),
      pluginRegistry: plugins,
      identityResolver,
      chainVerifier: createChainVerifier(ctx),
    }),
    plugins,
  };
}

export function createBuiltinPlugin(manifest: VerificationPluginManifestV1): VerificationPlugin | undefined {
  if (manifest.pluginId !== 'proof.hash.dev') return undefined;
  return {
    manifest,
    async evaluate(checkpoint) {
      return {
        decision: ethers.isHexString(checkpoint.evidenceHash, 32) ? 'review' : 'rejected',
        reasonCodes: ethers.isHexString(checkpoint.evidenceHash, 32)
          ? ['DEV_HASH_SYNTAX_VALID_REQUIRES_REVIEW']
          : ['EVIDENCE_HASH_INVALID'],
      };
    },
  };
}
