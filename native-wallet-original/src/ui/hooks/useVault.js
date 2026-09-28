import { signal, computed } from "@preact/signals";
import { vaultManager } from "@/vault/VaultManager.js";


import { refreshAccountsSignal, hydrateActiveAccount } from "./useAccounts.js";



import {
  tree,
  currentIndex,
  smartAddr,
  mode as modeSignal,
  chainId,
} from "@/ui/store.js";

/* ── Internal status signal ─────────────────────────────────────── */
// "unknown" → first tick, we haven't probed chrome.storage yet.
// "empty"   → no vault in storage, show landing.
// "locked"  → vault exists, needs password.
// "unlocked"→ keyrings loaded, ready to use.
const status = signal("unknown");
const error = signal(null);

export async function probeVault() {
  try {
    const has = await vaultManager.hasVault();
    if (!has) {
      status.value = "empty";
      return "empty";
    }
    // Has vault but not yet unlocked in this session. Use isUnlocked()
    // (keyrings loaded) — `password` is null after a session-key unlock.
    if (!vaultManager.isUnlocked()) status.value = "locked";
    else status.value = "unlocked";
    return status.value;
  } catch (e) {
    error.value = e;
    status.value = "empty";
    return "empty";
  }
}




/**
 * Re-sync signals from vaultManager after unlock / restore.
 * Keeps the store in sync with the in-memory keyring state.
 */
async function hydrateFromVault() { refreshAccountsSignal(); await hydrateActiveAccount(); }

export function useVault() {
  return {
    /** Read-only reactive status. */
    get status() { return status.value; },
    get error()  { return error.value; },
    isLocked: computed(() => status.value === "locked"),
    isUnlocked: computed(() => status.value === "unlocked"),
    isEmpty: computed(() => status.value === "empty"),

    /** Initial probe. Call once from the entry point (main.jsx). */
    probe: probeVault,

    /** Create brand new vault → returns mnemonic to show the user. */
    async create(password) {
      error.value = null;
      const mnemonic = await vaultManager.createNewVault(password);
      await hydrateFromVault();
      status.value = "unlocked";
      return mnemonic;
    },

    /** Restore from existing mnemonic. */
    async restore(password, phrase) {
      error.value = null;
      const accounts = await vaultManager.restoreVault(password, phrase);
      await hydrateFromVault();
      status.value = "unlocked";
      return accounts;
    },


    async unlock(password) {
      try {
        error.value = null;
        const accounts = await vaultManager.unlock(password);
        await hydrateFromVault();
        status.value = "unlocked";

        /* Apply any SW-observed owner transitions queued while the
           popup was locked (transferred → handover_complete, etc.). */
        return accounts;
      } catch (e) {
        error.value = e;
        throw e;
      }
    },

    /** In-memory lock — password cleared, vault stays in storage. */
    lock() {
      vaultManager.lock();
      status.value = "locked";
    },

    /** Nuke the whole vault from storage. */
    async destroy() {
      await vaultManager.deleteVault();
      tree.value = [];
      currentIndex.value = 0;
      smartAddr.value = "";
      status.value = "empty";
    },

    /** Raw access for now — keeps legacy code paths working. */
    manager: vaultManager,
  };
}
