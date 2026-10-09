/* This module is injected into every dApp page as a CLASSIC script
   (no type="module") because content-script.js creates a plain
   <script src=...> tag — module scripts would defer execution past
   the EIP-6963 discovery window and Lido / wagmi would never see us.
   That means we cannot use ES `import` here: any import statement is
   a SyntaxError under classic-script parsing and the provider never
   registers.

   Therefore DEFAULT_CHAIN_ID is duplicated as a literal below. Keep
   in sync with src/config/chain-defaults.js — both must hold the
   same value. The popup/onboarding/background bundles still pull
   the constant from chain-defaults.js so the wider app stays
   single-source-of-truth; this file is the only deliberate copy.

   IMPORTANT: this default is ONLY a placeholder for the few ms before
   the inpage hydrates the real chain from the background SW. The
   hydration runs immediately at install (see bottom of this file)
   and `eth_chainId` requests are proxied to the background so the
   dApp never observes the placeholder once the SW responds. Without
   this hydration a wallet onboarded on a non-default chain would tell
   every dApp it lives on the default chain, and dApps like Safe would
   loop asking the user to switch chain. */
/* IIFE wrapper — keeps ALL our top-level let/const out of any shared
   script scope. Chrome content scripts in `world: "MAIN"` ought to get
   their own Script Record, but in practice minified pages (Google
   Sheets, Docs, some video sites) inline classic scripts that also
   declare top-level `let e`, `let I`, `let t`, etc. The collision
   surfaces as `SyntaxError: Identifier 'e' has already been declared`
   and cascades into "X is not defined" for the page's own modules,
   breaking the SPA before it can boot. Wrapping everything below in an
   IIFE makes every identifier function-scoped, so nothing leaks into
   whatever scope Chrome ends up sharing with the page. */
(function () {
"use strict";

const DEFAULT_CHAIN_ID = "0xaa36a7"; // ← keep in sync with chain-defaults.js

const CHANNEL = "NICETRY_PROVIDER";
function pageOrigin() {
  return window.location.origin || "*";
}

let currentChainId = DEFAULT_CHAIN_ID;
let chainHydrated = false;
let accounts = [];
let connected = false;
let requestId = 0;

const pendingRequests = new Map();
const listeners = {};
let messageListenerInstalled = false;

/* ── Event emitter ── */

function on(event, handler) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(handler);
}

function emit(event, ...args) {
  if (listeners[event]) listeners[event].forEach((fn) => fn(...args));
}

/* ── RPC transport ── */

function sendToExtension(method, params) {
  /* Lazy-install the postMessage listener. On non-Web3 sites the dApp
     never calls request(), so we never install a global message listener
     that the page's own postMessage traffic would have to walk past. */
  ensureMessageListener();
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });

    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-extension",
        id,
        method,
        params: params || [],
      },
      pageOrigin()
    );

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Request timed out"));
      }
    }, 300_000);
  });
}

/* ── EIP-1193 request handler ── */

async function request({ method, params }) {
  switch (method) {
    case "eth_chainId": {
      /* Always proxy the first request to the background so an
         inpage that hasn't been told about a chainChanged yet
         (e.g. fresh page load after the user onboarded on a
         non-default chain) returns the real value. We update the
         local cache so the synchronous getter (`provider.chainId`)
         picks it up too. Cheap — the background just returns its
         in-memory `currentChainId`, no RPC. */
      try {
        const real = await sendToExtension("eth_chainId", []);
        if (typeof real === "string" && real.startsWith("0x")) {
          if (real.toLowerCase() !== currentChainId.toLowerCase()) {
            currentChainId = real;
            emit("chainChanged", currentChainId);
          }
          chainHydrated = true;
          return currentChainId;
        }
      } catch {
        /* background unreachable (extension reload mid-flight) — fall
           back to the local cache so the dApp doesn't get a hard error */
      }
      return currentChainId;
    }

    case "net_version": {
      try {
        const real = await sendToExtension("net_version", []);
        if (typeof real === "string") return real;
      } catch {}
      return String(parseInt(currentChainId, 16));
    }

    case "eth_accounts":
      return [...accounts];

    case "eth_requestAccounts": {
      if (accounts.length > 0) return [...accounts];
      const result = await sendToExtension("eth_requestAccounts", params);
      accounts = result || [];
      connected = accounts.length > 0;
      if (connected) emit("connect", { chainId: currentChainId });
      return accounts;
    }

    case "wallet_switchEthereumChain":
    case "wallet_addEthereumChain":
      return await sendToExtension(method, params);

    default:
      return sendToExtension(method, params);
  }
}

