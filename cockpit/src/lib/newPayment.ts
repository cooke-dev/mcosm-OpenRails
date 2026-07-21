/**
 * New Payment — the unified create flow behind the sidebar's "+ New Payment" action.
 *
 * Mode is hierarchical: RailsFlow / RailsCard, with Bearer / Recipient-Bound nested under
 * RailsCard only (they're a property of RailsCard, not a peer of RailsFlow). Two independent
 * actions are offered, matching the design's footer:
 *   - generateLink(): produces a shareable link. For RailsFlow this is the classic unsigned
 *     request link (nobody signs anything yet — whoever opens it becomes payer and signs).
 *     For RailsCard (bearer or recipient-bound) this signs the envelope now and shares it —
 *     funds move when it's later claimed/relayed, not at generation time.
 *   - submit(): the connected wallet signs AND funds the stream right now, gasless by default
 *     (EIP-2612 permit + POST /relay-open, no approval tx, no open tx) with an explicit
 *     self-submit fallback (approve + openPaycardChannel directly). Uses direct on-chain reads
 *     (nonce, allowance) via wagmi's publicClient — no dependency on any Express server.
 */
import { useState } from "react";
import { useAccount, useSignTypedData, useWriteContract, usePublicClient, useSwitchChain, useReadContract } from "wagmi";
import { USDC_ABI, HUB_ABI } from "./contracts";
import { arcTestnet } from "./chain";
import {
  type CanonicalMetadataV1,
  OPENRAILS_EIP712_TYPES,
  buildOpenRailsDomain,
  hashOpenRailsMetadata,
  buildMetadataBoundPaycardId,
  randomPaycardId,
  serializeEnvelope,
  ZERO_ADDRESS,
} from "./intents";
import { signFlowPermit } from "./permit";
import { createRailsFlowRequestLink, createRailsCardClaimLink, appBaseUrl } from "./links";

const RELAY_URL =
  (import.meta.env.VITE_OPENRAILS_RELAY_URL as string | undefined) ??
  "https://openrails-reconciliation-worker.microcosm.workers.dev";

export type NewPaymentMode = "railsflow" | "railscard";
export type NewPaymentCardVariant = "bearer" | "bound";
export type NewPaymentType = "one-time" | "streaming";

export interface NewPaymentParams {
  mode: NewPaymentMode;
  cardVariant: NewPaymentCardVariant; // only meaningful when mode === "railscard"
  type: NewPaymentType;
  party: string; // recipient (railsflow/bound, required) or claim hint (bearer, optional)
  amountUsdc: string;
  velocityUsdcPerSec?: string; // required when streaming
  lifespanSeconds?: string; // required when streaming
  memo?: string;
  workflowId?: string;
}

export type NewPaymentStatus =
  | { id: "idle" }
  | { id: "approving" }
  | { id: "signing" }
  | { id: "submitting" }
  | { id: "success"; txHash: string; paycardId: string }
  | { id: "error"; msg: string };

function resolvedEnvelopeMode(p: NewPaymentParams): "railsflow" | "railscard_bearer" | "railscard_recipient_bound" {
  if (p.mode === "railsflow") return "railsflow";
  return p.cardVariant === "bearer" ? "railscard_bearer" : "railscard_recipient_bound";
}

function validate(p: NewPaymentParams, hubAddress: string, balance?: bigint): string | null {
  if (!hubAddress) return "Config not loaded.";
  const addrRe = /^0x[0-9a-fA-F]{40}$/;
  const needsParty = p.mode === "railsflow" || (p.mode === "railscard" && p.cardVariant === "bound");
  if (needsParty && !addrRe.test(p.party)) return "Invalid recipient address.";
  if (p.party && !addrRe.test(p.party)) return "Invalid address.";
  const amt = parseFloat(p.amountUsdc);
  if (!isFinite(amt) || amt <= 0) return "Invalid amount.";
  if (p.type === "streaming") {
    const v = parseFloat(p.velocityUsdcPerSec ?? "");
    const l = parseFloat(p.lifespanSeconds ?? "");
    if (!isFinite(v) || v <= 0) return "Invalid velocity.";
    if (!isFinite(l) || l <= 0) return "Invalid lifespan.";
  }
  // RailsFlow "pay now"/submit is funded by the CONNECTED wallet's own balance, and a
  // RailsCard's escrow is likewise pulled from the signer at claim time — so the signer
  // can never authorize more than they actually hold, regardless of what the faucet once
  // dripped. `balance` is only known once the wallet's on-chain balanceOf resolves.
  if (balance !== undefined) {
    const totalAllocationPool = BigInt(Math.round(amt * 1_000_000));
    if (totalAllocationPool > balance) {
      const balanceUsdc = (Number(balance) / 1_000_000).toFixed(2);
      return `Amount exceeds your wallet's USDC balance (${balanceUsdc} available).`;
    }
  }
  return null;
}

