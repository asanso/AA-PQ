/* ═══════════════════════════════════════════════════════════════════
   dev-mocks/index.js — dev-only side-effect entry
   ───────────────────────────────────────────────────────────────────
   This module exists so main.jsx can have a single, unconditional
   `import "../dev-mocks"` that:
     - In DEV: runs the chrome.* mock installer
     - In PROD: is eliminated by Vite's tree-shaker because
       `import.meta.env.DEV` statically evaluates to false, so the
       entire body after the guard gets dropped.

   Why not put the DEV check inline in main.jsx?
     Top-level `if (DEV) await import(...)` works but relies on
     top-level-await in all build targets. Doing it this way keeps
     main.jsx synchronous and portable.
   ═══════════════════════════════════════════════════════════════════ */

if (import.meta.env.DEV) {
  // Lazy so the mock code itself is still in its own chunk and dead
  // code elimination is clean.
  await import("./chrome.js");
}