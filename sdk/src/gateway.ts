import { ethers } from "ethers";

export const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
export const GATEWAY_MINTER_ADDRESS = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

const GATEWAY_WALLET_ABI = [
  "function deposit(address token, uint256 value) external",
  "function depositFor(address token, address depositor, uint256 value) external",
  "function totalBalance(address token, address depositor) external view returns (uint256)",
  "function availableBalance(address token, address depositor) external view returns (uint256)"
] as const;

const GATEWAY_MINTER_ABI = [
  "function gatewayMint(bytes calldata attestationPayload, bytes calldata signature) external"
] as const;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)"
] as const;

export interface DepositParams {
  signer: ethers.Signer;
  amountBaseUnits: bigint; // USDC 6-decimal units (mwei)
  tokenAddress?: string; // defaults to Arc USDC
  autoApprove?: boolean; // automatically submit approve transaction if allowance is insufficient
  gatewayWalletAddress?: string; // defaults to the live Arc testnet GatewayWallet; override for tests
}

export interface DepositForParams extends DepositParams {
  depositor: string;
}

export interface MintParams {
  signer: ethers.Signer;
  attestationPayload: string; // hex string
  signature: string; // hex string
  gatewayMinterAddress?: string; // defaults to the live Arc testnet GatewayMinter; override for tests
}

/**
 * Deposits USDC (or another supported token) to the Circle Gateway Wallet.
 */
export async function depositToGateway(params: DepositParams): Promise<{ txHash: string }> {
  const token = params.tokenAddress || ARC_USDC_ADDRESS;
  const gatewayWallet = params.gatewayWalletAddress || GATEWAY_WALLET_ADDRESS;
  const signerAddress = await params.signer.getAddress();

  if (params.autoApprove !== false) {
    const erc20 = new ethers.Contract(token, ERC20_ABI, params.signer);
    const allowance = await erc20.allowance(signerAddress, gatewayWallet);
    if (allowance < params.amountBaseUnits) {
      console.log(`[Gateway] Insufficient allowance (${allowance.toString()}). Approving ${params.amountBaseUnits.toString()}...`);
      const approveTx = await erc20.approve(gatewayWallet, params.amountBaseUnits);
      await approveTx.wait();
    }
  }

  const contract = new ethers.Contract(gatewayWallet, GATEWAY_WALLET_ABI, params.signer);
  const tx = await contract.deposit(token, params.amountBaseUnits);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Deposits USDC (or another supported token) to the Circle Gateway Wallet on behalf of another address.
 */
export async function depositForToGateway(params: DepositForParams): Promise<{ txHash: string }> {
  const token = params.tokenAddress || ARC_USDC_ADDRESS;
  const gatewayWallet = params.gatewayWalletAddress || GATEWAY_WALLET_ADDRESS;
  const signerAddress = await params.signer.getAddress();

  if (params.autoApprove !== false) {
    const erc20 = new ethers.Contract(token, ERC20_ABI, params.signer);
    const allowance = await erc20.allowance(signerAddress, gatewayWallet);
    if (allowance < params.amountBaseUnits) {
      console.log(`[Gateway] Insufficient allowance (${allowance.toString()}). Approving ${params.amountBaseUnits.toString()}...`);
      const approveTx = await erc20.approve(gatewayWallet, params.amountBaseUnits);
      await approveTx.wait();
    }
  }

  const contract = new ethers.Contract(gatewayWallet, GATEWAY_WALLET_ABI, params.signer);
  const tx = await contract.depositFor(token, params.depositor, params.amountBaseUnits);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Submits an attestation payload and signature to the Gateway Minter to mint tokens.
 */
export async function mintFromGateway(params: MintParams): Promise<{ txHash: string }> {
  const gatewayMinter = params.gatewayMinterAddress || GATEWAY_MINTER_ADDRESS;
  const contract = new ethers.Contract(gatewayMinter, GATEWAY_MINTER_ABI, params.signer);
  const tx = await contract.gatewayMint(params.attestationPayload, params.signature);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}