function buildIntentParts(p: NewPaymentParams, payer: `0x${string}`, usdcAddress: `0x${string}`) {
  const envelopeMode = resolvedEnvelopeMode(p);
  const isBearer = envelopeMode === "railscard_bearer";
  const signedRecipient = (isBearer ? ZERO_ADDRESS : (p.party as `0x${string}`)) as `0x${string}`;
  const isOneTime = p.type === "one-time";
  const totalAllocationPool = BigInt(Math.round(parseFloat(p.amountUsdc) * 1_000_000));
  const flowVelocityPerSecond = isOneTime ? 0n : BigInt(Math.round(parseFloat(p.velocityUsdcPerSec!) * 1_000_000));
  const lifespanSeconds = isOneTime ? 0n : BigInt(Math.round(parseFloat(p.lifespanSeconds!)));

  const metadata: CanonicalMetadataV1 = {
    version: "openrails-metadata-v1",
    mode: envelopeMode,
    originator: payer,
    recipient: p.party || "",
    token: usdcAddress,
    amount: totalAllocationPool.toString(),
    flowVelocityPerSecond: flowVelocityPerSecond.toString(),
    lifespanSeconds: Number(lifespanSeconds),
    ...(p.workflowId?.trim() ? { workflowId: p.workflowId.trim() } : {}),
    ...(p.memo?.trim() ? { metadataRef: p.memo.trim() } : {}),
  };
  const metadataHash = hashOpenRailsMetadata(metadata);

  return { envelopeMode, isBearer, signedRecipient, totalAllocationPool, flowVelocityPerSecond, lifespanSeconds, metadata, metadataHash };
}

