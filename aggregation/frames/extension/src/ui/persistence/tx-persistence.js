/* ═══════════════════════════════════════════════════════════════════
   tx-persistence.js — transparent persistence for txHistory signal
   ───────────────────────────────────────────────────────────────────
   Problem:
     The `txHistory` signal lives in memory. When the popup window
     closes, memory is freed; reopening shows an empty list even
     though real on-chain transactions happened.

   Solution:
     - Install one effect() that writes txHistory.value to
       chrome.storage.local whenever it changes
     - Install one effect() that watches smartAddr — when it flips
       (after unlock / restore / account switch), load the matching
       history from storage into the signal
     - Use a per-vault storage key so two different vaults on the
       same browser profile don't cross-contaminate

   Storage shape:
     chrome.storage.local[`nt_txhistory_${smartAddressLower}_${chainId}`] = [
       { id, time, txHash, userOpHash, to, amount, keyFrom, keyTo,
         signerAddr, newSignerAddr, mode },
       ...
     ]

   Nothing in fors-rotation.js changes. It keeps pushing to
   state.txHistory, which routes to the signal, which triggers this
   effect, which writes to storage. One-way data flow.

   Called exactly once, from src/popup/main.jsx on module import.
   ═══════════════════════════════════════════════════════════════════ */

import { effect } from "@preact/signals";
import { txHistory, smartAddr, chainId } from "@/ui/store.js";

const MAX_HISTORY = 200;

/* Per (smart-account, chainId) key. The SA address is identical on every
   supported chain, so chainId MUST be in the key or histories from
   different chains collide under a single entry. */
function storageKeyFor(addr, cid) {
  if (!addr) return null;
  const base = "nt_txhistory_" + addr.toLowerCase();
  return cid ? base + "_" + String(cid).toLowerCase() : base;
}

/* Suspension flag: while we're LOADING history from storage into the
   signal, we don't want the write-effect to immediately echo it back
   to storage (pointless round-trip) or — worse — to write the empty
   array we start from before the load completes. */
let suspendWrites = false;

function readFromStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      const v = res?.[key];
      resolve(Array.isArray(v) ? v : []);
    });
  });
}

function writeToStorage(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

let installed = false;

export function installTxHistoryPersistence() {
  if (installed) return;
  installed = true;

  /* ── Load effect ──────────────────────────────────────────────
     Reacts to smartAddr. Every time the active smart account
     changes (fresh unlock, vault restore, account switch if we ever
     add one), reload history from the corresponding storage key.

     Edge: smartAddr briefly goes "" during lock. We don't reload
     on empty — txHistory is already cleared by the lock path in
     SettingsMenu, and we don't want to overwrite it with anything.
  */
  effect(() => {
    const addr = smartAddr.value;
    const cid = chainId.value; // re-load when either SA or chain changes
    const key = storageKeyFor(addr, cid);
    if (!key) return;

    (async () => {
      suspendWrites = true;
      try {
        const stored = await readFromStorage(key);
        /* Replace UNCONDITIONALLY with this smart account's stored
           history. Each account has its own SA → its own storage key, so
           switching accounts must show only that account's transactions
           (and never bleed the previous account's list into the new one).
           An account with no history loads as []. The suspendWrites flag
           keeps the write-effect from echoing the previous account's
           in-memory list to the new account's key during the swap. */
        txHistory.value = stored;
      } finally {
        suspendWrites = false;
      }
    })();
  });

  /* ── Cross-context sync ───────────────────────────────────────
     The same chrome.storage.local entry is written by multiple
     extension contexts: this UI surface, the sibling surface (e.g.
     a detached approval popup window opened by background while a
     sidebar is also showing), and the background's incoming-tx
     poller. Each context has its OWN preact signal — without this
     listener, a write from another context only becomes visible
     after a manual reload of the surface (close/reopen sidebar).

     We listen for storage.onChanged scoped to our active key and
     replace the in-memory signal with the new array. Suspend the
     write effect during the swap so we don't echo the value back
     into storage (which would no-op on equality but is wasteful).
  */
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const key = storageKeyFor(smartAddr.value, chainId.value);
      if (!key) return;
      const change = changes[key];
      if (!change) return;
      const next = Array.isArray(change.newValue) ? change.newValue : [];
      // Reference equality short-circuit: signals would re-render
      // anyway because we're handing them a new array, but skipping
      // the trivial "we just wrote this" case avoids a render churn.
      if (next === txHistory.value) return;
      suspendWrites = true;
      try {
        txHistory.value = next;
      } finally {
        suspendWrites = false;
      }
    });
  }

  /* ── Write effect ─────────────────────────────────────────────
     Reacts to txHistory. Fires on every push/replace. Debounced
     via microtask batching: multiple rapid pushes in one tick
     result in a single write. (Signals already deduplicate
     identical references, so setting the same array twice is a
     no-op.)
  */
  effect(() => {
    const items = txHistory.value;
    const addr = smartAddr.value;
    const cid = chainId.value;
    const key = storageKeyFor(addr, cid);

    // Read all dependencies BEFORE any early-return so the effect
    // subscribes to all of them.
    if (suspendWrites) return;
    if (!key) return;

    // Cap size to avoid unbounded storage growth.
    const trimmed =
      items.length > MAX_HISTORY
        ? items.slice(items.length - MAX_HISTORY)
        : items;

    // Fire-and-forget. We don't await; the next mutation will just
    // replace this pending write in storage.
    writeToStorage(key, trimmed).catch((e) => {
      console.warn("[NiceTry] tx-persistence write failed:", e);
    });
  });
}

/**
 * Remove the persisted history for a specific smart account. Call this
 * when the user deletes their wallet so storage doesn't accumulate
 * stale entries from cancelled accounts.
 *
 * No-op if `addr` is falsy or no entry exists.
 */
export function clearTxHistoryForAddress(addr) {
  if (!addr) return Promise.resolve();
  // SA is identical across chains → one history key per chain. Remove
  // every chain's entry for this address.
  const prefix = "nt_txhistory_" + addr.toLowerCase();
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all || {}).filter((k) => k.startsWith(prefix));
      if (!keys.length) return resolve();
      chrome.storage.local.remove(keys, resolve);
    });
  });
}