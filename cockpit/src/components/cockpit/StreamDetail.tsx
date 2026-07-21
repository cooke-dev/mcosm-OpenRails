import { useEffect, useState } from "react";
import { Panel, RefreshButton, LoadingSkeletons, ErrorState, SecondaryButton, PrimaryButton, ExplorerLink } from "./Panel";
import { fmtUsdcBase, shortHex, statusMeta, receiptTypeMeta, eventAmount, explorerTxUrl, explorerAddressUrl } from "../../lib/cockpitFormat";
import { indexer, type IndexedEvent, type IndexedStream } from "../../lib/indexer";

export function StreamDetail({
  hub: _hub,
  usdc: _usdc,
  vaultAddress,
  paycardId,
  connectedAddress,
  onBack,
  onSettle,
  onFlush,
}: {
  hub: string;
  usdc: string;
  vaultAddress: string;
  paycardId: string;
  connectedAddress: string | undefined;
  onBack: () => void;
  onSettle: () => void;
  onFlush: () => void;
}) {
  const [state, setState] = useState<IndexedStream | null>(null);
  const [events, setEvents] = useState<IndexedEvent[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "empty">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  async function load(isRefresh?: boolean) {
    setRefreshing(!!isRefresh);
    try {
      const res = await indexer.history(vaultAddress, paycardId);
      setState(res.state);
      setEvents(res.events);
      setStatus(res.events.length ? "ready" : "empty");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus("error");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setStatus("loading");
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultAddress, paycardId]);

  // Auto-poll while the stream is still active — settlement only ever moves in response to a
  // real on-chain SettlementFlushed event (no client-side estimation anywhere in this app), and
  // without this a user watching the screen would never see it change unless they knew to click
  // Refresh. Stops polling once the stream is no longer Active.
  useEffect(() => {
    if (state?.status !== "Active") return;
    const interval = setInterval(() => load(true), 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultAddress, paycardId, state?.status]);

  const meta = state ? statusMeta(state.status, state.availableBalance) : null;
  const isPayer = connectedAddress && state && connectedAddress.toLowerCase() === state.payer.toLowerCase();
  const isRecipient = connectedAddress && state && connectedAddress.toLowerCase() === state.recipient.toLowerCase();
  const canFlush = isPayer || isRecipient;
  const spent = state ? BigInt(state.totalAllocation || "0") - BigInt(state.availableBalance || "0") : 0n;
  const pct = state && BigInt(state.totalAllocation || "0") > 0n ? Number((spent * 1000n) / BigInt(state.totalAllocation)) / 10 : 0;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <SecondaryButton onClick={onBack} style={{ borderRadius: 999, padding: "8px 14px", fontSize: 12 }}>
            ← Streams
          </SecondaryButton>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700 }}>{shortHex(paycardId, 8, 4)}</span>
              {meta && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600, color: meta.text, background: meta.bg, border: `1px solid ${meta.bd}`, borderRadius: 999, padding: "3px 10px" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.dot }} />
                  {meta.label}
                </span>
              )}
            </div>
            <div style={{ marginTop: 3, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "rgba(11,17,32,0.42)" }}>
              vault <ExplorerLink href={explorerAddressUrl(vaultAddress)}>{shortHex(vaultAddress)}</ExplorerLink>
            </div>
          </div>
        </div>
        <RefreshButton onClick={() => load(true)} spinning={refreshing} />
      </div>

      {status === "loading" && <LoadingSkeletons rows={3} height={44} />}
      {status === "error" && <ErrorState msg={errorMsg} onRetry={() => load()} />}
      {(status === "ready" || status === "empty") && (
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
          <div
            style={{
              position: "relative",
              background: "linear-gradient(165deg, #0B1322 0%, #04070D 72%)",
              color: "#FFFFFF",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 20,
              padding: "26px 28px",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 22px 54px rgba(4,7,13,0.34)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(255,255,255,0.55)" }}>Paycard Stream</span>
              {meta && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: meta.dot }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.dot, boxShadow: `0 0 8px ${meta.dot}` }} />
                  {meta.label}
                </span>
              )}
            </div>
            <div style={{ marginTop: 22, fontFamily: "'JetBrains Mono', monospace" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.42)" }}>settled to recipient</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 5 }}>
                <span style={{ fontSize: 38, fontWeight: 600, letterSpacing: "-0.02em" }}>{state ? fmtUsdcBase(spent, 2) : "—"}</span>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>USDC</span>
              </div>
            </div>
            <div style={{ marginTop: 16, height: 8, borderRadius: 999, background: "rgba(255,255,255,0.09)", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: "#00C878" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14, fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: "rgba(255,255,255,0.55)" }}>
              <span>
                escrowed <span style={{ color: "#FFFFFF" }}>{state ? fmtUsdcBase(state.totalAllocation, 2) : "—"}</span>
              </span>
              <span>
                rate <span style={{ color: "#FFFFFF" }}>{state ? `${fmtUsdcBase(state.velocity, 6)}/s` : "—"}</span>
              </span>
              <span>
                residual <span style={{ color: "#FFFFFF" }}>{state ? fmtUsdcBase(state.availableBalance, 2) : "—"}</span>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.08)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(255,255,255,0.5)" }}>
              <span>payer {state ? <ExplorerLink href={explorerAddressUrl(state.payer)}>{shortHex(state.payer)}</ExplorerLink> : "—"}</span>
              <span style={{ color: "rgba(255,255,255,0.3)" }}>→</span>
              <span>recipient {state ? <ExplorerLink href={explorerAddressUrl(state.recipient)}>{shortHex(state.recipient)}</ExplorerLink> : "—"}</span>
            </div>
          </div>

          <Panel style={{ padding: "22px 24px", display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(11,17,32,0.4)", marginBottom: 12 }}>
              Composite key &amp; parties
            </div>
            {([
              ["Vault", vaultAddress, "address"],
              ["Paycard ID", paycardId, "plain"],
              ["Payer", state?.payer ?? "—", "address"],
              ["Recipient", state?.recipient ?? "—", "address"],
              ["Metadata hash", state?.metadataHash ?? "—", "plain"],
              ["Genesis", state ? new Date(state.genesis * 1000).toLocaleString() : "—", "plain"],
              ["Lifespan", state ? (state.lifespan === 0 ? "one-time" : `${state.lifespan}s`) : "—", "plain"],
            ] as const).map(([k, v, kind]) => (
              <div key={k} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: "1px solid rgba(11,17,32,0.06)" }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(11,17,32,0.5)", flex: "0 0 auto" }}>{k}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#0B1120", textAlign: "right", wordBreak: "break-all" }}>
                  {kind === "address" && v !== "—" ? <ExplorerLink href={explorerAddressUrl(v)}>{v}</ExplorerLink> : v}
                </span>
              </div>
            ))}
            {state?.status === "Active" && (
              <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
                <PrimaryButton onClick={onSettle} style={{ flex: 1, textAlign: "center" }}>
                  Settle
                </PrimaryButton>
                <button
                  type="button"
                  onClick={onFlush}
                  disabled={!canFlush}
                  title={canFlush ? "Irrevocable — flushes STN-Delta residual" : "Only payer or recipient can flush"}
                  style={{
                    flex: 1,
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "#8A6D00",
                    background: "rgba(214,175,80,0.12)",
                    border: "1px solid rgba(214,175,80,0.4)",
                    borderRadius: 10,
                    padding: "11px 14px",
                    cursor: canFlush ? "pointer" : "not-allowed",
                    opacity: canFlush ? 1 : 0.5,
                  }}
                >
                  Flush residual
                </button>
              </div>
            )}
            <div style={{ marginTop: 12, fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, lineHeight: 1.55, color: "rgba(11,17,32,0.55)", background: "rgba(11,17,32,0.04)", border: "1px solid rgba(11,17,32,0.08)", borderRadius: 10, padding: "10px 12px" }}>
              Settle is mostly automatic — a keeper cron drip-settles active streams on its own schedule. This button forces it now.
            </div>
          </Panel>

          <Panel style={{ gridColumn: "1 / -1" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "18px 22px 14px" }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Event history &amp; receipts</h2>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(11,17,32,0.4)" }}>non-authoritative</span>
            </div>
            {status === "empty" && <div style={{ padding: "34px 22px", textAlign: "center", fontSize: 13, color: "rgba(11,17,32,0.5)" }}>No events recorded for this stream yet.</div>}
            {status === "ready" &&
              events.map((h, i) => {
                const rt = receiptTypeMeta(h.eventName);
                const amt = eventAmount(h.eventName, h.args);
                return (
                  <div key={`${h.transactionHash}:${h.logIndex}:${i}`} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1.4fr 0.9fr", gap: 14, padding: "14px 22px", borderTop: "1px solid rgba(11,17,32,0.06)", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <span style={{ flex: "0 0 auto", display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 9, background: rt.bg, color: rt.color, fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>
                        {rt.icon}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{rt.label}</div>
                        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "rgba(11,17,32,0.42)" }}>block #{h.blockNumber}</div>
                      </div>
                    </div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#0B1120" }}>{fmtUsdcBase(amt, 2)} USDC</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(11,17,32,0.55)", minWidth: 0 }}>
                      <div style={{ color: "rgba(11,17,32,0.4)" }}>
                        <ExplorerLink href={explorerTxUrl(h.transactionHash)}>{shortHex(h.transactionHash, 10, 6)} ↗</ExplorerLink>
                      </div>
                    </div>
                    <div style={{ textAlign: "right", fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: "#00794A" }}>✓ on-chain</div>
                  </div>
                );
              })}
          </Panel>
        </div>
      )}
    </div>
  );
}
