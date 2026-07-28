import { ethers } from 'ethers';

import type { WalletNetworkParams } from './wallet';

export const GIWA_SEPOLIA_CHAIN_ID = 91_342;

export interface OpenRailsNetworkConfig {
  key: string;
  chainId: number;
  chainName: string;

  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };

  rpcUrls: {
    canonical: string;
    flashblocks: string;
  };

  explorerUrl: string;
  deploymentBlock: number;

  settlementToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    testOnly: boolean;
  };

  contracts: {
    masterImplementation: string;
    factory: string;
    canonicalVault: string;
  };
}

export const GIWA_SEPOLIA_OPENRAILS:
  Readonly<OpenRailsNetworkConfig> = {
    key: 'giwaSepolia',
    chainId: GIWA_SEPOLIA_CHAIN_ID,
    chainName: 'GIWA Sepolia',

    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },

    rpcUrls: {
      canonical:
        'https://sepolia-rpc.giwa.io',
      flashblocks:
        'https://sepolia-rpc-flashblocks.giwa.io',
    },

    explorerUrl:
      'https://sepolia-explorer.giwa.io',

    deploymentBlock: 31_909_070,

    settlementToken: {
      address:
        '0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De',
      name: 'OpenRails Test USD',
      symbol: 'orUSD',
      decimals: 6,
      testOnly: true,
    },

    contracts: {
      masterImplementation:
        '0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb',
      factory:
        '0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d',
      canonicalVault:
        '0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1',
    },
  };

export function getOpenRailsNetworkByChainId(
  chainId: number,
): Readonly<OpenRailsNetworkConfig> {
  if (chainId === GIWA_SEPOLIA_CHAIN_ID) {
    return GIWA_SEPOLIA_OPENRAILS;
  }

  throw new Error(
    `Unsupported OpenRails chain ID: ${chainId}`,
  );
}

export function toWalletNetworkParams(
  network: OpenRailsNetworkConfig =
    GIWA_SEPOLIA_OPENRAILS,
): WalletNetworkParams {
  return {
    chainId: network.chainId,
    chainName: network.chainName,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: [network.rpcUrls.canonical],
    blockExplorerUrls: [
      network.explorerUrl,
    ],
  };
}

export function createOpenRailsProvider(
  options: {
    network?: OpenRailsNetworkConfig;
    mode?: 'canonical' | 'flashblocks';
  } = {},
): ethers.JsonRpcProvider {
  const network =
    options.network ??
    GIWA_SEPOLIA_OPENRAILS;

  const rpcUrl =
    options.mode === 'flashblocks'
      ? network.rpcUrls.flashblocks
      : network.rpcUrls.canonical;

  return new ethers.JsonRpcProvider(
    rpcUrl,
    network.chainId,
  );
}

export function openRailsAddressExplorerUrl(
  address: string,
  network: OpenRailsNetworkConfig =
    GIWA_SEPOLIA_OPENRAILS,
): string {
  return (
    `${network.explorerUrl}/address/` +
    ethers.getAddress(address)
  );
}

export function openRailsTransactionExplorerUrl(
  transactionHash: string,
  network: OpenRailsNetworkConfig =
    GIWA_SEPOLIA_OPENRAILS,
): string {
  if (
    !ethers.isHexString(
      transactionHash,
      32,
    )
  ) {
    throw new Error(
      'transactionHash must be a 32-byte hex string',
    );
  }

  return (
    `${network.explorerUrl}/tx/` +
    transactionHash
  );
}
