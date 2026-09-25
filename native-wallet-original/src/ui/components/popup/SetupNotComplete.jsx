/* ═══════════════════════════════════════════════════════════════════
   SetupNotComplete — popup screen for incomplete onboarding
   ───────────────────────────────────────────────────────────────────
   Shown when the popup detects vault status === "empty" AND we know
   onboarding was started but never finished. In practice we don't
   distinguish between "never started" and "abandoned" today: both
   show this screen with a CTA to (re)open the onboarding tab.

   The button asks the background service worker to open
   onboarding.html in a new tab. This means we don't need to care
   whether an onboarding tab is already open somewhere; if it is,
   it'll be a duplicate, which is harmless. (To deduplicate properly
   we'd need to track tab IDs in the background — out of scope.)
   ═══════════════════════════════════════════════════════════════════ */

export function SetupNotComplete() {
  function reopen() {
    chrome.runtime.sendMessage({ type: "OPEN_ONBOARDING" }).catch(() => {
      // Fallback: if background doesn't have the handler yet, open
      // the tab directly. The popup's runtime context can do this.
      chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    });
    window.close();
  }

  return (
    <div class="p-6 text-center">
      <h2 class="text-lg font-bold mb-2">Setup not completed</h2>
      <p class="text-sm text-text-secondary mb-4">
        Finish creating your wallet to start using Nicetry.
      </p>
      <button
        onClick={reopen}
        class="w-full py-3 rounded-lg bg-blue hover:bg-blue-hover text-white font-semibold"
      >
        Open onboarding
      </button>
    </div>
  );
}
