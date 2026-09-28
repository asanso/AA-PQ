/* ═══════════════════════════════════════════════════════════════════
   FinalStep — final step (create 3/3, import 4/4)
   ───────────────────────────────────────────────────────────────────
   Shown after the wallet has been set up. Two CTAs in the mockup:
     - "Pin for Quick Access" card instructing the user to pin the
       extension in Chrome's toolbar
     - "Open wallet" button → closes tab, extension is now fully set up

   On click of "Open wallet":
     1. Zero out the flow state (password, phrase) from memory
     2. Close this tab

   The popup auto-unlocks next time the user clicks the extension icon
   because we stash the derived session key so the popup skips the
   unlock screen on first open. (See session.js.)
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { storeSessionKey } from "@/popup/session.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";

/* Step count depends on branch: create is 3 steps (password → seed →
   done), import is 4. */
function CardShell({ totalSteps, children }) {
  const step = totalSteps;
  return (
    <div class="w-full h-full flex flex-col gap-6">
      {/* Topbar: label + step counter + progress bars (all filled) */}
      <div class="w-full flex flex-col gap-2.5 overflow-hidden">
        <div class="w-full flex items-start justify-between font-['Poppins'] font-semibold text-[13px] leading-[1.2] text-text-muted uppercase tracking-[0.52px] whitespace-nowrap">
          <p>Finalize</p>
          <p>Step {step} of {totalSteps}</p>
        </div>
        <div class="w-full flex gap-4">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              class={
                "flex-1 h-2 rounded-full " +
                (i < 2 ? "bg-blue" : "bg-primary-600")
              }
            />
          ))}
        </div>
      </div>

      {/* Vanity wrapper with blue corner triangles (Figma 154:2578 / 154:2629) */}
      <div class="flex-1 bg-stone-100 flex flex-col w-full min-h-0 overflow-hidden">
        <CornerTopLeft />
        <div class="flex-1 w-full flex flex-col items-center justify-between px-10 py-5 min-h-0 gap-5">
          {children}
        </div>
        <CornerBottomRight />
      </div>
    </div>
  );
}

function CheckCircleIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46" fill="none">
<path d="M41.5262 19.0479C42.3961 23.3171 41.7761 27.7554 39.7697 31.6228C37.7633 35.4901 34.4917 38.5528 30.5005 40.3C26.5093 42.0471 22.0398 42.3732 17.8372 41.2239C13.6347 40.0745 9.95321 37.5192 7.40671 33.984C4.8602 30.4488 3.60261 26.1474 3.84364 21.7972C4.08467 17.447 5.80976 13.311 8.73123 10.0787C11.6527 6.84651 15.594 4.71351 19.8977 4.03546C24.2015 3.35741 28.6077 4.17528 32.3814 6.35269" stroke="var(--color-blue)" stroke-width="4.7619" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M17.1436 20.9528L22.8578 26.6671L41.9055 7.61951" stroke="var(--color-blue)" stroke-width="4.7619" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

function PinIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-text-primary)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z" />
    </svg>
  );
}

