/**
 * @module account
 * @description Pluggable account abstraction for OpenRails.
 *
 * OpenRails authenticates the *signature*, not the sender — the Hub verifies the
 * payer's EIP-712 signature and never checks `msg.sender`. So most accounts only
 * need to **sign**; submission can be sponsored by a relayer (see
 * {@link module:relay}). That is why the interface is split in two:
 *
 * - {@link OpenRailsAccount} — sign-only. Enough for gasless (relayed) opens/claims.
 *   Satisfied by embedded EOAs (Privy/Turnkey/Web3Auth), server wallets, and smart
 *   contract accounts (e.g. Circle Smart Accounts — see `adapters/circle`).
 * - {@link OpenRailsSubmitter} — also submits its own transactions (self-submit path).
 *   Any `ethers.Signer` satisfies it.
 *
 * The V2 Hub (canonical, `2.0.0` domain) verifies signatures via OpenZeppelin's
 * `SignatureChecker.isValidSignatureNow`, which accepts both plain ECDSA (EOA)
 * signatures *and* EIP-1271 smart-contract-account signatures — no separate contract
 * path needed. Set `isSmartAccount: true` on the account so the client skips the
 * client-side ECDSA-recovery sanity check (which can't apply to an EIP-1271
 * signature in the first place); the real verification still happens on-chain.
 * The frozen V1 Hub (`1.0.0` domain, no longer accepting new opens) predates this
 * and only ever supported raw `ecrecover`-based EOA signatures — don't target it.
 */
import type { ethers } from 'ethers';

/** The minimal capability OpenRails needs to authorize an intent or a permit. */
export interface OpenRailsAccount {
  /** Optional flag indicating this is a smart contract account. */
  isSmartAccount?: boolean;
  /** Returns the account's address (checksummed by convention). */
  getAddress(): Promise<string>;
  /**
   * Produces an EIP-712 signature. Used for both SettlementIntents and EIP-2612
   * permits — a permit is just another typed-data payload.
   */
  signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

/** Result of broadcasting a transaction — the common subset we depend on. */
export interface SubmittedTransaction {
  hash: string;
  wait(): Promise<unknown>;
}

/** An account that can also broadcast its own transactions (self-submit path). */
export interface OpenRailsSubmitter extends OpenRailsAccount {
  sendTransaction(tx: ethers.TransactionRequest): Promise<SubmittedTransaction>;
}