/* ── Message listener (installed lazily on first RPC) ── */

function handleProviderMessage(event) {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.direction !== "to-page") return;

  // Handle RPC responses
  if (data.id && pendingRequests.has(data.id)) {
    const { resolve, reject } = pendingRequests.get(data.id);
    pendingRequests.delete(data.id);
    if (data.error) reject(new Error(data.error.message || "Unknown error"));
    else resolve(data.result);
    return;
  }

  // Handle provider events
  if (data.event === "chainChanged") {
    currentChainId = data.data;
    emit("chainChanged", currentChainId);
  }
  if (data.event === "accountsChanged") {
    accounts = data.data || [];
    connected = accounts.length > 0;
    emit("accountsChanged", accounts);
  }
  if (data.event === "disconnect") {
    connected = false;
    accounts = [];
    emit("disconnect", { code: 4900, message: "Disconnected" });
  }
  if (data.event === "connect") {
    connected = true;
    currentChainId = data.data?.chainId || currentChainId;
    emit("connect", { chainId: currentChainId });
  }
}

function ensureMessageListener() {
  if (messageListenerInstalled) return;
  messageListenerInstalled = true;
  window.addEventListener("message", handleProviderMessage);
}

/* ── Provider object ── */

const provider = {
  isNiceTry: true,
  /* MetaMask spoof — re-introduced after the IIFE wrap fixed the real
     cause of page breakage (top-level identifier collisions). Legacy
     dApps that gate features on `window.ethereum?.isMetaMask` (older
     swap UIs, staking dashboards, some bridge frontends pre-EIP-6963)
     will now treat NiceTry as a MetaMask-compatible provider. Modern
     dApps continue to identify us via EIP-6963 `rdns:
     "com.nicetry.wallet"`, so the spoof costs us nothing there. */
  isMetaMask: true,
  _metamask: { isUnlocked: () => Promise.resolve(true) },

  get chainId() {
    return currentChainId;
  },
  get networkVersion() {
    return String(parseInt(currentChainId, 16));
  },
  get selectedAddress() {
    return accounts[0] || null;
  },

  isConnected: () => connected,
  request,

  enable: async () => request({ method: "eth_requestAccounts" }),

  send(methodOrPayload, paramsOrCallback) {
    if (typeof methodOrPayload === "string") {
      return request({ method: methodOrPayload, params: paramsOrCallback });
    }
    if (typeof paramsOrCallback !== "function") {
      return request({
        method: methodOrPayload.method,
        params: methodOrPayload.params,
      });
    }
    request({
      method: methodOrPayload.method,
      params: methodOrPayload.params,
    })
      .then((result) =>
        paramsOrCallback(null, {
          id: methodOrPayload.id,
          jsonrpc: "2.0",
          result,
        })
      )
      .catch((err) => paramsOrCallback(err));
  },

  sendAsync(payload, callback) {
    request({ method: payload.method, params: payload.params })
      .then((result) =>
        callback(null, { id: payload.id, jsonrpc: "2.0", result })
      )
      .catch((err) => callback(err));
  },

  on,
  addListener: on,

  removeListener(event, handler) {
    if (listeners[event])
      listeners[event] = listeners[event].filter((fn) => fn !== handler);
  },

  removeAllListeners(event) {
    if (event) listeners[event] = [];
    else Object.keys(listeners).forEach((e) => (listeners[e] = []));
  },
};

/* ── EIP-6963 provider announcement ── */

