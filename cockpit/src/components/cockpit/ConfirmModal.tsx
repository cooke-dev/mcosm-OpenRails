import { useState } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { HUB_ABI } from "../../lib/contracts";
import { SecondaryButton, PrimaryButton } from "./Panel";
import type { ToastState } from "./Toast";
import { useWalletConnection } from "../../lib/useWalletConnection";

export type ConfirmKind = "settle" | "flush";

export function ConfirmModal({
  confirm,
  onClose,
  onDone,
}: {
  confirm: { kind: ConfirmKind; vaultAddress: string; paycardId: string } | null;
  onClose: () => void;
  onDone: (toast: ToastState) => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { isConnected } = useWalletConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!confirm) return null;

  const isFlush = confirm.kind === "flush";

  async function run() {
    if (!confirm) return;
    // A wagmi-only reconnect can report a real address while Privy no longer considers the
    // session authenticated (see useWalletConnection.ts) — don't let a stale session attempt
    // a real write.
    if (!isConnected) {
      setError("Wallet session isn't active — reconnect and try again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const hash = await writeContractAsync({
        address: confirm.vaultAddress as `0x${string}`,
        abi: HUB_ABI,
        functionName: isFlush ? "flushResidualDelta" : "processDripSettle",
        args: [confirm.paycardId as `0x${string}`],
      });
      await publicClient!.waitForTransactionReceipt({ hash, timeout: 120_000 });
      onDone({ title: isFlush ? "Residual flushed" : "Settled", body: hash });
    } catch (e) {
      setError(e instanceof Error ? e.message.slice(0, 240) : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(4,7,13,0.5)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 520, background: "#FBFCFE", border: "1px solid rgba(11,17,32,0.1)", borderRadius: 20, boxShadow: "0 30px 80px rgba(4,7,13,0.4)" }}>
        <div style={{ padding: "22px 24px 16px", borderBottom: "1px solid rgba(11,17,32,0.07)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>{isFlush ? "⚠" : "≈"}</span>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{isFlush ? "Flush residual delta" : "Force settle now"}</h3>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "rgba(11,17,32,0.45)", marginTop: 2 }}>
                {confirm.paycardId.slice(0, 10)}…
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding: "18px 24px" }}>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "rgba(11,17,32,0.68)" }}>
            {isFlush
              ? "This settles any accrued value first, then permanently terminates the stream and sweeps the unspent residual back to the recovery address. This cannot be undone."
              : "Streams already settle automatically via the keeper cron — this just forces it now. Non-destructive."}
          </div>
          {isFlush && (
            <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 14px", borderRadius: 10, background: "rgba(199,58,58,0.08)", border: "1px solid rgba(199,58,58,0.28)", fontSize: 12, lineHeight: 1.5, color: "#9A2A2A" }}>
              <span style={{ fontWeight: 700 }}>⚠</span>
              <span>Irrevocable — the stream cannot be reopened once flushed.</span>
            </div>
          )}
          {error && <p style={{ marginTop: 12, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#C73A3A" }}>{error}</p>}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "16px 24px", borderTop: "1px solid rgba(11,17,32,0.07)" }}>
          <SecondaryButton onClick={onClose} disabled={busy}>
            Cancel
          </SecondaryButton>
          <PrimaryButton
            onClick={run}
            disabled={busy || !isConnected}
            style={isFlush ? { background: busy ? "rgba(154,42,42,0.5)" : "#9A2A2A" } : undefined}
          >
            {busy ? "Submitting…" : isFlush ? "Flush residual" : "Settle"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
