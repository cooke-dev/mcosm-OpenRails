import { ethers } from 'ethers';
import {
  EthersAuthoritySignatureVerifier,
  GiwaIdentityResolver,
  JsonFileKernelStore,
  OpenRailsAgentKernel,
  VerificationPluginRegistry,
  type Address,
  type VerificationPluginManifestV1,
} from '../../agent-kernel/dist/index.js';
import type { OpenRailsContext } from './context.js';

const DOJANG_SCROLL_ADDRESS = '0xd5077b67dcb56caC8b270C7788FC3E6ee03F17B9';
const UPBIT_KOREA_ATTESTER_ID = '0xd99b42e778498aa3c9c1f6a012359130252780511687a35982e8e52735453034';
const dojangScrollAbi = [
  'function isVerified(address account, bytes32 attesterId) view returns (bool)',
  'function getVerifiedAddressAttestationUid(address account, bytes32 attesterId) view returns (bytes32)',
] as const;

function statePath(): string {
  return process.env.OPENRAILS_AGENT_KERNEL_STATE_PATH ?? 'artifacts/giwa-agent-kernel/mcp-state.json';
}

export function buildAgentKernel(ctx: OpenRailsContext): {
  kernel: OpenRailsAgentKernel;
  plugins: VerificationPluginRegistry;
} {
  const plugins = new VerificationPluginRegistry();
  const dojang = new ethers.Contract(DOJANG_SCROLL_ADDRESS, dojangScrollAbi, ctx.provider);
  const upIdRpc = process.env.OPENRAILS_UPID_RPC_URL?.trim();
  const upIdProvider = upIdRpc ? new ethers.JsonRpcProvider(upIdRpc) : undefined;

  const identityResolver = new GiwaIdentityResolver({
    async isDojangVerified(address: Address) {
      const [verified, uid] = await Promise.all([
        dojang.isVerified(address, UPBIT_KOREA_ATTESTER_ID) as Promise<boolean>,
        dojang.getVerifiedAddressAttestationUid(address, UPBIT_KOREA_ATTESTER_ID) as Promise<string>,
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
    }),
    plugins,
  };
}

export function bindBuiltinPlugin(
  plugins: VerificationPluginRegistry,
  manifest: VerificationPluginManifestV1,
): void {
  if (manifest.pluginId !== 'proof.hash') return;
  plugins.bind({
    manifest,
    async evaluate(checkpoint) {
      return {
        decision: ethers.isHexString(checkpoint.evidenceHash, 32) ? 'approved' : 'rejected',
        reasonCodes: ethers.isHexString(checkpoint.evidenceHash, 32)
          ? ['EVIDENCE_HASH_VALID']
          : ['EVIDENCE_HASH_INVALID'],
      };
    },
  });
}
