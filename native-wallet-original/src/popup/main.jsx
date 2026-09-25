/* ═══════════════════════════════════════════════════════════════════
   popup/main.jsx — popup entry point
   ───────────────────────────────────────────────────────────────────
   Responsibilities:
     1. Load theme tokens.
     2. Mount the Preact <App /> into #app.
     3. Run the session / approval bootstrap that used to live in
        the vanilla src/popup/main.js:
          - probe vault existence
          - try auto-unlock via chrome.storage.session["nt_session_key"]
          - if opened as #approve/<id>, load that pending request
          - set the current route via the `page` signal
     4. Keep the APPROVE_REQUEST runtime.onMessage bridge so an already
        open popup receives fresh approval pushes from the background.

   The UI (routes, screens, layout) is built by the user in <App />;
   this file is pure plumbing.

   DEV MODE:
     The `dev-mocks` import installs shims for chrome.* APIs so the
     popup renders at http://localhost:5173/popup.html with full HMR.
     The module is a no-op in production: Vite statically evaluates
     `import.meta.env.DEV` to false and tree-shakes the body.
   ═══════════════════════════════════════════════════════════════════ */

// Dev-only chrome.* shim. MUST be first — the chrome.runtime.onMessage
// listener at the bottom of this file is top-level, so `chrome` must
// exist by the time this module finishes evaluating.
import "../dev-mocks";

import { render } from "preact";
import "@/ui/styles/theme.css";

import { hydrateTheme } from "@/ui/theme.js";
import { probeVault } from "@/ui/hooks/useVault.js";
import { vaultManager } from "@/vault/VaultManager.js";

import { ensureWasmKeccak } from "@/crypto/keccak.js";
import { keccakBatchInit } from "@/crypto/keccak-batch.js";

import {
  page,
  tree,
  currentIndex,
  smartAddr,
  mode,
  chainId,
  approvalMode,
  approvalData,
  pendingApprovalId,
  isDetachedApproval,
  hydrateChainId,
} from "@/ui/store.js";
import { storageGet } from "@/utils/storage.js";
import {
  hydrateCustomRpc,
  hydrateCustomChainNames,
} from "@/config/networks.js";

import { refreshAccountsSignal, hydrateActiveAccount } from "@/ui/hooks/useAccounts.js";
import { getSessionKey, clearSessionKey } from "./session.js";
import { installTxHistoryPersistence } from "@/ui/persistence/tx-persistence.js";
import { installTokenPersistence } from "@/ui/hooks/useTokens.js";

import { getUiMode, applyUiMode } from "@/ui/utils/ui-mode.js";
import { uiMode } from "@/ui/store.js";

import { App } from "./App.jsx";

// Hook the txHistory signal to chrome.storage.local so transactions
// survive popup close. Must run before any component mounts so the
// load effect fires on the smartAddr change during unlock.
installTxHistoryPersistence();
installTokenPersistence();

// Upgrade keccak-256 to the WASM fast-path (hash-wasm) for the whole popup
// context at boot. SPHINCS-G uses the original Keccak implementation.
// back to @noble until the swap completes — well before the first
// user-triggered send. Also benefits any main-thread SPHINCS⁺ hashing.
ensureWasmKeccak().catch(() => {});

// Also load the Rust batch kernel (keccak-batch): forsSign/buildAllTrees
// dispatch to the batched twins the moment it is active, per-hash until
// then — bit-identical either way. Fire-and-forget like above.
keccakBatchInit()
  .then((r) =>
    console.log(`[NiceTry keccak-batch] popup: active=${r.active} simd=${r.simd}`),
  )
  .catch(() => {});

// Hydrate the popup-vs-sidebar mode signal from storage and re-apply
// the matching chrome.action / chrome.sidePanel config in case the
// service worker was killed and the settings reverted to manifest
// defaults. Fire-and-forget — the SettingsMenu reads the signal
// directly and renders once it updates.
getUiMode().then((mode) => {
  uiMode.value = mode;
  applyUiMode(mode);
});

// Confirm the active stone/slate theme from the canonical store. The
// inline <script> in popup.html already applied it pre-paint from the
// localStorage mirror; this reconciles with chrome.storage (e.g. first
// load after install, or if changed from another context).
hydrateTheme();

function getPendingRequest(pendingId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_PENDING", pendingId }, (res) => {
      resolve(res || null);
    });
  });
}

/** Re-sync signals from vaultManager after a successful unlock. */
async function hydrateFromVault() { refreshAccountsSignal(); await hydrateActiveAccount(); }

