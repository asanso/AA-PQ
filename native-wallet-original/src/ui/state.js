/* ═══════════════════════════════════════════════════════════════════
   state.js — backward-compat Proxy over @preact/signals store
   ───────────────────────────────────────────────────────────────────
   Legacy modules (fors-rotation.js, Dashboard.js, Approval.js,
   popup/main.js, etc.) mutate a plain singleton:

       state.busy = true;
       state.tree = buildKeyTree(root, i);
       state.logs.push({ msg, type });
       state.txHistory.push(tx);
       state.recipient = "0x…";

   The new reactive source of truth lives in src/ui/store.js as a set
   of signals. This Proxy is a drop-in replacement that forwards reads
   and writes:

       get state.busy       →  busy.value
       set state.busy = v   →  busy.value = v
       state.logs.push(x)   →  logs.value = [...logs.value, x]

   Array mutations are the tricky case: `Array.prototype.push` mutates
   in place, which would leave the signal's internal === check thinking
   nothing changed (no re-render). We solve this by returning a second
   Proxy around arrays that intercepts the mutating methods and
   reassigns the underlying signal with a fresh array.

   Once all call sites have been migrated to import signals directly
   from "@/ui/store", this file can be deleted.
   ═══════════════════════════════════════════════════════════════════ */

import { SIGNALS } from "./store.js";

const MUTATING_ARRAY_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/**
 * Wrap an array value so mutating methods reassign the source signal.
 * Non-mutating methods (map, filter, forEach, …) go through untouched.
 */
function wrapArraySignal(sig) {
  const arr = sig.value;
  return new Proxy(arr, {
    get(target, prop) {
      if (MUTATING_ARRAY_METHODS.has(prop)) {
        return (...args) => {
          // Work on a copy so the signal sees a new reference.
          const next = target.slice();
          const result = Array.prototype[prop].apply(next, args);
          sig.value = next;
          return result;
        };
      }
      return Reflect.get(target, prop);
    },
    set(target, prop, value) {
      // `state.tree[5] = x` and `state.tree.length = 0` fall here.
      const next = target.slice();
      next[prop] = value;
      sig.value = next;
      return true;
    },
  });
}

export const state = new Proxy(
  {},
  {
    get(_t, prop) {
      const sig = SIGNALS[prop];
      if (!sig) {
        // Unknown key: return undefined silently. Legacy code sometimes
        // probes optional fields. Throwing here would be a regression.
        return undefined;
      }
      const v = sig.value;
      if (Array.isArray(v)) return wrapArraySignal(sig);
      return v;
    },
    set(_t, prop, value) {
      const sig = SIGNALS[prop];
      if (!sig) {
        // Legacy code occasionally stashes ad-hoc fields
        // (e.g. `state._pendingApprovalId`). We already registered the
        // known ones in SIGNALS; anything truly unexpected is dropped
        // with a warning so it surfaces during migration.
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            `[state shim] writing unknown field "${String(prop)}" — ` +
              `register it in src/ui/store.js if it should be reactive.`
          );
        }
        return true;
      }
      sig.value = value;
      return true;
    },
    has(_t, prop) {
      return prop in SIGNALS;
    },
    ownKeys() {
      return Object.keys(SIGNALS);
    },
    getOwnPropertyDescriptor(_t, prop) {
      if (prop in SIGNALS) {
        return { enumerable: true, configurable: true, value: SIGNALS[prop].value };
      }
      return undefined;
    },
  }
);
