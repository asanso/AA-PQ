/* ═══════════════════════════════════════════════════════════════════
   OnboardingLayout — wrapper for every step screen
   ───────────────────────────────────────────────────────────────────
   Renders the step label + 4-segment progress bar at the top and the
   main card below. Step numbers match the mockups:
     1 → Set Password
     2 → Backup Seed
     3 → Choose Wallet Mode
     4 → Finalize

   Import flow reuses the same wrapper with its own step labels.

   Style this however you want — replace every class below. The JSX
   structure is what the other components depend on.
   ═══════════════════════════════════════════════════════════════════ */

export function OnboardingLayout({ step, totalSteps = 4, label, children }) {
  return (

      <div class="w-full max-w-md">
        {/* Progress header */}
        <div class="mb-6">
          <div class="flex items-center justify-between mb-2 text-xs uppercase tracking-wide text-text-secondary">
            <span>{label}</span>
            <span>Step {step} of {totalSteps}</span>
          </div>
          <div class="flex gap-2">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                class={
                  "h-1 flex-1 rounded " +
                  (i < step ? "bg-blue" : "bg-border")
                }
              />
            ))}
          </div>
        </div>

        {/* Main card */}
        <div class="bg-bg-card border border-border rounded-2xl p-8">
          {children}
        </div>
      </div>

  );
}
