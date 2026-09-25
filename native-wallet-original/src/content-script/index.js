/* IIFE wrapper — same defensive measure as inpage.js. Even though
   content scripts run in an ISOLATED world that can't collide with the
   page, wrapping protects against double-injection on iframes and any
   future case where bundling pulls a shared symbol into the same
   script. Costs nothing, prevents a class of nasty cross-page bugs. */
(function () {
"use strict";

const CHANNEL = "NICETRY_PROVIDER";

function pageOrigin() {
  return window.location.origin || "*";
}

/* In-page provider injection has moved to the manifest:
   `content_scripts` now declares inpage.js with `world: "MAIN"` and
   `run_at: "document_start"`. That gives us the earliest possible
   execution slot — before any dApp framework polls EIP-6963 — so
   NiceTry shows up first in wallet-discovery lists. We previously
   injected the script manually via document.createElement, but that's
   asynchronous and lost the race against MetaMask / Rabby on most
   pages. This file (which DOES need chrome.runtime) keeps running in
   the ISOLATED world for the page↔extension relay below. */

// Relay messages from page to extension
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.direction !== "to-extension")
    return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "PROVIDER_REQUEST",
      id: data.id,
      method: data.method,
      params: data.params,
      origin: window.location.origin,
    });

    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-page",
        id: data.id,
        result: response?.result,
        error: response?.error,
      },
      pageOrigin()
    );
  } catch (err) {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-page",
        id: data.id,
        error: { code: -32603, message: err.message || "Internal error" },
      },
      pageOrigin()
    );
  }
});

// Relay events from extension to page
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROVIDER_EVENT") {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-page",
        event: msg.event,
        data: msg.data,
      },
      pageOrigin()
    );
  }
});

})();
