/**
 * LinkLanding — the page a RailsFlow/RailsCard link actually opens.
 *
 * Reads the `#or=` token straight from the URL, shows the terms in plain words,
 * gates on Connect Wallet, then pays (RailsFlow) or claims (RailsCard) via the
 * shared self-submit hook. Mounted at /openrails/flow and /openrails/card.
 *
 * Visually matches the new light Cockpit design system (Panel / PrimaryButton),
 * not the old dark "liquid glass" theme still used by Landing.tsx.
 */
import { useMemo } from "react";
import { motion } from "framer-motion";
import { Link, useLocation } from "react-router-dom";
import { ConnectWalletButton } from "../components/ConnectWalletButton";
import { revealParent, revealChild } from "../components/Glass";
import { Panel, PrimaryButton } from "../components/cockpit/Panel";
import { toUsdc, fmtUsd, shortHex } from "../lib/api";
import {
  parseOpenRailsLink,
  type OpenRailsLinkArtifact,
  type RailsCardLinkPayload,
  type RailsFlowLinkPayload,
} from "../lib/links";
import { deserializeEnvelope, type CryptographicEnvelopeV1 } from "../lib/intents";
import { useRailsActions } from "../lib/useRailsActions";
import { useWalletConnection } from "../lib/useWalletConnection";

const MONO = "'JetBrains Mono', monospace";
const PAGE_BG = "radial-gradient(120% 100% at 100% 0%, #FDFEFF 0%, #EDF0F4 55%, #E4E8EE 100%)";
const INK = "#0B1120";
const INK_SECONDARY = "rgba(11,17,32,0.55)";
const INK_FAINT = "rgba(11,17,32,0.42)";
const GREEN = "#009E60";
const GREEN_DEEP = "#00794A";

function velPerHr(basePerSec: string | number): string {
  return ((Number(basePerSec) / 1e6) * 3600).toFixed(4);
}

function humanDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(seconds % 86400 ? 1 : 0)} day(s)`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)} hr`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(seconds % 60 ? 1 : 0)} min`;
  return `${seconds}s`;
}

interface Terms {
  kind: OpenRailsLinkArtifact["kind"];
  title: string;
  action: string;
  valueUsdc: number;
  velocityHr: string;
  lifespanSeconds: number;
  instant: boolean;
  counterpartyLabel: string;
  counterparty: string;
  note: string;
}

function buildTerms(a: OpenRailsLinkArtifact): Terms {
  if (a.kind === "railscard") {
    const pl = a.payload as RailsCardLinkPayload;
    const env = deserializeEnvelope<CryptographicEnvelopeV1>(pl.envelopeToken);
    const m = env.metadata;
    const lifespanSeconds = Number(m?.lifespanSeconds ?? env.intent.lifespanSeconds);
    return {
      kind: "railscard",
      title: "Claim a RailsCard",
      action: "Claim this card",
      valueUsdc: toUsdc(m?.amount ?? env.intent.totalAllocationPool),
      velocityHr: velPerHr(m?.flowVelocityPerSecond ?? env.intent.flowVelocityPerSecond),
      lifespanSeconds,
      instant: lifespanSeconds === 0,
      counterpartyLabel: "From (payer)",
      counterparty: env.payerAddress,
      note:
        pl.mode === "railscard_bearer"
          ? "The value opens to your connected wallet. Escrow is pulled from the payer (they already signed) and gas is sponsored by the keeper — you pay nothing. Prefer to pay your own gas? Use self-submit below."
          : "This card is recipient-bound. Escrow is pulled from the payer and gas is sponsored by the keeper — you pay nothing. Prefer to pay your own gas? Use self-submit below.",
    };
  }
  const pl = a.payload as RailsFlowLinkPayload;
  return {
    kind: "railsflow",
    title: "Pay a RailsFlow request",
    action: pl.lifespanSeconds === 0 ? "Pay · in full" : "Pay · open stream",
    valueUsdc: toUsdc(pl.amount),
    velocityHr: velPerHr(pl.flowVelocityPerSecond),
    lifespanSeconds: pl.lifespanSeconds,
    instant: pl.lifespanSeconds === 0,
    counterpartyLabel: "Recipient",
    counterparty: pl.recipient,
    note: "You are the payer. You sign the intent + a permit (no approval tx) and the keeper opens it and pays gas. USDC escrow still comes from your wallet, goes to the recipient, and unspent residual returns to you. Prefer to submit it yourself? Use self-submit below.",
  };
}

function DefRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <>
      <dt style={{ color: INK_FAINT }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: "right", color: valueColor ?? INK_SECONDARY }}>{value}</dd>
    </>
  );
}

export default function LinkLanding() {
  const { isConnected, address } = useWalletConnection();
  const { config, status, busy, act, claimRailsCard, claimRailsCardSponsored, payRailsFlowSponsored, reset } = useRailsActions();
  const location = useLocation();

  // Re-parse on every hash change, not just at mount — /openrails/flow and /openrails/card
  // both render this same component keyed only by the URL fragment (#or=<token>), and
  // navigating to a new fragment on the same path is a same-document navigation (no reload,
  // no remount). Without location.hash as a dependency, a second link opened in an
  // already-open tab would keep showing the first link's terms.
  const parsed = useMemo(() => {
    try {
      const artifact = parseOpenRailsLink(window.location.href);
      return { artifact, terms: buildTerms(artifact), error: null as string | null };
    } catch (e) {
      return { artifact: null, terms: null, error: e instanceof Error ? e.message : String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.hash]);

  const explorer = config?.explorerBaseUrl ?? "https://testnet.arcscan.app";

  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        color: INK,
        minHeight: "100vh",
        background: PAGE_BG,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 16px",
      }}
    >
      <motion.div variants={revealParent} initial="hidden" animate="show" style={{ width: "100%", maxWidth: 520 }}>
        <motion.div variants={revealChild} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <Link to="/" style={{ fontFamily: MONO, fontSize: 16, fontWeight: 700, color: GREEN, textDecoration: "none" }}>
            //openrails
          </Link>
          <ConnectWalletButton />
        </motion.div>

        {parsed.error || !parsed.artifact || !parsed.terms ? (
          <Panel>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "44px 28px", textAlign: "center" }}>
              <span
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 48,
                  height: 48,
                  borderRadius: 13,
                  background: "rgba(199,58,58,0.1)",
                  color: "#C73A3A",
                  fontSize: 22,
                  fontWeight: 700,
                }}
              >
                !
              </span>
              <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: INK_FAINT }}>
                This link couldn't be read
              </div>
              <p style={{ margin: 0, maxWidth: 360, fontSize: 13, lineHeight: 1.6, color: INK_SECONDARY }}>
                {parsed.error ?? "Missing or invalid OpenRails link."}
              </p>
              <Link to="/cockpit" style={{ marginTop: 4, fontFamily: MONO, fontSize: 11, color: GREEN, textDecoration: "none" }}>
                Open the cockpit →
              </Link>
            </div>
          </Panel>
        ) : (
          <Panel>
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{parsed.terms.title}</h1>
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: MONO,
                    fontSize: 10,
                    color: GREEN_DEEP,
                    background: "rgba(0,158,96,0.1)",
                    border: "1px solid rgba(0,158,96,0.3)",
                    borderRadius: 999,
                    padding: "3px 10px",
                  }}
                >
                  {parsed.terms.kind}
                </span>
              </div>

              <dl
                style={{
                  margin: 0,
                  marginTop: 18,
                  paddingTop: 16,
                  borderTop: "1px solid rgba(11,17,32,0.08)",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  rowGap: 8,
                  columnGap: 12,
                  fontFamily: MONO,
                  fontSize: 12,
                }}
              >
                <DefRow label="Type" value={parsed.terms.instant ? "One-time" : "Streaming"} valueColor={GREEN_DEEP} />
                <DefRow label="Value" value={`$${fmtUsd(parsed.terms.valueUsdc)} USDC`} valueColor={INK} />
                {parsed.terms.instant ? (
                  <DefRow label="Settles" value="in full, once" />
                ) : (
                  <>
                    <DefRow label="Velocity" value={`${parsed.terms.velocityHr} USDC/hr`} />
                    <DefRow label="Lifespan" value={humanDuration(parsed.terms.lifespanSeconds)} />
                  </>
                )}
                <DefRow label={parsed.terms.counterpartyLabel} value={shortHex(parsed.terms.counterparty, 8, 6)} />
              </dl>

              <p
                style={{
                  margin: 0,
                  marginTop: 16,
                  borderRadius: 10,
                  background: "rgba(11,17,32,0.035)",
                  border: "1px solid rgba(11,17,32,0.06)",
                  padding: "11px 13px",
                  fontFamily: MONO,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: INK_FAINT,
                }}
              >
                {parsed.terms.note}
              </p>

              <div style={{ marginTop: 20 }}>
                {status.id === "success" ? (
                  <div
                    style={{
                      borderRadius: 12,
                      border: "1px solid rgba(0,158,96,0.3)",
                      background: "rgba(0,158,96,0.08)",
                      padding: 16,
                      fontFamily: MONO,
                      fontSize: 12,
                      color: GREEN_DEEP,
                    }}
                  >
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {parsed.terms.kind === "railscard" ? "Claimed ✓" : "Stream opened ✓"}
                    </p>
                    <p style={{ margin: 0, marginTop: 4, color: INK_SECONDARY }}>
                      Paycard {shortHex(status.paycardId, 8, 6)} ·{" "}
                      <a style={{ color: GREEN_DEEP, textDecoration: "underline" }} href={`${explorer}/tx/${status.txHash}`} target="_blank" rel="noopener noreferrer">
                        view tx
                      </a>
                    </p>
                    <Link to="/cockpit" style={{ display: "inline-block", marginTop: 12, fontSize: 11, color: GREEN_DEEP, textDecoration: "none" }}>
                      View in cockpit →
                    </Link>
                  </div>
                ) : !isConnected ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 12,
                      borderRadius: 12,
                      border: "1px solid rgba(11,17,32,0.1)",
                      background: "rgba(11,17,32,0.025)",
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: INK_FAINT }}>
                      Connect a wallet to {parsed.terms.kind === "railscard" ? "claim" : "pay"}
                    </span>
                    <ConnectWalletButton />
                  </div>
                ) : (
                  <>
                    {/* A wallet can already be connected here purely from a persisted Privy
                        session (same browser used before) — without this, jumping straight to
                        the claim/pay button can wrongly read as "no wallet was needed." The
                        header's ConnectWalletButton already covers switching/disconnecting, so
                        this is just a plain confirmation line, not a second copy of that widget. */}
                    <div
                      style={{
                        marginBottom: 10,
                        fontFamily: MONO,
                        fontSize: 11,
                        color: INK_FAINT,
                      }}
                    >
                      Connected as <span style={{ color: INK }}>{shortHex(address!, 8, 6)}</span>
                    </div>
                    <PrimaryButton
                      onClick={() =>
                        parsed.terms!.kind === "railscard"
                          ? claimRailsCardSponsored(parsed.artifact!)
                          : payRailsFlowSponsored(parsed.artifact!)
                      }
                      disabled={busy || !config}
                      style={{ width: "100%", borderRadius: 12, padding: "13px 20px", fontFamily: MONO, fontSize: 13 }}
                    >
                      {status.id === "approving"
                        ? "Approving USDC…"
                        : status.id === "signing"
                        ? "Sign in your wallet…"
                        : status.id === "submitting"
                        ? "Submitting to Arc…"
                        : parsed.terms.kind === "railscard"
                        ? "Claim · gas sponsored"
                        : "Pay · gas sponsored"}
                    </PrimaryButton>
                    {!busy && (
                      <button
                        type="button"
                        onClick={() =>
                          parsed.terms!.kind === "railscard"
                            ? claimRailsCard(parsed.artifact!)
                            : act(parsed.artifact!)
                        }
                        disabled={!config}
                        style={{
                          display: "block",
                          width: "100%",
                          marginTop: 10,
                          background: "none",
                          border: "none",
                          cursor: config ? "pointer" : "not-allowed",
                          fontFamily: MONO,
                          fontSize: 11,
                          color: INK_FAINT,
                          textDecoration: "underline",
                          textUnderlineOffset: 2,
                          opacity: config ? 1 : 0.5,
                        }}
                      >
                        or self-submit (you pay gas)
                      </button>
                    )}
                    {status.id === "error" && (
                      <p style={{ margin: 0, marginTop: 10, wordBreak: "break-word", fontFamily: MONO, fontSize: 11, color: "#C73A3A" }}>
                        {status.msg}{" "}
                        <button
                          type="button"
                          onClick={reset}
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "#C73A3A", textDecoration: "underline", opacity: 0.75 }}
                        >
                          try again
                        </button>
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </Panel>
        )}
      </motion.div>
    </div>
  );
}