function announceProvider() {
  const info = {
    uuid: "d4e8f1a2-7b3c-4e5f-9a1d-6c8b2e3f4a5b",
    name: "NiceTry",
    /* Inline base64 of public/logo.svg — the cream-on-dark "ç" disc
       that doubles as the popup logo + favicon. dApps render this in
       wallet pickers (RainbowKit, ConnectKit, wagmi). The SVG embeds
       prefers-color-scheme so it auto-inverts on light backgrounds. */
    icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAiIGhlaWdodD0iODAiIHZpZXdCb3g9IjAgMCA4MCA4MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHN0eWxlPgogIC8qIERlZmF1bHQgPSBkYXJrIHRoZW1lOiBjcmVhbSBkaXNjICsgZGFyayBzeW1ib2wuCiAgICAgTGlnaHQgdGhlbWUgPSBuZWdhdGl2ZTogZGFyayBkaXNjICsgY3JlYW0gc3ltYm9sLgogICAgIEJyb3dzZXJzIChDaHJvbWUgODErLCBGaXJlZm94IDQxKywgU2FmYXJpIDE1KykgaG9ub3IgcHJlZmVycy1jb2xvci1zY2hlbWUKICAgICBpbnNpZGUgU1ZHIGZhdmljb25zLCBzbyB0aGUgc2FtZSBmaWxlIGludmVydHMgaXRzZWxmIGF1dG9tYXRpY2FsbHkuICovCiAgLm50LWJnIHsgZmlsbDogI0Y4RjZGNDsgfQogIC5udC1mZyB7IGZpbGw6ICMyOTI5Mjk7IH0KICAubnQtc3Ryb2tlIHsgc3Ryb2tlOiAjMjkyOTI5OyB9CiAgQG1lZGlhIChwcmVmZXJzLWNvbG9yLXNjaGVtZTogbGlnaHQpIHsKICAgIC5udC1iZyB7IGZpbGw6ICMyOTI5Mjk7IH0KICAgIC5udC1mZyB7IGZpbGw6ICNGOEY2RjQ7IH0KICAgIC5udC1zdHJva2UgeyBzdHJva2U6ICNGOEY2RjQ7IH0KICB9Cjwvc3R5bGU+CjxyZWN0IGNsYXNzPSJudC1iZyIgeD0iMS4wNzE0MyIgeT0iMS4wNzE0MyIgd2lkdGg9Ijc3Ljg1NzEiIGhlaWdodD0iNzcuODU3MSIgcng9IjM4LjkyODYiLz4KPHJlY3QgY2xhc3M9Im50LWJnIG50LXN0cm9rZSIgeD0iMS4wNzE0MyIgeT0iMS4wNzE0MyIgd2lkdGg9Ijc3Ljg1NzEiIGhlaWdodD0iNzcuODU3MSIgcng9IjM4LjkyODYiIHN0cm9rZS13aWR0aD0iMi4xNDI4NiIvPgo8ZyBjbGlwLXBhdGg9InVybCgjY2xpcDBfMTU0XzIzNzcpIj4KPHBhdGggY2xhc3M9Im50LWZnIiBkPSJNMjcuNjkzNyAyNy42NzYyQzMyLjQ2OTMgMjcuNjc2MiAzNi42MTA0IDMwLjM5MjkgMzguNjU1OCAzNC4zNjUzQzM4Ljc4MDQgMzQuNjA3MSAzOS4wMjYzIDM0Ljc2NTIgMzkuMjk4MyAzNC43NjUyQzM5LjY4NTkgMzQuNzY1MiA0MC4wMDAxIDM0LjQ1MSA0MC4wMDAxIDM0LjA2MzRWMTIuMzIwM0M0MC4wMDAxIDExLjgyNzIgMzkuNTk4NCAxMS40MjYgMzkuMTA1NSAxMS40NDE1QzIzLjgzODYgMTEuOTIxIDExLjQyODcgMjQuNjI0MyAxMS40Mjg3IDM5Ljk5ODlDMTEuNDI4NyA1NS4zNzM1IDIzLjgzODYgNjguMDc2OSAzOS4xMDU1IDY4LjU1NjNDMzkuNTk4NCA2OC41NzE4IDQwLjAwMDEgNjguMTcwNiA0MC4wMDAxIDY3LjY3NzVWNDUuOTM0NUM0MC4wMDAxIDQ1LjU0NjkgMzkuNjg1OSA0NS4yMzI3IDM5LjI5ODMgNDUuMjMyN0MzOS4wMjYzIDQ1LjIzMjcgMzguNzgwNCA0NS4zOTA3IDM4LjY1NTggNDUuNjMyNkMzNi42MTA0IDQ5LjYwNDkgMzIuNDY5MyA1Mi4zMjE3IDI3LjY5MzcgNTIuMzIxN0MyMC44ODgxIDUyLjMyMTcgMTUuMzcwOSA0Ni44MDQ1IDE1LjM3MDkgMzkuOTk4OUMxNS4zNzA5IDMzLjE5MzMgMjAuODg4MSAyNy42NzYyIDI3LjY5MzcgMjcuNjc2MloiLz4KPHBhdGggY2xhc3M9Im50LWZnIiBkPSJNNTQuNzcyNyAzOC4yMDNDNTQuNzU5OCAzOC4yMDI4IDU0Ljc0NzEgMzguMjAyOCA1NC43MzQxIDM4LjIwMjhIMzYuMTcwMkMzNS4zNjMgMzQuMjYwMiAzMS44NzQzIDMxLjI5NDQgMjcuNjkzMSAzMS4yOTQ0QzIyLjkxNDIgMzEuMjk0NCAxOS4wNCAzNS4xNjg2IDE5LjA0IDM5Ljk0NzVDMTkuMDQgNDQuNzI2MyAyMi45MTQyIDQ4LjYwMDUgMjcuNjkzMSA0OC42MDA1QzMxLjg3NDMgNDguNjAwNSAzNS4zNjMgNDUuNjM0OCAzNi4xNzAyIDQxLjY5MjFINTQuNzcyN1Y0MS42OTQ2QzU2LjcxMTIgNDEuNzE1MyA1OC4yNzYzIDQzLjI5MzIgNTguMjc2MyA0NS4yMzY1QzU4LjI3NjMgNDcuMTc5OSA1Ni42OTA0IDQ4Ljc3ODcgNTQuNzM0MSA0OC43Nzg3QzUyLjc3NzkgNDguNzc4NyA1MS4xOTIgNDcuMTkyOCA1MS4xOTIgNDUuMjM2NUg0Ny43MDA0QzQ3LjcwMDQgNDkuMDk1MSA1MC44NzU2IDUyLjI3MDIgNTQuNzM0MSA1Mi4yNzAyQzU4LjU5MjcgNTIuMjcwMiA2MS43Njc4IDQ5LjA5NTEgNjEuNzY3OCA0NS4yMzY1QzYxLjc2NzggNDEuMzc3OSA1OC42MTM5IDM4LjIyNCA1NC43NzI3IDM4LjIwM1pNMjkuNzIyNyAzOS45NDc1QzI5LjcyMjcgMzguODM1MiAyOC44MjEyIDM3LjkzMzcgMjcuNzA4OSAzNy45MzM3QzI2LjU5NjYgMzcuOTMzNyAyNS42OTUxIDM4LjgzNTIgMjUuNjk1MSAzOS45NDc1SDIyLjU2MDhDMjIuNTYwOCAzNy4xMjMzIDI0Ljg4NDggMzQuNzk5NCAyNy43MDg5IDM0Ljc5OTRDMzAuNTMzMSAzNC43OTk0IDMyLjg1NjggMzcuMTIzMyAzMi44NTY4IDM5Ljk0NzVIMjkuNzIyN1oiLz4KPC9nPgo8ZGVmcz4KPGNsaXBQYXRoIGlkPSJjbGlwMF8xNTRfMjM3NyI+CjxyZWN0IHdpZHRoPSI1Ny4xNDI5IiBoZWlnaHQ9IjU3LjE0MjkiIGZpbGw9IndoaXRlIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgxMS40Mjc3IDExLjQyODUpIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==",
    rdns: "com.nicetry.wallet",
  };

  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    })
  );
}

