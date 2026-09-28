/* ═══════════════════════════════════════════════════════════════════
   onboarding/main.jsx — full-tab setup flow entry point
   ───────────────────────────────────────────────────────────────────
   Opened by the background service worker on chrome.runtime.onInstalled
   (reason === "install") as a full browser tab. See background
   patch.onInstalled.md.

   Shared storage with the popup: chrome.storage.local holds the vault
   after createNewVault() / restoreVault() completes; the popup reads
   the same keys on next open, so the user can close this tab mid-flow
   and resume later via "Setup not completed → Reopen onboarding"
   (the popup detects hasVault() === false and shows that CTA).

   DEV MODE: see src/dev-mocks/index.js — the import below is a no-op
   in production builds.
   ═══════════════════════════════════════════════════════════════════ */

import "../dev-mocks";

import { render } from "preact";
import "@/ui/styles/theme.css";

import { hydrateChainId } from "@/ui/store.js";
import {
  hydrateCustomRpc,
  hydrateCustomChainNames,
} from "@/config/networks.js";
import { hydrateTheme } from "@/ui/theme.js";
import { App } from "./App.jsx";

function mount() {
  const el = document.querySelector("#app");
  if (!el) return;
  render(<App />, el);
}

/* Ensure globalThis.__NT_CHAIN_ID is set before any onboarding screen
   triggers blockchain code (notably the deploy step). */
hydrateChainId();

/* Seed the custom-RPC + custom-name mirrors so the deploy step honors a
   user override picked before onboarding completes. */
hydrateCustomRpc();
hydrateCustomChainNames();

/* Reconcile the stone/slate theme with chrome.storage (the inline
   pre-paint script already applied the localStorage mirror). */
hydrateTheme();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}