export function useNewPayment(hubAddress: string, usdcAddress: string) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<NewPaymentStatus>({ id: "idle" });

  // The connected wallet's own USDC balance — a RailsFlow "pay now"/self-submit and a
  // RailsCard's later claim both pull escrow from this same signer, so nothing generated
  // here should authorize more than they actually hold.
  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address: usdcAddress as `0x${string}`,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!usdcAddress },
  }) as { data: bigint | undefined; isLoading: boolean };

  const busy = status.id === "approving" || status.id === "signing" || status.id === "submitting";
  function reset() {
    setStatus({ id: "idle" });
  }

  /** Sign-only: produces a shareable link. RailsFlow = classic unsigned request link. */
  async function generateLink(p: NewPaymentParams): Promise<string> {
    if (p.mode === "railsflow") {
      const err = validate(p, hubAddress);
      if (err) throw new Error(err);
      const totalAllocationPool = BigInt(Math.round(parseFloat(p.amountUsdc) * 1_000_000));
      const isOneTime = p.type === "one-time";
      const flowVelocityPerSecond = isOneTime ? 0n : BigInt(Math.round(parseFloat(p.velocityUsdcPerSec!) * 1_000_000));
      const lifespanSeconds = isOneTime ? 0n : BigInt(Math.round(parseFloat(p.lifespanSeconds!)));
      return createRailsFlowRequestLink({
        appBaseUrl: appBaseUrl(),
        chainId: arcTestnet.id,
        vault: hubAddress,
        token: usdcAddress,
        metadataHash: randomPaycardId(), // advisory only for an unsigned request; real hash is rebuilt by the payer
        payload: {
          mode: "railsflow",
          merchant: address ?? "",
          recipient: p.party,
          amount: totalAllocationPool.toString(),
          flowVelocityPerSecond: flowVelocityPerSecond.toString(),
          lifespanSeconds: Number(lifespanSeconds),
          workflowId: p.workflowId?.trim() || undefined,
          metadataRef: p.memo?.trim() || undefined,
        },
      });
    }

    if (!address) throw new Error("Connect a wallet first.");
    const err = validate(p, hubAddress, balance);
    if (err) throw new Error(err);

    // Enforce switching to Arc Testnet
    if (chainId !== arcTestnet.id) {
      try {
        await switchChainAsync({ chainId: arcTestnet.id });
      } catch (err) {
        throw new Error("Please switch your wallet network to Arc Testnet.");
      }
    }

    const payer = address as `0x${string}`;
    const { envelopeMode, signedRecipient, totalAllocationPool, flowVelocityPerSecond, lifespanSeconds, metadataHash } =
      buildIntentParts(p, payer, usdcAddress as `0x${string}`);

    const nonceChannel = 0n;
    const nonceValue = (await publicClient!.readContract({
      address: hubAddress as `0x${string}`,
      abi: HUB_ABI,
      functionName: "accountNonceTracks",
      args: [payer, nonceChannel],
    })) as bigint;
    const paycardId = envelopeMode === "railscard_bearer"
      ? randomPaycardId()
      : buildMetadataBoundPaycardId({ payer, nonceChannel, nonceValue, metadataHash });
    const genesisTimestamp = BigInt(Math.floor(Date.now() / 1000));

    const domain = buildOpenRailsDomain(arcTestnet.id, hubAddress as `0x${string}`);
    const message = {
      paycardId,
      metadataHash,
      recipient: signedRecipient,
      totalAllocationPool,
      flowVelocityPerSecond,
      genesisTimestamp,
      lifespanSeconds,
      residualDeltaRecipient: payer,
      nonceChannel,
      nonceValue,
    } as const;
    
    setStatus({ id: "signing" });
    const sig = await signTypedDataAsync({ domain, types: OPENRAILS_EIP712_TYPES, primaryType: "SettlementIntent", message });

    // Generate EIP-2612 permit so the card can be cleared gaslessly or self-claimed later
    const permit = await signFlowPermit({
      publicClient: publicClient!,
      signTypedDataAsync,
      owner: payer,
      token: usdcAddress as `0x${string}`,
      spender: hubAddress as `0x${string}`,
      value: totalAllocationPool,
      chainId: arcTestnet.id,
    });

    const envelopeToken = serializeEnvelope({
      payerAddress: payer,
      envelopeSignature: sig,
      intent: {
        paycardId,
        metadataHash,
        recipient: signedRecipient,
        totalAllocationPool: totalAllocationPool.toString(),
        flowVelocityPerSecond: flowVelocityPerSecond.toString(),
        genesisTimestamp: Number(genesisTimestamp),
        lifespanSeconds: Number(lifespanSeconds),
        residualDeltaRecipient: payer,
        nonceChannel: 0,
        nonceValue: Number(nonceValue),
      },
      mode: envelopeMode,
      permit,
    });
    
    setStatus({ id: "idle" });

    return createRailsCardClaimLink({
      appBaseUrl: appBaseUrl(),
      chainId: arcTestnet.id,
      vault: hubAddress,
      token: usdcAddress,
      metadataHash,
      payload: {
        mode: envelopeMode as "railscard_bearer" | "railscard_recipient_bound",
        envelopeToken,
        claimHint: p.party || undefined,
      },
    });
  }

  /** Sign + fund now. Gasless by default (permit + relay-open); falls back to self-submit. */
  async function submit(p: NewPaymentParams, path: "gasless" | "self-submit" = "gasless"): Promise<void> {
    if (!address) return setStatus({ id: "error", msg: "Connect a wallet first." });
    if (p.mode === "railscard" && p.cardVariant === "bearer") {
      // Bearer cards have no fixed recipient at creation time — there is nothing to "open"
      // yet. Use Generate link instead; funds move only when the link is later claimed.
      return setStatus({ id: "error", msg: "Bearer RailsCards are claimed later by whoever holds the link — use Generate link instead." });
    }
    const err = validate(p, hubAddress, balance);
    if (err) return setStatus({ id: "error", msg: err });

    // Enforce switching to Arc Testnet
    if (chainId !== arcTestnet.id) {
      try {
        await switchChainAsync({ chainId: arcTestnet.id });
      } catch (err) {
        return setStatus({ id: "error", msg: "Please switch your wallet network to Arc Testnet." });
      }
    }

    const payer = address as `0x${string}`;
    const hub = hubAddress as `0x${string}`;
    const usdc = usdcAddress as `0x${string}`;
    const { envelopeMode, signedRecipient, totalAllocationPool, flowVelocityPerSecond, lifespanSeconds, metadataHash } =
      buildIntentParts(p, payer, usdc);

    try {
      const nonceChannel = 0n;
      const nonceValue = (await publicClient!.readContract({
        address: hub,
        abi: HUB_ABI,
        functionName: "accountNonceTracks",
        args: [payer, nonceChannel],
      })) as bigint;
      const paycardId = envelopeMode === "railscard_bearer"
        ? randomPaycardId()
        : buildMetadataBoundPaycardId({ payer, nonceChannel, nonceValue, metadataHash });
      const genesisTimestamp = BigInt(Math.floor(Date.now() / 1000));

      const domain = buildOpenRailsDomain(arcTestnet.id, hub);
      const message = {
        paycardId,
        metadataHash,
        recipient: signedRecipient,
        totalAllocationPool,
        flowVelocityPerSecond,
        genesisTimestamp,
        lifespanSeconds,
        residualDeltaRecipient: payer,
        nonceChannel,
        nonceValue,
      } as const;

      if (path === "gasless") {
        setStatus({ id: "signing" });
        const sig = await signTypedDataAsync({ domain, types: OPENRAILS_EIP712_TYPES, primaryType: "SettlementIntent", message });
        const envelopeToken = serializeEnvelope({
          payerAddress: payer,
          envelopeSignature: sig,
          intent: {
            paycardId,
            metadataHash,
            recipient: signedRecipient,
            totalAllocationPool: totalAllocationPool.toString(),
            flowVelocityPerSecond: flowVelocityPerSecond.toString(),
            genesisTimestamp: Number(genesisTimestamp),
            lifespanSeconds: Number(lifespanSeconds),
            residualDeltaRecipient: payer,
            nonceChannel: 0,
            nonceValue: Number(nonceValue),
          },
          mode: envelopeMode,
        });
        const permit = await signFlowPermit({
          publicClient: publicClient!,
          signTypedDataAsync,
          owner: payer,
          token: usdc,
          spender: hub,
          value: totalAllocationPool,
          chainId: arcTestnet.id,
        });

        setStatus({ id: "submitting" });
        const res = await fetch(`${RELAY_URL}/relay-open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ envelopeToken, permit }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setStatus({ id: "success", txHash: data.txHash, paycardId: data.paycardId ?? paycardId });
        return;
      }

      // Self-submit fallback: the connected wallet approves + opens directly, pays its own gas.
      const allowance = (await publicClient!.readContract({
        address: usdc,
        abi: USDC_ABI,
        functionName: "allowance",
        args: [payer, hub],
      })) as bigint;
      if (allowance < totalAllocationPool) {
        setStatus({ id: "approving" });
        const approveTx = await writeContractAsync({ address: usdc, abi: USDC_ABI, functionName: "approve", args: [hub, totalAllocationPool] });
        await publicClient!.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
      }

      setStatus({ id: "signing" });
      const sig = await signTypedDataAsync({ domain, types: OPENRAILS_EIP712_TYPES, primaryType: "SettlementIntent", message });

      setStatus({ id: "submitting" });
      const openArgs = [
        paycardId,
        metadataHash,
        signedRecipient,
        totalAllocationPool,
        flowVelocityPerSecond,
        genesisTimestamp,
        lifespanSeconds,
        payer,
        sig,
        nonceChannel,
        nonceValue,
        payer,
      ] as const;
      // Bearer is handled earlier (returns before reaching here) — always openPaycardChannel.
      const txHash = await writeContractAsync({ address: hub, abi: HUB_ABI, functionName: "openPaycardChannel", args: openArgs });
      await publicClient!.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      setStatus({ id: "success", txHash, paycardId });
    } catch (e) {
      setStatus({ id: "error", msg: e instanceof Error ? e.message.slice(0, 240) : String(e) });
    }
  }

  return { status, busy, balanceLoading, submit, generateLink, reset };
}