async function bootstrap() {
  /* Boot watchdog: the loading skeleton must never hang. If bootstrap
     hasn't reached a terminal screen within the timeout (a wedged chrome
     API callback, a pathological async stall), fall back to a usable
     screen so the user is never stuck on the spinner. */
  let hasVault = true;
  const bootWatchdog = setTimeout(() => {
    if (page.value === "loading") {
      console.warn("[NiceTry] bootstrap watchdog fired — forcing fallback screen");
      page.value = hasVault ? "unlock" : "landing";
    }
  }, 8000);

  // Hydrate the active chain from storage BEFORE any blockchain code
  // runs. publicClient / pimlicoClient resolve lazily off
  // globalThis.__NT_CHAIN_ID, so this must complete before unlock /
  // hydrateFromVault triggers any RPC calls.
  await hydrateChainId();

  // Same timing constraint for the user's custom RPC override: getRpcUrls()
  // reads the __NT_CUSTOM_RPC mirror synchronously, so seed it from storage
  // before the first client is built. Custom chain names feed getNetwork()
  // the same way — seed both before the first render/RPC call.
  await hydrateCustomRpc();
  await hydrateCustomChainNames();

  // Is this popup window an approval popup? (opened by background with
  // URL hash #approve/<pendingId>) If so, flag this window as a
  // detached approval popup — the Approval component reads this to
  // decide whether to window.close() after done (detached: yes,
  // sidepanel/inline: no, navigate to /dashboard instead).
  const approvalMatch = window.location.hash.match(/^#approve\/([0-9a-f]+)$/i);
  if (approvalMatch) {
    isDetachedApproval.value = true;
  }

  try {
    const status = await probeVault();

    if (status === "empty") {
      hasVault = false;
      page.value = "landing";
      return;
    }

    // Try to auto-unlock using the derived session key (never the
    // raw password — see session.js).
    const sessionKey = await getSessionKey();
    if (sessionKey) {
      try {
        await vaultManager.unlockWithKey(sessionKey);
        await hydrateFromVault();

        if (approvalMatch) {
          const pendingId = approvalMatch[1];
          const pending = await getPendingRequest(pendingId);
          if (pending) {
            approvalMode.value = true;
            approvalData.value = { ...pending, pendingId };
            page.value = "approve";
            return;
          }
        }

        page.value = "dashboard";
        return;
      } catch {
        clearSessionKey();
      }
    }

    // Vault exists but no/invalid session → need password.
    if (approvalMatch) {
      // Stash the pending id so the unlock screen can complete the
      // approval flow after the user types their password.
      pendingApprovalId.value = approvalMatch[1];
    }
    page.value = "unlock";
  } catch {
    page.value = "landing";
  } finally {
    clearTimeout(bootWatchdog);
  }
}

/* ── Runtime bridge for approvals pushed to an already-open popup ── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "APPROVE_REQUEST") {
    approvalMode.value = true;
    approvalData.value = msg;
    page.value = "approve";
    // Force a hash change so useHashLocation's hashchange handler
    // fires even if the signal value was already "approve" (e.g. a
    // second approval right after finishing the first). Setting to
    // an intermediate value first ensures the change is detected
    // even when the hash is already "#approve".
    if (window.location.hash !== "#approve") {
      window.location.hash = "approve";
    } else {
      // Already on #approve from a previous request. Bounce to
      // force a hashchange event — the router re-reads signals on
      // the event and re-renders the Approval component with the
      // new approvalData.
      window.location.hash = "";
      window.location.hash = "approve";
    }
    sendResponse({ ok: true });
  }
  return true;
});

/* ── UI presence port ────────────────────────────────────────────
   Open a long-lived runtime port so the background knows a UI
   surface (popup or side panel) is currently showing. When the
   surface closes, Chrome fires onDisconnect on the background side,
   letting it decide whether to spawn a detached popup window for
   the next approval request.

   Reconnect on disconnect: in MV3 the service worker is killed after
   ~30s of inactivity, which tears down our port. The UI page stays
   alive but the background's port count drops to 0 — without a
   reconnect, the SW would think no UI is open and spawn a redundant
   popup window for the next dApp request even though the sidebar is
   still visible. Re-establishing the port also wakes the SW, so it
   re-applies the action/sidePanel config from storage on respawn.

   Kept out of the dev mock path because chrome.runtime.connect is
   not shimmed there (it's only needed for real extension behavior).
*/
if (!import.meta.env.DEV && chrome.runtime?.connect) {
  let uiPortReconnectAttempts = 0;
  const connectUiPort = () => {
    try {
      const port = chrome.runtime.connect({ name: "nicetry-ui" });
      port.onDisconnect.addListener(() => {
        // Cap retries so a permanently-broken environment can't loop.
        if (uiPortReconnectAttempts++ < 20) {
          setTimeout(connectUiPort, 250);
        }
      });
    } catch (e) {
      console.warn("[NiceTry] UI port connect failed:", e);
    }
  };
  connectUiPort();
}

/* ── Mount ──────────────────────────────────────────────────────── */

function mount() {
  const el = document.querySelector("#app");
  if (!el) return;
  render(<App />, el);
}

bootstrap();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
