import { useEffect, useState } from "react";
import "../components/cockpit/responsive.css";
import { useWalletConnection } from "../lib/useWalletConnection";
import { ConnectWalletButton } from "../components/ConnectWalletButton";
import { Sidebar, type CockpitView } from "../components/cockpit/Sidebar";
import { Deck } from "../components/cockpit/Deck";
import { Streams } from "../components/cockpit/Streams";
import { StreamDetail } from "../components/cockpit/StreamDetail";
import { Receipts } from "../components/cockpit/Receipts";
import { Agents } from "../components/cockpit/Agents";
import { Explorer } from "../components/cockpit/Explorer";
import { Faucet } from "../components/cockpit/Faucet";
import { NewPaymentModal } from "../components/cockpit/NewPaymentModal";
import { ConfirmModal, type ConfirmKind } from "../components/cockpit/ConfirmModal";
import { ReceiptExportModal, type ReceiptModalData } from "../components/cockpit/ReceiptExportModal";
import { Toast, type ToastState } from "../components/cockpit/Toast";
import { useIndexerStreams } from "../lib/useIndexerStreams";

const HUB = "0x941C8029F0f912df3fAb7423890ab2359b996D0b";
const USDC = "0x3600000000000000000000000000000000000000";

// Tracks whether we're below the mobile breakpoint; re-evaluates on resize /
// orientation change. Drawer open/close itself is separate React state.
function useIsMobile(query = "(max-width: 767px)") {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("resize", on);
    };
  }, [query]);
  return matches;
}

const TITLES: Record<CockpitView, [string, string]> = {
  deck: ["Deck", "Overview · Arc testnet"],
  streams: ["Streams", "Every stream where you're payer or recipient"],
  receipts: ["Receipts", "Personal event ledger"],
  agents: ["Agents", "Tagged addresses & spend oversight"],
  explorer: ["Explorer", "Search vaults, streams, transactions"],
  faucet: ["Faucet", "Fund a testnet wallet"],
};

