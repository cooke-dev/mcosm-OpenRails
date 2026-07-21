/**
 * Single unified connect entry point — Privy's own modal (email/social -> auto-created embedded
 * wallet, or "wallet" -> bring-your-own external wallet), replacing RainbowKit's ConnectButton.
 * No Circle Smart Account / Circle Gateway option shown yet (neither is verified working) — see
 * docs/superpowers/specs/2026-07-05-webapp-dashboard-ia-design.md's Connect UX decision.
 *
 * The actual active address for on-chain reads/writes still comes from wagmi's useAccount() —
 * @privy-io/wagmi's WagmiProvider keeps that in sync with whatever Privy wallet is active, so
 * every existing wagmi-based call site is unaffected by this component's internals.
 *
 * Once connected, clicking the pill opens a small menu (address + copy + USDC balance +
 * disconnect) instead of disconnecting immediately — a bare click used to call logout() directly.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useReadContract, useSwitchChain } from "wagmi";
import { USDC_ABI } from "../lib/contracts";
import { useWalletConnection } from "../lib/useWalletConnection";

const USDC = "0x3600000000000000000000000000000000000000";

function shortHex(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function formatUsdc(raw: bigint | undefined): string {
  if (raw === undefined) return "—";
  const whole = raw / 1_000_000n;
  const frac = raw % 1_000_000n;
  return `${whole}.${frac.toString().padStart(6, "0").slice(0, 2)}`;
}

export function ConnectWalletButton({ style }: { style?: CSSProperties }) {
  const { login, logout } = usePrivy();
  const { isConnected, address, chainId, ready } = useWalletConnection();
  const { switchChain } = useSwitchChain();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address && menuOpen, refetchInterval: 10_000 },
  });

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) setCopied(false);
  }, [menuOpen]);

  const base: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "Inter, sans-serif",
    fontSize: 13,
    fontWeight: 600,
    color: "#FFFFFF",
    border: "none",
    borderRadius: 999,
    padding: "9px 16px",
    cursor: ready ? "pointer" : "wait",
    ...style,
  };

  if (!ready) {
    return (
      <button type="button" disabled style={{ ...base, background: "rgba(4,7,13,0.4)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />
        <span>Loading…</span>
      </button>
    );
  }

  if (isConnected && address) {
    const isWrongNetwork = chainId !== 5042002;
    return (
      <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
        {isWrongNetwork ? (
          <button
            type="button"
            onClick={() => switchChain({ chainId: 5042002 })}
            style={{ ...base, background: "#C73A3A" }}
            title="Click to switch to Arc Testnet"
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#FFFFFF" }} />
            <span>Switch to Arc</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            style={{ ...base, background: "#04070D" }}
            title={shortHex(address)}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#00C878" }} />
            <span>{shortHex(address)}</span>
          </button>
        )}

        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              zIndex: 200,
              width: 260,
              background: "#FFFFFF",
              border: "1px solid rgba(11,17,32,0.1)",
              borderRadius: 14,
              boxShadow: "0 20px 50px rgba(4,7,13,0.22)",
              overflow: "hidden",
              fontFamily: "Inter, sans-serif",
            }}
          >
            <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(11,17,32,0.07)" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(11,17,32,0.4)", marginBottom: 6 }}>
                Address
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, color: "#0B1120" }}>{shortHex(address)}</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(address)
                      .then(() => setCopied(true))
                      .catch(() => {});
                  }}
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: copied ? "#009E60" : "rgba(11,17,32,0.6)",
                    background: "rgba(11,17,32,0.05)",
                    border: "1px solid rgba(11,17,32,0.1)",
                    borderRadius: 7,
                    padding: "4px 8px",
                    cursor: "pointer",
                  }}
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>

            <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(11,17,32,0.07)" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(11,17,32,0.4)", marginBottom: 6 }}>
                Balance · Arc testnet
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700, color: "#0B1120" }}>
                {balanceLoading ? "…" : `${formatUsdc(balance as bigint | undefined)} USDC`}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                logout();
              }}
              style={{
                width: "100%",
                textAlign: "left",
                fontFamily: "Inter, sans-serif",
                fontSize: 12.5,
                fontWeight: 600,
                color: "#C73A3A",
                background: "none",
                border: "none",
                padding: "12px 16px",
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <button type="button" onClick={() => login()} style={{ ...base, background: "#009E60" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />
      <span>Connect wallet</span>
    </button>
  );
}
