/* ═══════════════════════════════════════════════════════════════════
   theme.js — light/colour theme (stone ⇄ slate)
   ───────────────────────────────────────────────────────────────────
   The wallet ships two neutral skins built from the Figma colour
   library (see src/ui/styles/theme.css §3):

     - "stone"  warm grey  (DEFAULT — matches the historical look)
     - "slate"  cool blue-grey

   How it works: every NEUTRAL semantic token (bg-card, text-primary,
   border, …) resolves from `--nt-*` variables that are mapped per
   theme in theme.css under `html[data-theme="…"]`. Switching the theme
   is therefore a single attribute write on <html>; CSS does the rest,
   no re-render needed (though the `theme` signal lets components react
   if they want to, e.g. the Settings toggle).

   Persistence is dual:
     - chrome.storage.local["nt_theme"]  canonical, shared across the
       popup / sidebar / onboarding contexts (same as other prefs).
     - localStorage["nt_theme"]          synchronous mirror read by the
       tiny inline <script> in popup.html / onboarding.html BEFORE first
       paint, so a slate user never sees a stone flash on load.

   Call hydrateTheme() once at boot (popup/main.jsx, onboarding/main.jsx)
   and setTheme()/toggleTheme() from the Settings UI.
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";
import { storageGet, storageSet } from "@/utils/storage.js";

export const THEMES = ["stone", "slate"];
export const DEFAULT_THEME = "stone";
export const THEME_STORAGE_KEY = "nt_theme";

/* Reactive mirror of the active theme so components (the toggle) can
   read/subscribe. The CSS attribute on <html> is the real switch. */
export const theme = signal(DEFAULT_THEME);

function normalize(name) {
  return THEMES.includes(name) ? name : DEFAULT_THEME;
}

/* Apply a theme synchronously: write the <html> attribute, mirror to
   localStorage (for the pre-paint inline script next load) and update
   the signal. Does NOT touch chrome.storage — that's setTheme's job. */
export function applyTheme(name) {
  const t = normalize(name);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = t;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* private mode / storage disabled — non-fatal, chrome.storage is
       still the canonical store. */
  }
  theme.value = t;
  return t;
}

/* Boot-time hydration. Reads the synchronous localStorage mirror first
   (already applied pre-paint by the inline script, so this is usually a
   no-op confirmation), then falls back to chrome.storage for the very
   first load after install where localStorage is empty. */
export async function hydrateTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  if (!stored) stored = await storageGet(THEME_STORAGE_KEY);
  applyTheme(stored || DEFAULT_THEME);
}

/* Set + persist canonically. Use this from UI. */
export async function setTheme(name) {
  const t = applyTheme(name);
  await storageSet(THEME_STORAGE_KEY, t);
  return t;
}

/* Flip stone ⇄ slate and persist. */
export function toggleTheme() {
  return setTheme(theme.value === "slate" ? "stone" : "slate");
}
