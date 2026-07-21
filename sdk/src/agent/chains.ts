/**
 * @module agent/chains
 * @description Chain registry for the OpenRails Agent layer only — an application built on top
 * of the OpenRails rail (see `docs/agent/README.md`), not part of the core SDK. The core SDK's
 * CLI/client remain purely env-var/flag-driven (`sdk/src/cli.ts`'s `readChainId`/etc.) and are
 * not retrofitted to this registry.
 */
import { ethers } from 'ethers';

export type OpenRailsEnvironment = 'mainnet' | 'testnet' | 'local';

export type OpenRailsChainKey = 'arc-testnet' | 'hardhat-local';

export interface OpenRailsChainConfig {
  key: OpenRailsChainKey;
  name: string;
  settlementChain: string;
  environment: OpenRailsEnvironment;
  chainId: number;
  rpcUrl?: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts: {
    hub?: string;
    factory?: string;
  };
  tokens: Record<string, {
    symbol: string;
    address: string;
    decimals: number;
  }>;
  eip712: {
    name: 'OpenRails Network';
    domainVersion: '1.0.0' | '2.0.0';
  };
}

export const OPENRAILS_CHAINS = {
  'arc-testnet': {
    key: 'arc-testnet',
    name: 'Arc Testnet',
    settlementChain: 'arc-testnet',
    environment: 'testnet',
    chainId: 5042002,
    rpcUrl: 'https://rpc.testnet.arc.network',
    // USDC is Arc's native gas token — unlike most chains, there is no separate gas asset.
    nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
    contracts: {
      hub: '0x941C8029F0f912df3fAb7423890ab2359b996D0b',
      factory: '0xf85c20858Bac4f9C67a53e4e7a8F31025D07Bc93',
    },
    tokens: {
      USDC: { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 },
    },
    eip712: { name: 'OpenRails Network', domainVersion: '2.0.0' },
  },
  'hardhat-local': {
    key: 'hardhat-local',
    name: 'Hardhat Local',
    settlementChain: 'hardhat-local',
    environment: 'local',
    chainId: 31337,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    contracts: {},
    tokens: {},
    eip712: { name: 'OpenRails Network', domainVersion: '2.0.0' },
  },
} as const satisfies Record<OpenRailsChainKey, OpenRailsChainConfig>;

export function getOpenRailsChainConfig(keyOrChainId: OpenRailsChainKey | number): OpenRailsChainConfig {
  if (typeof keyOrChainId === 'number') {
    const found = Object.values(OPENRAILS_CHAINS).find((chain) => chain.chainId === keyOrChainId);
    if (!found) throw new Error(`Unsupported OpenRails chainId: ${keyOrChainId}`);
    return found;
  }
  return OPENRAILS_CHAINS[keyOrChainId];
}

export function findOpenRailsChainBySettlementChain(settlementChain: string): OpenRailsChainConfig | undefined {
  return Object.values(OPENRAILS_CHAINS).find((chain) => chain.settlementChain === settlementChain);
}

export function normalizeAddress(address: string, fieldName = 'address'): string {
  try {
    const normalized = ethers.getAddress(address);
    if (normalized === ethers.ZeroAddress) throw new Error('zero address');
    return normalized;
  } catch {
    throw new Error(`${fieldName} must be a non-zero EVM address`);
  }
}

export function assertOpenRailsChainMatch(params: {
  settlementChain: string;
  chainId: number;
  hub?: string;
}): OpenRailsChainConfig {
  const config = findOpenRailsChainBySettlementChain(params.settlementChain);
  if (!config) throw new Error(`Unsupported settlementChain: ${params.settlementChain}`);
  if (config.chainId !== params.chainId) {
    throw new Error(`chainId ${params.chainId} does not match ${params.settlementChain} (${config.chainId})`);
  }
  if (params.hub && config.contracts.hub) {
    const expected = normalizeAddress(config.contracts.hub, 'configured hub');
    const actual = normalizeAddress(params.hub, 'hub');
    if (actual !== expected) throw new Error(`hub ${actual} does not match ${params.settlementChain} hub ${expected}`);
  }
  return config;
}
