/* ═══════════════════════════════════════════════════════════════════
   store.js — reactive state via @preact/signals
   ───────────────────────────────────────────────────────────────────
   Replaces the singleton object in src/ui/state.js. Each field is its
   own signal so components subscribe only to the slices they read;
   mutating `busy` does not re-render the key tree, and vice versa.

   The legacy singleton (`state.js`) now re-exports a Proxy that forwards
   reads and writes to these signals, so non-migrated modules keep
   working verbatim:

       state.busy = true        →  busy.value = true
       state.tree[0]            →  tree.value[0]
       state.logs.push(x)       →  logs.value = [...logs.value, x]
                                   (see state.js proxy for array ops)

   Components (new code) import signals directly from here:

       import { page, busy } from "@/ui/store";

   Or via the hook wrappers in src/ui/hooks/ for a higher-level API.
   ═══════════════════════════════════════════════════════════════════ */

import { signal, computed, effect } from "@preact/signals";
import { DEFAULT_CHAIN_ID, NETWORKS } from "@/config/networks.js";

/* ── Navigation ──────────────────────────────────────────────────── */
// Kept for backward-compat with legacy pages. New code uses wouter routes.
// Default is "loading" so the popup shows the skeleton until bootstrap
// in popup/main.jsx has probed the vault and chosen the real target.
export const page = signal("loading");

// Surface the user has chosen for the wallet UI: "popup" (default) or
// "sidebar". Hydrated in popup/main.jsx from chrome.storage and used
// by SettingsMenu to render the mode-switch button. Mutated via the
// helpers in src/ui/utils/ui-mode.js.
export const uiMode = signal("popup");

/* ── Vault / onboarding transient state ─────────────────────────── */
export const loading = signal(false);
export const generatedPhrase = signal("");
export const recoverPhrase = signal("");
export const recoverSteps = signal([]);
export const recoverResult = signal(null);

/* ── Key material / smart account ───────────────────────────────── */
export const tree = signal([]);
export const currentIndex = signal(0);
export const smartAddr = signal("");

/* ── Multi-account ───────────────────────────────────────────────────
   `accounts` mirrors VaultManager.getAccountList() — one entry per
   multi-account derived from the seed at m/44'/60'/{index}'/0'/i'.
   `activeAccountIndex` is the currently selected account. Both are
   hydrated on unlock and updated on create/switch (see useAccounts). */
export const accounts = signal([]);
export const activeAccountIndex = signal(0);

/* ── Console log ─────────────────────────────────────────────────── */
export const logs = signal([]);
export const consoleOpen = signal(true);

/* ── Tx flow ─────────────────────────────────────────────────────── */
export const busy = signal(false);
export const txHistory = signal([]);
export const recipient = signal("");
export const amount = signal("0");
/* selectedToken: null = native ETH send. Otherwise:
     { address: "0x…", symbol: "DMYB", name?: string, decimals: 18 }
   The rotation modules read this to decide between native send and
   ERC-20 transfer encoding. */
export const selectedToken = signal(null);

/* ── Dashboard UI toggles ───────────────────────────────────────── */
export const activeTab = signal("home");
export const showReceive = signal(false);
export const showAccountManager = signal(false);
export const showAddAccount = signal(false);
export const addAccountTab = signal("hd");

/* ── Network ─────────────────────────────────────────────────────── */
export const chainId = signal(DEFAULT_CHAIN_ID);
export const showChainSelector = signal(false);
/* Bumped whenever a per-chain override changes (custom RPC / custom name).
   The `network` computed in useNetwork reads this so it recomputes — and
   every component showing the chain name/metadata re-renders — without a
   chain switch. */
export const chainOverridesVersion = signal(0);
/* Keep the legacy account-state mode at 2. It is not a signing-method
   selector: Daisugi's manual Send flow is fixed to SPHINCS-G below. */
export const mode = signal(2);

/* Mirror the active chain to globalThis so non-React modules
   (blockchain/client.js, config/networks.js → getActiveNetwork) can
   read it synchronously without taking a dependency on signals.

   The user can switch the live chain at runtime (useNetwork.switchChain,
   MetaMask-style); this effect keeps the global mirror in sync whenever
   the chainId signal changes. */
effect(() => {
  globalThis.__NT_CHAIN_ID = chainId.value;
});

/* Hydrate the chainId signal from chrome.storage at boot. Called
   imperatively from popup/main.jsx and onboarding/main.jsx before the
   App renders, so the first paint already shows the right network. */
export async function hydrateChainId() {
  try {
    const { nt_chainId } = await chrome.storage.local.get(["nt_chainId"]);
    if (nt_chainId && NETWORKS[nt_chainId]) {
      chainId.value = nt_chainId;
    } else {
      chainId.value = DEFAULT_CHAIN_ID;
    }
  } catch {
    chainId.value = DEFAULT_CHAIN_ID;
  }
  globalThis.__NT_CHAIN_ID = chainId.value;
}

/* ── dApp approval ──────────────────────────────────────────────── */
export const approvalMode = signal(false);
export const approvalData = signal(null);
// Transient: id of pending approval stashed before unlock.
export const pendingApprovalId = signal(null);
// True when the current window was spawned by the background as a
// dedicated approval popup (hash was #approve/<id> at boot). The
// Approval component uses this to decide whether to close the window
// on done/reject (detached popup) or navigate back to /dashboard
// (sidepanel / already-open popup — we must NOT close those).
export const isDetachedApproval = signal(false);

// This build uses one immutable SPHINCS-G key per native account.
export const signingMethod = computed(() => "sphincs");

/* ── Derived signals (read-only, auto-updating) ─────────────────── */
export const hasLogs = computed(() => logs.value.length > 0);
export const hasError = computed(() => logs.value.some((l) => l.type === "err"));

/* ── Registry: the full map, used by the Proxy in state.js ──────── */
export const SIGNALS = {
  page,
  loading,
  generatedPhrase,
  recoverPhrase,
  recoverSteps,
  recoverResult,
  tree,
  currentIndex,
  smartAddr,
  accounts,
  activeAccountIndex,
  logs,
  consoleOpen,
  busy,
  txHistory,
  recipient,
  amount,
  selectedToken,
  activeTab,
  showReceive,
  showAccountManager,
  showAddAccount,
  addAccountTab,
  chainId,
  showChainSelector,
  mode,
  approvalMode,
  approvalData,
  signingMethod,
  // Underscore-prefixed internal transient used by popup/main.js
  _pendingApprovalId: pendingApprovalId,
};
