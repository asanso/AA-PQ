/* ═══════════════════════════════════════════════════════════════════
   dev-mocks/chrome.js — mock chrome.* APIs for `npm run dev`
   ───────────────────────────────────────────────────────────────────
   Purpose:
     When you serve popup.html / onboarding.html via Vite's dev server
     (http://localhost:5173/popup.html), the `chrome` global doesn't
     exist. Every `chrome.storage.local.get(...)` or
     `chrome.runtime.sendMessage(...)` throws and kills the page.

     This file provides a minimal shim so the app renders and you can
     iterate on Tailwind / JSX / component structure with HMR, without
     ever building.

   How it's wired:
     - src/popup/main.jsx imports "../dev-mocks/chrome.js" guarded by
       `if (import.meta.env.DEV)`. Vite tree-shakes the import out of
       production builds, so the mock NEVER ships in the real
       extension.
     - When the file is imported, it detects missing `chrome.*` and
       installs the shim on window.chrome before anything else runs.
     - If `chrome` already exists (i.e. you accidentally loaded the
       built extension), the mock bails out silently.

   What's backed by real browser storage (so state survives reloads):
     - chrome.storage.local  → window.localStorage
     - chrome.storage.session → window.sessionStorage
     - chrome.storage.sync   → window.localStorage (same backing)

   What's a no-op with console logs:
     - chrome.runtime.sendMessage / onMessage
     - chrome.runtime.onInstalled
     - chrome.action.setBadge*
     - chrome.sidePanel.open / setOptions / setPanelBehavior
     - chrome.tabs.create / query / sendMessage
     - chrome.windows.getCurrent / create

   Real on-chain sends WON'T work in dev because the rotation modules
   call `chrome.runtime.sendMessage({ type: "SESSION_ACTIVITY" })` but
   more importantly hit real RPC endpoints and the bundler (these DO
   work even in dev if your fetch() CORS settings allow it; the popup
   mock only fakes the `chrome` global).

   ENV REQUIRED: this file assumes a window/DOM environment. It's
   imported only from popup/main.jsx and onboarding/main.jsx which
   both run in the browser.
   ═══════════════════════════════════════════════════════════════════ */

/* Detect a "real" chrome extension API by presence of runtime.id
   (set only in extension contexts) or runtime.onMessage (set by real
   extension pages and service workers).

   Chrome desktop exposes a minimal `window.chrome` object on every
   http(s) page — it has a `runtime` stub but without `onMessage`,
   `sendMessage`, or `storage`. Simply checking `!window.chrome` or
   `!window.chrome?.runtime` is NOT enough: the check passes, the mock
   bails, and then the app crashes the moment it touches
   `chrome.runtime.onMessage.addListener` because the stub doesn't
   have it.

   Correct check: the mock bails only if the real extension API is
   fully present (has both onMessage AND storage). Otherwise we
   install. */
const hasRealExtensionApi =
  typeof window !== "undefined" &&
  window.chrome?.runtime?.onMessage?.addListener &&
  window.chrome?.storage?.local?.get;

