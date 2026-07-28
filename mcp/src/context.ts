import { ethers } from 'ethers';

export const GIWA_SEPOLIA_CHAIN_ID = 91_342;

export interface OpenRailsMcpConfig {
  networkMode: 'giwa-sepolia';
  chainId: number;
  chainName: string;
  rpcUrl: string;
  flashblocksRpcUrl: string;
  explorerBaseUrl: string;
  vaultAddress: string;
  factoryAddress: string;
  masterAddress: string;
  tokenAddress: string;
  tokenSymbol: 'orUSD';
  tokenDecimals: 6;
  deploymentBlock: number;
}

export interface OpenRailsContext {
  config: OpenRailsMcpConfig;
  provider: ethers.JsonRpcProvider;
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

export function buildContext(): OpenRailsContext {
  if (process.env.OPENRAILS_MCP_SIGNER_KEY) {
    throw new Error(
      'OPENRAILS_MCP_SIGNER_KEY is not accepted by the GIWA-safe MCP server. ' +
      'Signing must remain in the external payer wallet.',
    );
  }

  const config: OpenRailsMcpConfig = {
    networkMode: 'giwa-sepolia',
    chainId: GIWA_SEPOLIA_CHAIN_ID,
    chainName: 'GIWA Sepolia',
    rpcUrl: env('OPENRAILS_RPC_URL', 'https://sepolia-rpc.giwa.io'),
    flashblocksRpcUrl: env(
      'OPENRAILS_FLASHBLOCKS_RPC_URL',
      'https://sepolia-rpc-flashblocks.giwa.io',
    ),
    explorerBaseUrl: env(
      'OPENRAILS_EXPLORER_BASE_URL',
      'https://sepolia-explorer.giwa.io',
    ),
    vaultAddress: '0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1',
    factoryAddress: '0x5b59b70272A3948eB3F74CFA292f9dB8B64C4d6d',
    masterAddress: '0x21DFc1918FD8c5264F78bA57D861Bc4c1F681dAb',
    tokenAddress: '0x162BCaEb04D4c82403c925d3AC9bEC8FFc1C07De',
    tokenSymbol: 'orUSD',
    tokenDecimals: 6,
    deploymentBlock: 31_909_070,
  };

  const provider = new ethers.JsonRpcProvider(
    config.rpcUrl,
    config.chainId,
    { staticNetwork: true },
  );

  return { config, provider };
}
