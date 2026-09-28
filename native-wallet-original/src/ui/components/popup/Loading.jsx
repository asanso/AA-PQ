/* ═══════════════════════════════════════════════════════════════════
   Loading — popup skeleton shown while bootstrap probes the vault
   ───────────────────────────────────────────────────────────────────
   The popup main does an async probe (vault exists? session valid?
   pending approval?) before deciding which real screen to render.
   Without this state the very first paint would default to Landing —
   the "no wallet set up yet" CTA — and flash for ~100ms while the
   probe resolves. That's confusing for users who already have a
   wallet, so this component takes that slot instead.

   Visual: same dark popup chrome (corners + bg) with a centered
   spinning logo. No copy on purpose; the wait is short and any text
   would just flicker.
   ═══════════════════════════════════════════════════════════════════ */

import { CornerTopLeft, CornerBottomRight } from "../onboarding/OnboardingCorners.jsx";

export function Loading() {
  return (
    <div class="relative bg-bg-primary flex flex-col items-stretch w-full min-h-screen text-text-primary">
      <CornerTopLeft />

      <div class="flex-1 flex items-center justify-center">
        <div class="bg-primary-50 rounded-full p-[6px] size-14 flex items-center justify-center">
          <img
            src="/nicetry_logo_outline.svg"
            alt=""
            class="size-full animate-spin"
            style={{ animationDuration: "1.6s" }}
          />
        </div>
      </div>

      <CornerBottomRight />
    </div>
  );
}