if (typeof window !== "undefined" && !hasRealExtensionApi) {
  console.info(
    "%c[NiceTry dev] installing chrome.* mock",
    "color:#3F56E3;font-weight:bold"
  );

  const STORAGE_PREFIX = "__nt_devmock__";

  /* ── Storage shim ─────────────────────────────────────────────
     MV3 storage APIs accept either callback OR promise style. We
     return promises; callbacks, if passed, are invoked after
     resolution so the legacy callback-style call sites in the app
     keep working unchanged. */
  function makeStorageArea(backingStore, name) {
    const read = (key) => {
      try {
        const raw = backingStore.getItem(STORAGE_PREFIX + key);
        return raw == null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    };
    const write = (key, val) => {
      try {
        backingStore.setItem(STORAGE_PREFIX + key, JSON.stringify(val));
      } catch (e) {
        console.warn(`[NiceTry dev] ${name}.set failed`, e);
      }
    };
    const remove = (key) => backingStore.removeItem(STORAGE_PREFIX + key);

    return {
      get(keysOrCb, cb) {
        const keys = Array.isArray(keysOrCb)
          ? keysOrCb
          : typeof keysOrCb === "string"
            ? [keysOrCb]
            : keysOrCb && typeof keysOrCb === "object"
              ? Object.keys(keysOrCb)
              : null;
        const callback = typeof keysOrCb === "function" ? keysOrCb : cb;

        const result = {};
        if (keys === null) {
          // null/undefined → return everything in our prefix
          for (let i = 0; i < backingStore.length; i++) {
            const fullKey = backingStore.key(i);
            if (fullKey?.startsWith(STORAGE_PREFIX)) {
              const k = fullKey.slice(STORAGE_PREFIX.length);
              result[k] = read(k);
            }
          }
        } else {
          for (const k of keys) {
            const v = read(k);
            if (v !== undefined) result[k] = v;
          }
        }

        const p = Promise.resolve(result);
        if (callback) p.then(callback);
        return p;
      },
      set(obj, cb) {
        for (const [k, v] of Object.entries(obj || {})) write(k, v);
        const p = Promise.resolve();
        if (cb) p.then(cb);
        return p;
      },
      remove(keys, cb) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) remove(k);
        const p = Promise.resolve();
        if (cb) p.then(cb);
        return p;
      },
      clear(cb) {
        // Only clear our prefix — preserve dev tools' localStorage
        const toRemove = [];
        for (let i = 0; i < backingStore.length; i++) {
          const k = backingStore.key(i);
          if (k?.startsWith(STORAGE_PREFIX)) toRemove.push(k);
        }
        for (const k of toRemove) backingStore.removeItem(k);
        const p = Promise.resolve();
        if (cb) p.then(cb);
        return p;
      },
    };
  }

  /* ── Runtime shim ─────────────────────────────────────────────
     sendMessage is a no-op that logs and immediately invokes the
     callback with `null` (matching the "no receiver" behavior).
     onMessage.addListener just records the listener so code that
     expects `.addListener(...)` to exist doesn't throw. */
  const messageListeners = [];
  const installedListeners = [];

  const runtime = {
    id: "nice-try-dev-mock",
    sendMessage(...args) {
      // Signature variations:
      //   sendMessage(msg)
      //   sendMessage(msg, callback)
      //   sendMessage(extId, msg)
      //   sendMessage(extId, msg, callback)
      let msg, callback;
      if (typeof args[0] === "string") {
        msg = args[1];
        callback = args[2];
      } else {
        msg = args[0];
        callback = args[1];
      }
      console.debug("[NiceTry dev] chrome.runtime.sendMessage", msg);
      const p = Promise.resolve(null);
      if (callback) p.then(callback);
      return p;
    },
    onMessage: {
      addListener(fn) { messageListeners.push(fn); },
      removeListener(fn) {
        const i = messageListeners.indexOf(fn);
        if (i >= 0) messageListeners.splice(i, 1);
      },
      hasListener(fn) { return messageListeners.includes(fn); },
    },
    onInstalled: {
      addListener(fn) { installedListeners.push(fn); },
      removeListener(fn) {
        const i = installedListeners.indexOf(fn);
        if (i >= 0) installedListeners.splice(i, 1);
      },
    },
    getURL(path) {
      // In a real extension this returns chrome-extension://<id>/<path>.
      // In dev we return the dev server URL so `tabs.create({url: getURL(...)})`
      // opens the right local page.
      return new URL(path.startsWith("/") ? path : "/" + path, window.location.origin).href;
    },
    onConnect: { addListener() {}, removeListener() {} },
    lastError: undefined,
  };

  /* ── Tabs shim ────────────────────────────────────────────────
     In the real extension, `chrome.tabs.create({ url })` opens a
     new browser tab. In dev we instead navigate the CURRENT tab
     because:
       - `window.open` is often blocked by the popup blocker
       - Even when it works, the opening script can't later
         `window.close()` a tab the browser opened for the user,
         which triggers "Scripts may close only the windows opened
         by them" warnings and leaves stale tabs around.
     Navigating in-place keeps the dev experience smooth: click
     "Start setup" → the same tab flips to onboarding.html. */
  const tabs = {
    create({ url } = {}) {
      if (url) window.location.href = url;
      return Promise.resolve({ id: 1, url });
    },
    query() { return Promise.resolve([{ id: 1, active: true, url: window.location.href }]); },
    sendMessage() { return Promise.resolve(null); },
  };

  /* ── Windows shim ─────────────────────────────────────────────
     Used by the approval popup flow (background opens popup in a
     detached window). In dev we just open a new tab. */
  const windows = {
    getCurrent() {
      return Promise.resolve({ id: 1, left: 0, top: 0, width: 1280, height: 800 });
    },
    create({ url } = {}) {
      if (url) window.open(url, "_blank");
      return Promise.resolve({ id: 2, tabs: [{ id: 99, url }] });
    },
  };

  /* ── Action / sidePanel shim ─────────────────────────────────
     No-op: these affect the toolbar icon and side panel, neither
     of which exists in dev. */
  const action = {
    setBadgeBackgroundColor() {},
    setBadgeText() {},
    setIcon() {},
    setTitle() {},
    openPopup() {
      console.debug("[NiceTry dev] action.openPopup() ignored in dev mode");
      return Promise.resolve();
    },
  };

  const sidePanel = {
    open() { return Promise.resolve(); },
    setOptions() { return Promise.resolve(); },
    setPanelBehavior() { return Promise.resolve(); },
  };

  /* ── Install the shim ────────────────────────────────────────
     In real extension contexts `window.chrome` is a complete object
     set by the browser. On a plain http://localhost page Chrome still
     exposes a minimal `window.chrome` (used for webstore-related
     APIs) which is NOT extendable by simple reassignment in some
     versions — setting `window.chrome = {...}` silently fails.

     Safer: define each property on the existing object, creating a
     fresh writable one if it was missing. We set `configurable: true`
     so HMR reloads can replace the shim without throwing. */
  const existing = window.chrome || {};

  const mockApi = {
    runtime,
    storage: {
      local:   makeStorageArea(window.localStorage,   "storage.local"),
      session: makeStorageArea(window.sessionStorage, "storage.session"),
      sync:    makeStorageArea(window.localStorage,   "storage.sync"),
    },
    tabs,
    windows,
    action,
    sidePanel,
  };

  try {
    // Attempt direct reassignment first — works on most pages.
    window.chrome = { ...existing, ...mockApi };
  } catch {
    // Fallback: defineProperty each piece. Handles read-only window.chrome.
    for (const [key, value] of Object.entries(mockApi)) {
      try {
        Object.defineProperty(window.chrome, key, {
          value,
          writable: true,
          configurable: true,
        });
      } catch (e) {
        console.warn(`[NiceTry dev] failed to install chrome.${key}:`, e);
      }
    }
  }

  // Sanity check — if the install didn't take, log loudly so the
  // user doesn't stare at a blank screen wondering.
  if (!window.chrome?.runtime?.onMessage?.addListener) {
    console.error(
      "[NiceTry dev] chrome.* mock install FAILED — " +
      "window.chrome is read-only on this page. " +
      "Try running the dev server with HTTPS or use `npm run watch` instead."
    );
  }

  /* ── Silence window.close() ───────────────────────────────────
     Several components call window.close() at the end of their flow
     (Landing after "Start setup", FinalStep after "Complete and Open
     Wallet", SettingsMenu.lockWallet, etc.). In the real extension
     this closes the popup window, which is exactly the right UX. In
     dev the browser refuses — "Scripts may only close windows that
     were opened by them" — and logs a warning for each attempt.

     Shim it to a no-op in dev so the console stays clean. The visible
     navigation (caused by the preceding tabs.create or route change)
     still happens. */
  const _origClose = window.close.bind(window);
  window.close = function devClose() {
    console.debug("[NiceTry dev] window.close() ignored in dev mode");
  };
  // Expose the original on window so you can force-close if needed.
  window.__realClose = _origClose;
}

/* ═══════════════════════════════════════════════════════════════════
   DEV UTILITY: reset everything
   ───────────────────────────────────────────────────────────────────
   Paste in devtools console to wipe the mock storage and reload:

     localStorage.clear(); sessionStorage.clear(); location.reload();

   Or more surgical — only mock-prefixed keys:

     Object.keys(localStorage).filter(k => k.startsWith("__nt_devmock__"))
       .forEach(k => localStorage.removeItem(k));
     location.reload();
   ═══════════════════════════════════════════════════════════════════ */