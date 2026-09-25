/* ═══════════════════════════════════════════════════════════════════
   ui-mode.js — popup-vs-sidebar exclusivity helpers
   ───────────────────────────────────────────────────────────────────
   The user wanted MetaMask-style behavior: never both the popup and
   the side panel open at the same time. Chrome lets us implement
   exclusivity by reconfiguring the action button:

     popup mode    → action.setPopup({ popup: "popup.html" }),
                     sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
     sidebar mode  → action.setPopup({ popup: "" }),
                     sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

   In sidebar mode `default_popup` is suppressed so clicking the
   toolbar icon toggles the side panel instead of opening the popup —
   the two surfaces no longer coexist.

   The current mode is mirrored to chrome.storage.local under
   `nt_ui_mode` so the background SW can re-apply it on every wake-up
   (Chrome does persist these settings across SW restarts, but the
   storage value also drives the SettingsMenu's conditional toggle).
   ═══════════════════════════════════════════════════════════════════ */

export const UI_MODE_KEY = "nt_ui_mode";

export async function getUiMode() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return "popup";
  try {
    const data = await chrome.storage.local.get(UI_MODE_KEY);
    return data?.[UI_MODE_KEY] === "sidebar" ? "sidebar" : "popup";
  } catch {
    return "popup";
  }
}

/** Toggle DOM-level layout for the active surface. The popup needs a
    fixed width (Chrome sizes the window from <body>); the side panel is
    user-resizable, so it must be fluid — fill the panel, grow when
    widened, shrink without clipping when narrowed. Runs only where a
    document exists (UI contexts, not the background service worker). */
export function applyUiSurfaceLayout(mode) {
  if (typeof document === "undefined" || !document.body) return;
  const isSidebar = mode === "sidebar";
  document.body.classList.toggle("sidebar-surface", isSidebar);
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) {
    vp.setAttribute(
      "content",
      isSidebar
        ? "width=device-width, initial-scale=1"
        : "width=420, initial-scale=1.0",
    );
  }
}

/** Apply the chrome action + sidePanel config matching `mode`. Idempotent. */
export async function applyUiMode(mode) {
  applyUiSurfaceLayout(mode);
  if (typeof chrome === "undefined") return;
  const isSidebar = mode === "sidebar";
  try {
    await chrome.action?.setPopup?.({ popup: isSidebar ? "" : "popup.html" });
  } catch {}
  try {
    await chrome.sidePanel?.setPanelBehavior?.({
      openPanelOnActionClick: isSidebar,
    });
  } catch {}
}

/** Persist the mode to storage AND apply the chrome config. */
export async function setUiMode(mode) {
  const next = mode === "sidebar" ? "sidebar" : "popup";
  // Start browser configuration and persistence before a sidebar can close.
  const applying = applyUiMode(next);
  try {
    await chrome.storage?.local?.set?.({ [UI_MODE_KEY]: next });
  } catch {}
  await applying;
  return next;
}

/** Call directly from the click handler: Firefox needs the user gesture
    before any storage or tab-query await. Chromium uses its sidePanel API. */
export async function openWalletSidebar() {
  if (chrome.sidebarAction?.open) return chrome.sidebarAction.open();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !chrome.sidePanel?.open) throw new Error("Sidebar unavailable");
  return chrome.sidePanel.open({ tabId: tab.id });
}