export default function Cockpit() {
  const { address } = useWalletConnection();
  const [active, setActive] = useState<CockpitView>("deck");
  const [collapsed, setCollapsed] = useState(false);
  const isMobile = useIsMobile();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Growing past the breakpoint should never leave the drawer state stranded.
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false);
  }, [isMobile]);
  const [selected, setSelected] = useState<{ vaultAddress: string; paycardId: string } | null>(null);
  const [npOpen, setNpOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: ConfirmKind; vaultAddress: string; paycardId: string } | null>(null);
  const [receiptModal, setReceiptModal] = useState<ReceiptModalData | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [streamsSeedAddress, setStreamsSeedAddress] = useState("");

  const streamsData = useIndexerStreams();

  function openDetail(vaultAddress: string, paycardId: string) {
    setSelected({ vaultAddress, paycardId });
  }
  function closeDetail() {
    setSelected(null);
  }
  function select(v: CockpitView) {
    setActive(v);
    setSelected(null);
  }
  function showToast(t: ToastState) {
    setToast(t);
    setTimeout(() => setToast(null), 4200);
  }

  const [title, crumb] = TITLES[active];

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#0B1120",
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "radial-gradient(120% 100% at 100% 0%, #FDFEFF 0%, #EDF0F4 55%, #E4E8EE 100%)",
      }}
    >
      <Sidebar
        active={active}
        onSelect={select}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
        onNewPayment={() => setNpOpen(true)}
        indexerLive={streamsData.status === "ready"}
        isMobile={isMobile}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      {/* backdrop — mobile drawer only */}
      {isMobile && mobileNavOpen && (
        <div
          onClick={() => setMobileNavOpen(false)}
          style={{ position: "fixed", inset: 0, zIndex: 55, background: "rgba(4,7,13,0.42)", animation: "ck-backdrop-in 0.2s ease" }}
        />
      )}

      <div style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <header
          style={{
            position: "relative",
            zIndex: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 20,
            padding: isMobile ? "12px 14px" : "16px 28px",
            borderBottom: "1px solid rgba(11,17,32,0.08)",
            background: "rgba(237,240,244,0.7)",
            backdropFilter: "blur(18px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            {isMobile && (
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Open navigation"
                style={{
                  flex: "0 0 auto",
                  display: "grid",
                  placeItems: "center",
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  border: "1px solid rgba(11,17,32,0.12)",
                  background: "rgba(255,255,255,0.7)",
                  color: "#0B1120",
                  fontSize: 16,
                  cursor: "pointer",
                }}
              >
                ☰
              </button>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{selected ? "Stream detail" : title}</h1>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "rgba(11,17,32,0.5)", ...(isMobile ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } : null) }}>
                <span>{crumb}</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {!isMobile && (
            <>
            <div
              title="The indexer is a non-authoritative projection of on-chain state. The Vault is the source of truth."
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10.5,
                color: "rgba(11,17,32,0.5)",
                border: "1px solid rgba(11,17,32,0.12)",
                background: "rgba(255,255,255,0.6)",
                borderRadius: 999,
                padding: "7px 13px",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: streamsData.status === "error" ? "#C73A3A" : streamsData.status === "ready" ? "#00C878" : "#B7BEC9" }} />
              <span>
                indexer · <span style={{ color: "rgba(11,17,32,0.4)" }}>non-authoritative</span>
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: "rgba(11,17,32,0.62)",
                border: "1px solid rgba(11,17,32,0.12)",
                background: "rgba(255,255,255,0.6)",
                borderRadius: 999,
                padding: "7px 13px",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00C878", boxShadow: "0 0 8px rgba(0,200,120,0.9)" }} />
              Arc testnet
            </div>
            </>
            )}
            <ConnectWalletButton />
          </div>
        </header>

        <div
          style={{
            position: "relative",
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: isMobile ? "9px 14px" : "9px 28px",
            background: "rgba(4,7,13,0.92)",
            color: "rgba(255,255,255,0.72)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            letterSpacing: "0.06em",
          }}
        >
          <span style={{ flex: "0 0 auto", width: 6, height: 6, borderRadius: "50%", background: "#00C878", boxShadow: "0 0 10px rgba(0,200,120,0.9)" }} />
          <span>Testnet is live</span>
        </div>

        <main className="ck-scroll" style={{ position: "relative", zIndex: 1, flex: 1, overflowY: "auto", padding: isMobile ? "20px 14px 48px" : "28px 28px 60px" }}>
          <div style={{ maxWidth: 1120, margin: "0 auto" }}>
            {selected ? (
              <StreamDetail
                hub={HUB}
                usdc={USDC}
                vaultAddress={selected.vaultAddress}
                paycardId={selected.paycardId}
                connectedAddress={address}
                onBack={closeDetail}
                onSettle={() => setConfirm({ kind: "settle", vaultAddress: selected.vaultAddress, paycardId: selected.paycardId })}
                onFlush={() => setConfirm({ kind: "flush", vaultAddress: selected.vaultAddress, paycardId: selected.paycardId })}
              />
            ) : (
              <>
                {active === "deck" && <Deck streamsData={streamsData} />}
                {(active === "deck" || active === "streams") && (
                  <Streams data={streamsData} onOpenDetail={openDetail} initialPayerFilter={active === "streams" ? streamsSeedAddress : ""} />
                )}
                {active === "receipts" && <Receipts connectedAddress={address} onOpenReceipt={setReceiptModal} onOpenStream={openDetail} />}
                {active === "agents" && (
                  <Agents
                    onOpenAgentStreams={(addr) => {
                      setStreamsSeedAddress(addr);
                      setActive("streams");
                    }}
                  />
                )}
                {active === "explorer" && <Explorer onOpenDetail={openDetail} />}
                {active === "faucet" && <Faucet />}
              </>
            )}
          </div>
        </main>
      </div>

      <NewPaymentModal
        open={npOpen}
        onClose={() => setNpOpen(false)}
        hub={HUB}
        usdc={USDC}
        onSuccess={(paycardId) => {
          setNpOpen(false);
          showToast({ title: "Stream opened", body: paycardId });
          streamsData.refresh();
        }}
      />
      <ConfirmModal
        confirm={confirm}
        onClose={() => setConfirm(null)}
        onDone={(msg) => {
          setConfirm(null);
          showToast(msg);
          streamsData.refresh();
        }}
      />
      <ReceiptExportModal receipt={receiptModal} onClose={() => setReceiptModal(null)} />
      <Toast toast={toast} />
    </div>
  );
}
