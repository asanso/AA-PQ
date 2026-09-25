/* ════
═══════════════════════════════════════════════════════════════
   Welcome — first onboarding screen (mockup 1)
   ───────────────────────────────────────────────────────────────────
   Entry point. Two CTAs:
     - Create new wallet  → /create/password
     - Import existing    → /import/seed

   Sets the flow branch so subsequent screens know which path the user
   chose (affects which "done" screen to show, which "back" button
   goes where, etc.).
   ═══════════════════════════════════════════════════════════════════ */

import { useLocation } from "wouter-preact";
import { useOnboardingFlow } from "@/ui/hooks/useOnboardingFlow.js";
import { OnboardingHeader } from "./OnboardingHeader.jsx";
import { CornerTopLeft, CornerBottomRight } from "./OnboardingCorners.jsx";

export function Welcome() {
  const [, navigate] = useLocation();
  const flow = useOnboardingFlow();

  function goCreate() {
    flow.branch = "create";
    navigate("/create/password");
  }

  function goImport() {
    flow.branch = "import";
    navigate("/import/seed");
  }

  return (
    <div class="h-full w-full flex flex-col gap-6 font-['Poppins',sans-serif]">
      {/* Topbar: header labels + step progress bar (Figma 154:2284) */}
      <div class="flex flex-col gap-2.5 w-full overflow-hidden">
        <div class="flex items-start justify-between w-full font-semibold text-[13px] leading-[1.2] uppercase text-text-muted tracking-[0.52px] whitespace-nowrap">
          <p>Welcome to Nicetry</p>
          <p>Quantum-Safe Wallet</p>
        </div>
        <div class="flex w-full">
          <div class="flex-1 h-2 flex items-end justify-center">
            <div class="h-[2px] w-full bg-blue" />
          </div>
        </div>
      </div>

      {/* Vanity wrapper (Figma 154:2291) */}
      <div
        class="relative flex flex-1 flex-col items-end justify-end w-full bg-stone-100 overflow-hidden"

      >
        {/* Top-left blue corner (Figma 154:2578) */}
        <CornerTopLeft />

        <img
            src="/gridCard.png"
            alt=""
            class="pointer-events-none select-none absolute left-0 top-0 object-cover "
          />
        {/* Main container (Figma 154:2375) */}
        <div class="relative flex flex-1 flex-col items-center justify-between px-10 py-5 overflow-hidden">
          {/* nicetry watermark (Figma 154:2403) */}
          <img
            src="/NiceTryBig.svg"
            alt=""
            class="pointer-events-none select-none absolute left-[1.9%] top-1/2 -translate-y-1/2 opacity-50"
          />

          {/* Logo + titles (Figma 154:2376) */}
          <div class="relative z-10 flex flex-col items-center gap-2.5 w-full">
            <img src="/nicetry_logo_outline.svg" alt="" class="size-20" />
            <div class="flex flex-col items-center gap-2.5 w-full">
              <p class="font-bold text-[61px] leading-[1.2] text-bg-primary text-center whitespace-nowrap">
                nicetry
              </p>
              <p class="font-medium text-[20px] leading-[1.2] text-text-dim text-center whitespace-nowrap">
                Quantum-Safe Wallet
              </p>
            </div>
          </div>

          {/* Buttons (Figma 154:2396) */}
          <div class="relative z-10 flex flex-1 flex-col items-center justify-end gap-2.5 w-full">
            {/* Primary CTA — default / hover (216:2085) / disabled (216:2089) */}
            <div class="w-full border-[2px] border-blue p-[6px] transition-colors duration-150 has-[button:hover:not(:disabled)]:border-blue-hover has-[:disabled]:opacity-50">
              <button
                type="button"
                onClick={goCreate}
                class="w-full bg-blue py-4 px-12 text-text-primary font-bold text-[16px] uppercase tracking-[0.48px] cursor-pointer  transition-colors duration-150 hover:bg-primary-600 disabled:hover:bg-blue disabled:cursor-not-allowed"
              >
                Create New Wallet
              </button>
            </div>
            {/* Secondary CTA */}
            <div class="w-full p-1.5 transition-colors duration-150 has-[button:hover:not(:disabled)]:opacity-80">
              <button
                type="button"
                onClick={goImport}
                class="w-full border-2 border-bg-primary px-12 py-4 bg-transparent text-bg-primary font-bold text-[16px] leading-[1.2] uppercase tracking-[0.48px] whitespace-nowrap cursor-pointer transition-colors duration-150 hover:bg-bg-primary hover:text-text-primary"
              >
                Import Existing Wallet
              </button>
            </div>
          </div>
        </div>

        {/* Bottom-right blue corner (Figma 154:2629) */}
        <CornerBottomRight />
      </div>
    </div>
  );
}
