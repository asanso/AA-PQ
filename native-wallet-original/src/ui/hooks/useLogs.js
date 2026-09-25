/* ═══════════════════════════════════════════════════════════════════
   useLogs — console panel state
   ───────────────────────────────────────────────────────────────────
   The rotation flows call `log(msg, type)` from src/ui/logger.js, which
   pushes onto `state.logs`. The legacy Dashboard renders a collapsible
   console panel reading the same array.

   This hook exposes that, plus the open/closed toggle and derived
   convenience values (has-error flag, error count) so the console
   header can show a badge without re-filtering on every render.
   ═══════════════════════════════════════════════════════════════════ */

import { computed } from "@preact/signals";
import { logs, consoleOpen } from "@/ui/store.js";
import { log as pushLog } from "@/ui/logger.js";

const errorCount = computed(
  () => logs.value.filter((l) => l.type === "err").length
);

export function useLogs() {
  return {
    /** Reactive array of { time, msg, type, id }. Newest at the end. */
    get entries() { return logs.value; },
    /** Reactive open/closed state of the console panel. */
    get open() { return consoleOpen.value; },
    /** Reactive count of entries with type === "err". */
    errorCount,
    /** Reactive true when any entry is an error. */
    hasError: computed(() => errorCount.value > 0),

    toggle() { consoleOpen.value = !consoleOpen.value; },
    setOpen(v) { consoleOpen.value = !!v; },

    /**
     * Append a log entry. Same signature as src/ui/logger.js#log, which
     * the rotation modules already call. Exposed here so UI components
     * don't need to reach into ui/logger directly.
     *
     * @param {string} msg
     * @param {"info"|"ok"|"warn"|"err"|"step"|"data"} [type="info"]
     */
    push(msg, type = "info") { pushLog(msg, type); },

    clear() { logs.value = []; },
  };
}
