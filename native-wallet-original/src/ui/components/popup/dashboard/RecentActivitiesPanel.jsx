import { activitySessionId } from "@/transactions/transaction-activity.js";
import { cancelQueuedSend } from "@/transactions/manual-send-queue.js";
import { isPendingActivity } from "@/ui/utils/transaction-activity.js";


import { txHistory } from "@/ui/store.js";
import { activityExplorerUrl } from "@/utils/format.js";

/** Convert a recorded timestamp to "N minutes ago" style. */
function relativeTime(tx) {
  const now = Date.now();
  const then = tx.id || now; // tx.id is Date.now() when recorded
  const diff = Math.max(0, now - then);

  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  const w = Math.floor(d / 7);
  return `${w} week${w === 1 ? "" : "s"} ago`;
}

/* 14px direction glyphs (currentColor so the row tints them). */
function LoadingIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" class="animate-spin" role="img" aria-label="Transaction pending"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round" /></svg>;
}
function FailedIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" role="img" aria-label="Transaction needs attention"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></svg>;
}
function ArrowOut() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}
function ArrowIn() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="17" y1="7" x2="7" y2="17" />
      <polyline points="7 11 7 17 13 17" />
    </svg>
  );
}
function ContractIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}



/** Trim a tx hash to "0x123456…c4d5" — first 6 + last 4 chars. */
function shortHash(h) {
  if (!h || typeof h !== "string" || h.length <= 10) return h || "—";
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

/* Signature-scheme chip: which key signed this OUTGOING op. Receives
   aren't signed by the wallet, so the chip is hidden for them. */
function SignatureChip({ tx }) {
  if (tx.kind === "receive" || !tx.mode || (["queued", "preparing", "cancelled"].includes(tx.status) && !tx.txHash)) return null;
  const sphincs = tx.mode === "SPHINCS";
  return (
    <span
      title={
        sphincs
          ? "Signed with SPHINCS-G"
          : "Signature details unavailable"
      }
      class={
        "shrink-0 self-center flex flex-col items-center justify-center leading-none text-[10px] font-mono uppercase tracking-[0.4px] px-2 pt-[5px] pb-[3px] rounded-full " +
        (sphincs
          ? "bg-cyan-400/20 text-cyan-400"
          : "bg-blue-hover/20 text-blue-hover")
      }
    >
      {sphincs ? "SPHINCS-G" : "Unknown"}
    </span>
  );
}

function ActivityRow({ tx, last }) {
  const pending = isPendingActivity(tx);
  const attention = ['failed', 'unknown', 'cancelled'].includes(tx.status);
  const isReceive = tx.kind === "receive";
  const isContract = tx.kind === "contract" || tx.kind === "contract-call";
  const isSendToken = tx.kind === "send-token";
  const label = isContract
    ? "Contract Interaction"
    : isReceive
      ? "Receive"
      : isSendToken
        ? "Send Token"
        : "Send";

  const Icon = pending ? LoadingIcon : attention ? FailedIcon : isContract ? ContractIcon : isReceive ? ArrowIn : ArrowOut;

  // Strip background + icon/value colour, tinted per direction.
  const tone = pending ? { strip: "bg-blue/20", text: "text-blue-hover" } : attention ? { strip: "bg-red/20", text: "text-red" } : isContract
    ? { strip: "bg-blue/20", text: "text-blue-hover" }
    : isReceive
      ? { strip: "bg-green/20", text: "text-green" }
      : { strip: "bg-red/20", text: "text-red" };

  // Display the requested amount; the status identifies unsuccessful transfers.
  const rightValue=tx.amount!=null?`${isReceive?'+':'−'}${tx.amount} ${tx.tokenSymbol || 'ETH'}`:'—';

  return (
    <a
      href={activityExplorerUrl(tx)}
      target="_blank"
      rel="noopener noreferrer"
      class={
        "w-full flex items-stretch no-underline transition-colors duration-150 hover:bg-bg-hover/40 " +
        (last ? "" : "border-b border-border")
      }
    >
      {/* Colored type strip. The Figma strip is aspect 30/40 (full row
          height); aspect-ratio can't derive its width from a flex-
          stretched height, so we pin an explicit width (~the 30/40 ratio
          at a typical row height) instead of letting it collapse to the
          icon. */}
      <span class={"shrink-0 self-stretch w-10 flex items-center justify-center " + tone.strip + " " + tone.text}>
        <Icon />
      </span>

      <span class="flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5">
        <span class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
          <span class="min-w-0 max-w-full flex items-center gap-1.5">
            <span class="type-label-button text-text-primary truncate">{label}</span>
            <SignatureChip tx={tx} />
          </span>
          <span class="type-label-caption text-text-dim truncate">{tx.status === 'queued' ? 'Queued · Waiting for previous transaction'
            : tx.status === 'preparing' ? 'Preparing transaction'
            : tx.status === 'cancelled' ? 'Not sent'
            : tx.status === 'signed' ? 'Signed · Awaiting submission'
            : tx.status === 'submitted' ? 'Pending confirmation'
            : tx.status === 'unknown' ? 'Confirmation not received'
            : tx.status === 'failed' ? 'Transaction failed' : shortHash(tx.txHash)}</span>
          {pending && tx.to && <span class="type-label-caption text-text-dim truncate">{tx.amount} {tx.tokenSymbol || "ETH"} · {shortHash(tx.to)}</span>}
          {attention && tx.error && <span class="type-label-caption text-text-dim break-words">{tx.error}</span>}
        </span>
        <span class="shrink-0 flex flex-col gap-1.5 items-end">
          {tx.status === 'queued' && tx.sessionId === activitySessionId ? <button type="button"
            onClick={event => { event.preventDefault(); event.stopPropagation(); cancelQueuedSend(tx.activityId); }}
            class="type-label-caption text-text-dim underline cursor-pointer bg-transparent border-none">Cancel</button>
            : <span class={"type-mono-amount whitespace-nowrap " + tone.text}>{rightValue}</span>}
          <span class="type-label-caption text-text-dim whitespace-nowrap">{relativeTime(tx)}</span>
        </span>
      </span>
    </a>
  );
}

/* A labelled, bordered group of rows (Figma 37:17568 + 37:17578). */
function TxGroup({ label, items }) {
  return (
    <div class="w-full flex flex-col">
      <div class="w-full flex items-center gap-1.5 pt-4 pb-2 pl-1">
        <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
        <span class="type-label-special text-text-dim">
          {label} - {items.length}
        </span>
      </div>
      <div class="w-full border border-border flex flex-col">
        {items.map((tx, i) => (
          <ActivityRow key={tx.activityId || tx.id} tx={tx} last={i === items.length - 1} />
        ))}
      </div>
    </div>
  );
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function RecentActivitiesPanel() {
  const items = txHistory.value || [];

  if (items.length === 0) {
    return (
      <div class="p-6 text-center type-body-md text-text-dim">
        No activity yet. Your transactions will appear here.
      </div>
    );
  }

  /* Newest first BY TIMESTAMP, not by array position: entries are
     appended by different producers (local sends at confirmation time,
     the incoming-tx poller at discovery time with the block's real
     timestamp), so insertion order is not chronological. */
  const sorted = items.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
  const now = Date.now();
  const recent = sorted.filter((tx) => now - (tx.id || now) <= THIRTY_DAYS_MS);
  const older = sorted.filter((tx) => now - (tx.id || now) > THIRTY_DAYS_MS);

  /* Horizontal gutter + bottom spacing come from the ExpandablePanel
     content frame (Figma 181:4342) — no extra padding here, so the row
     lists span the full inner width. */
  return (
    <div class="w-full flex flex-col">
      {recent.length > 0 && <TxGroup label="Last 30 days" items={recent} />}
      {older.length > 0 && <TxGroup label="Before" items={older} />}
    </div>
  );
}