/* ── Install ──────────────────────────────────────────────────────
   Rabby-style accessor: we own `window.ethereum` via a get/set pair.
   - get(): always returns the NiceTry provider, so any code reading
     `window.ethereum` sees us, regardless of what loaded after.
   - set(v): silently accepts writes from later-loading wallets
     (MetaMask, Coinbase, …) and stashes them in `otherProviders` for
     diagnostics — but DOES NOT change what we return on the next read.
     The setter is a no-op for the global, so other wallets don't get
     a TypeError ("Cannot set property which has only a getter") that
     would otherwise pollute their console and trip their internal
     recovery paths. They believe they "won" and proceed; we remain the
     active `window.ethereum`.
   - Combined with EIP-6963 below, modern dApps still see every
     installed wallet in their picker — we don't hide MetaMask, we just
     don't let it overwrite the global slot. */

const otherProviders = [];

try {
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    get() {
      return provider;
    },
    set(v) {
      if (v && v !== provider && !otherProviders.includes(v)) {
        otherProviders.push(v);
      }
    },
  });
} catch {
  /* Some context already locked window.ethereum non-configurable —
     fall back to plain assignment. We at least try. */
  try {
    window.ethereum = provider;
  } catch {}
}

/* EIP-6963 announcement strategy (Rabby-style — keep NiceTry at the
   top of every wallet kit's discovery list):
   - Fire once immediately (most dApps subscribe before requesting).
   - Fire again on every `eip6963:requestProvider` so late subscribers
     also see us.
   - Fire on DOMContentLoaded and load — some kits (older wagmi forks,
     custom RainbowKit setups, Safe Apps SDK) only subscribe after
     these events.
   - Fire a couple of extra times in the first second to beat any
     wallet that loads after us and re-announces aggressively.
   These re-announcements are pure CustomEvent dispatches with no
   top-level identifier leakage, so they're safe on SPAs like Google
   Sheets (the previous breakage was caused by minified top-level
   `let`s, now contained inside the IIFE wrapper at the top of this
   file). */
