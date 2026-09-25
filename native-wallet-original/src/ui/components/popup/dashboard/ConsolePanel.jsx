/* ═══════════════════════════════════════════════════════════════════
   ConsolePanel — live log stream from rotation / dApp flows
   ───────────────────────────────────────────────────────────────────
   Reads from the logs signal via useLogs. Auto-scrolls to bottom on
   new entries. Color-codes by log type.

   Not in the mockup but essential for debugging the send flow (FORS+C
   signing takes several seconds with several intermediate steps).
   Style as a collapsed bottom drawer if you want to hide it by
   default — the hook exposes `open` for that.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useRef } from "preact/hooks";
import { useLogs } from "@/ui/hooks";

const TYPE_COLOR = {
  info: "text-text-secondary",
  ok:   "text-brand",
  err:  "text-red",
  warn: "text-amber",
  step: "text-blue-text",
  data: "text-text-muted font-mono",
};

export function ConsolePanel() {
  const logs = useLogs();
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.entries.length]);

  return (
    <div class="border-t border-border">
      <div class="flex items-center justify-between px-4 py-2 text-xs">
        <div class="flex items-center gap-2">
          <span class="uppercase tracking-wide text-text-secondary font-semibold">
            Console
          </span>
          <span class="text-text-muted">({logs.entries.length})</span>
          {logs.hasError.value && (
            <span class="text-red">● error</span>
          )}
        </div>
        <div class="flex gap-2">
          <button
            onClick={() => logs.clear()}
            class="text-text-muted hover:text-text-primary"
          >
            clear
          </button>
          <button
            onClick={() => logs.toggle()}
            class="text-text-muted hover:text-text-primary"
          >
            {logs.open ? "hide" : "show"}
          </button>
        </div>
      </div>

      {logs.open && (
        <div
          ref={scrollRef}
          class="max-h-40 overflow-y-auto px-4 pb-3 font-mono text-[11px] leading-relaxed"
        >
          {logs.entries.length === 0 && (
            <div class="text-text-dim">No activity yet.</div>
          )}
          {logs.entries.map((l) => (
            <div key={l.id} class={TYPE_COLOR[l.type] || "text-text-secondary"}>
              <span class="text-text-dim">{l.time}</span> {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
