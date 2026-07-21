/** Shared formatting/style helpers for the new Cockpit views. */

export const EXPLORER_BASE_URL = "https://testnet.arcscan.app";

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE_URL}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE_URL}/address/${address}`;
}

export function shortHex(a: string | undefined | null, lead = 6, tail = 4): string {
  if (!a || typeof a !== "string") return "—";
  if (a.length <= lead + tail + 2) return a;
  return `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

/** Truncates an arbitrary long string (e.g. a generated link) for display only - never use
 * the result for copy/share/QR, which must always use the full untruncated value. */
export function truncateMiddle(s: string, lead = 42, tail = 24): string {
  if (s.length <= lead + tail + 1) return s;
  return `${s.slice(0, lead)}…${s.slice(-tail)}`;
}

export function fmtUsdcBase(baseUnits: string | bigint | undefined | null, dp = 6): string {
  if (baseUnits == null) return "—";
  const n = typeof baseUnits === "bigint" ? baseUnits : BigInt(baseUnits || "0");
  return (Number(n) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dp });
}

export function secsAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s <= 1) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function humanDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(seconds % 86400 ? 1 : 0)} day(s)`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)} hr`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(seconds % 60 ? 1 : 0)} min`;
  return `${seconds}s`;
}

export interface StatusMeta {
  label: string;
  dot: string;
  text: string;
  bg: string;
  bd: string;
}

/** Maps the indexer's Active/Terminated to the design's streaming/settling/closed language. */
export function statusMeta(status: "Active" | "Terminated", availableBalance: string): StatusMeta {
  if (status === "Active") {
    return { label: "streaming", dot: "#00C878", text: "#00794A", bg: "rgba(0,158,96,0.1)", bd: "rgba(0,158,96,0.3)" };
  }
  const drained = BigInt(availableBalance || "0") === 0n;
  return drained
    ? { label: "closed", dot: "#8A94A3", text: "rgba(11,17,32,0.6)", bg: "rgba(11,17,32,0.06)", bd: "rgba(11,17,32,0.14)" }
    : { label: "settling", dot: "#2A6FDB", text: "#1E4FA3", bg: "rgba(42,111,219,0.12)", bd: "rgba(42,111,219,0.35)" };
}

export interface ReceiptTypeMeta {
  id: "payment_opened" | "settlement_processed" | "residual_recovered";
  label: string;
  color: string;
  bg: string;
  bd: string;
  icon: string;
}

/** Canonical receipt type - maps 1:1 to sdk/src/receipts.ts <-> indexer event names. */
export function receiptTypeMeta(eventName: string): ReceiptTypeMeta {
  if (eventName === "PaycardProvisioned") {
    return { id: "payment_opened", label: "Opened", color: "#00794A", bg: "rgba(0,158,96,0.1)", bd: "rgba(0,158,96,0.3)", icon: "＋" };
  }
  if (eventName === "SettlementFlushed") {
    return { id: "settlement_processed", label: "Settled", color: "#1E4FA3", bg: "rgba(42,111,219,0.1)", bd: "rgba(42,111,219,0.32)", icon: "≈" };
  }
  return { id: "residual_recovered", label: "Residual Returned", color: "#8A6D00", bg: "rgba(214,175,80,0.14)", bd: "rgba(214,175,80,0.4)", icon: "↩" };
}

export function eventAmount(eventName: string, args: Record<string, string>): string {
  if (eventName === "PaycardProvisioned") return args.poolAllocation ?? "0";
  if (eventName === "SettlementFlushed") return args.amountWithdrawn ?? "0";
  return args.varianceSwept ?? "0";
}
