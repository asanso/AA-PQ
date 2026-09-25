/* ═══════════════════════════════════════════════════════════════════
   Landing — popup screen shown when no vault exists yet
   ───────────────────────────────────────────────────────────────────
   In the normal install flow the onboarding tab opens automatically
   via chrome.runtime.onInstalled. But if the user closed that tab
   before completing setup, clicking the extension icon opens the
   popup on this screen. The CTA re-opens the onboarding tab.

   Mirrors SetupNotComplete but without implying the flow was started.
   You can merge the two later if you prefer a single empty-vault
   screen.
   ═══════════════════════════════════════════════════════════════════ */

export function Landing() {
  function openOnboarding() {
    chrome.runtime.sendMessage({ type: "OPEN_ONBOARDING" }).catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    });
    window.close();
  }

  return (
    <div class="min-h-screen flex flex-col items-center justify-center p-6 text-center">
      <div class="text-4xl font-bold mb-2">nicetry</div>
      <div class="text-sm text-text-secondary mb-6">
        Quantum-Safe Wallet
      </div>

      <p class="text-sm text-text-secondary mb-6 max-w-xs">
        No wallet set up yet. Let's create one or import an existing
        seed phrase.
      </p>

      <button
        onClick={openOnboarding}
        class="w-full max-w-xs py-3 rounded-lg bg-blue hover:bg-blue-hover text-white font-semibold"
      >
        Start setup
      </button>
    </div>
  );
}