export function FinalStep() {
  const flow = useOnboardingFlow();
  // create branch is 3 steps (password → seed → done); import is 4.
  const totalSteps = flow.branch === "import" ? 4 : 3;
  // Falls back to an inline "click the puzzle icon" panel when
  // chrome.action.openPopup() can't pop the popup itself — e.g. the
  // extension hasn't been pinned to the toolbar (the most common cause)
  // or the running Chrome rejects programmatic opens. Without this the
  // user clicks "Open wallet" and nothing visible happens.
  const [needsManualOpen, setNeedsManualOpen] = useState(false);

  /* ── Lock the user on this step ──────────────────────────────────
     The vault has already been committed to storage in ShowSeed's
     finalize(); going back here would let the user re-enter a completed
     flow. We snap any hash
     change (browser back / forward / URL edit) back to /create/done so
     the only forward path is the "Open wallet" button below. */
  useEffect(() => {
    // Replace the current entry too, so the immediate previous history
    // entry isn't a stale onboarding step.
    if (window.location.hash !== "#/create/done") {
      window.history.replaceState(null, "", "#/create/done");
    }
    const lock = () => {
      if (window.location.hash !== "#/create/done") {
        window.location.hash = "/create/done";
      }
    };
    window.addEventListener("hashchange", lock);
    window.addEventListener("popstate", lock);
    return () => {
      window.removeEventListener("hashchange", lock);
      window.removeEventListener("popstate", lock);
    };
  }, []);

  function complete() {
    // Auto-unlock next popup open: store the derived session key (the
    // vault was persisted in ShowSeed's finalize(), which derives it)
    // before wiping the flow state. Session storage is cleared on
    // browser close or manual lock.
    const keyBytes = vaultManager.getSessionKeyBytes();
    if (keyBytes) storeSessionKey(keyBytes);

    // Zero out password + phrase from memory.
    flow.reset();

    /* chrome.action.openPopup() requires the action icon to be visible
       (pinned in toolbar OR the overflow puzzle menu open) and is
       missing on older Chrome. When it fails we don't close this tab —
       otherwise the click results in "nothing happened". Instead we
       swap the screen to a clear "click the puzzle icon" panel. */
    let resolved = false;
    const showFallback = () => {
      if (resolved) return;
      resolved = true;
      setNeedsManualOpen(true);
    };

    try {
      const p = chrome?.action?.openPopup?.();
      if (p && typeof p.then === "function") {
        p.then(
          () => {
            resolved = true;
          },
          (e) => {
            console.warn("[NiceTry] openPopup failed:", e);
            showFallback();
          },
        );
      } else if (!chrome?.action?.openPopup) {
        showFallback();
      }
    } catch (e) {
      console.warn("[NiceTry] openPopup threw:", e);
      showFallback();
    }

    // Belt-and-suspenders: if neither the resolve nor the reject path
    // ran within a short window (some Chromes silently no-op), show
    // the manual-open panel so the user is never left staring at the
    // onboarding tab wondering what happened.
    setTimeout(() => {
      if (!resolved) showFallback();
    }, 400);
  }

  return (
    <CardShell totalSteps={totalSteps}>
      {/* Header: success icon override + title + subtitle (shared) */}
      <OnboardingHeader
        title={needsManualOpen ? "Almost there!" : "Final Step!"}
        subtitle={
          needsManualOpen
            ? "Click the puzzle icon in your browser toolbar, then click NiceTry Wallet to open it."
            : "Your Daisugi development wallet is ready."
        }
        icon={
          <div class="size-20 rounded-full bg-blue/40 flex items-center justify-center shrink-0">
            <CheckCircleIcon />
          </div>
        }
      />

      {/* Pin-for-access dark card */}
      <div class="w-full bg-bg-primary border border-bg-primary/20 flex flex-col gap-5 p-5">
        <div class="w-full flex gap-3 items-center">
          <div class="size-8 rounded-[10.667px] bg-blue/40 flex items-center justify-center shrink-0">
            <PinIcon />
          </div>
          <p class="font-['Poppins'] font-bold text-[16px] leading-[1.6] text-text-primary whitespace-nowrap">
            Pin for Quick Access
          </p>
        </div>
        <p class="w-full font-['Poppins'] text-[16px] leading-[1.6] text-text-muted">
          {needsManualOpen
            ? "Pinning the wallet lets future clicks open it instantly. Right-click the icon in the puzzle menu and choose Pin."
            : "Click the puzzle icon in your browser toolbar and pin NiceTry Wallet"}
        </p>
      </div>

      {/* CTA — hidden once we've shown the manual-open instructions */}
      {!needsManualOpen && (
        <div class="w-full border-2 border-blue p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
          <button
            type="button"
            onClick={complete}
            class="w-full bg-blue flex items-center justify-center px-12 py-4 font-['Poppins'] font-bold text-[16px] leading-[1.2] text-text-primary uppercase tracking-[0.48px] border-none cursor-pointer transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
          >
            Open wallet
          </button>
        </div>
      )}
    </CardShell>
  );
}
