/* ═══════════════════════════════════════════════════════════════════
   OnboardingHeader — shared logo + title + subtitle block
   ───────────────────────────────────────────────────────────────────
   Used by every onboarding step so the icon and title sit at exactly
   the same vertical position regardless of which screen renders.

   Design reference: Figma 154:2581 (main content container).
     - Icon area: 80×80, rounded full
     - Title:     Poppins Bold 25px, #292929
     - Subtitle:  Inter Regular 16px, #767676
     - Vertical gap (icon → title group, title → subtitle): 10px

   Props:
     - title    (string, required)  — Poppins Bold 25px line
     - subtitle (string, optional)  — Inter 16px line beneath title
     - icon     (node,   optional)  — overrides the default nicetry
                                       logo (e.g. FinalStep checkmark)
   ═══════════════════════════════════════════════════════════════════ */

export function OnboardingHeader({ title, subtitle, icon }) {
  return (
    <div class="w-full flex flex-col items-center gap-2.5 shrink-0">
      {icon ?? (
        <img
          src="/nicetry_logo_outline.svg"
          alt=""
          class="size-20 rounded-full shrink-0"
        />
      )}
      <div class="w-full flex flex-col items-center gap-2.5">
        <p class="font-['Poppins'] font-bold text-[25px] leading-[1.2] text-bg-primary text-center whitespace-nowrap">
          {title}
        </p>
        {subtitle && (
          <p class="w-full font-['Inter'] font-normal text-[16px] leading-[1.6] text-text-dim text-center">
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}