announceProvider();
window.addEventListener("eip6963:requestProvider", () => announceProvider());
window.addEventListener("DOMContentLoaded", () => announceProvider());
window.addEventListener("load", () => announceProvider());
setTimeout(announceProvider, 100);
setTimeout(announceProvider, 500);
setTimeout(announceProvider, 1500);

window.dispatchEvent(new Event("ethereum#initialized"));

/* ── Hydrate chainId from background as soon as possible ──────────
   The synchronous getters `provider.chainId` / `provider.networkVersion`
   need to return the wallet's REAL chain (e.g. Arbitrum) — not the
   placeholder DEFAULT_CHAIN_ID — by the time a dApp first reads them.
   We can't make that call sync (the relay is postMessage-based), but
   firing it immediately at boot means the answer lands within a few ms
   — well before any dApp's first `.request()` or its `DOMContentLoaded`
   handler runs.

   The cost is one chrome.runtime message per page load. We accepted
   removing it earlier to be lighter on non-Web3 sites, but the
   trade-off broke Arbitrum / Base / Optimism users on dApps that read
   `provider.chainId` synchronously (they'd see Sepolia for an instant
   and the dApp would try to switch them). The IIFE wrap above already
   contains all our code, so this extra boot call no longer risks
   breaking anything — it's just one postMessage on the wire. */
(async () => {
  try {
    const real = await sendToExtension("eth_chainId", []);
    if (typeof real === "string" && real.startsWith("0x")) {
      if (real.toLowerCase() !== currentChainId.toLowerCase()) {
        currentChainId = real;
        emit("chainChanged", currentChainId);
      }
      chainHydrated = true;
    }
  } catch {
    /* background not ready yet (extension just reloaded) — the next
       eth_chainId proxy call will retry and update the cache. */
  }
})();

})();
