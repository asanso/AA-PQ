/* ═══════════════════════════════════════════════════════════════════
   SubPageShell — full-page chrome for the dashboard sub-screens
   ───────────────────────────────────────────────────────────────────
   Design reference: Figma 42:39980 ("nicetry - networks/receive").

   The Network / Account / Settings / Receive screens used to be modal
   overlays (absolute inset-0 over the Dashboard). They are now real
   routes (/network, /accounts, /settings, /receive), each a full page
   that mirrors the Send page chrome: a vanity blue corner top-left and
   bottom-right, a fixed 72px header, and a scrollable body in between.

   Header layout (Figma 42:39984):
     [accent icon box]  [title + subtitle]            [back button]
       40×40, blue        type-heading-h2 +              40×40 square
       left accent        type-label-caption (muted)     border, chevron

   `onBack` is supplied by each page (typically `() => navigate("/dashboard")`).
   The body padding lives in each page's children so screens can choose
   their own rhythm.
   ═══════════════════════════════════════════════════════════════════ */

import { CornerTopLeft, CornerBottomRight } from "../../onboarding/OnboardingCorners.jsx";

function ChevronLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/* Section label with the brand-blue vertical tick (Figma 42:40023).
   Used to head a list ("SUPPORTED NETWORK", "ACCOUNTS", …). */
export function SectionLabel({ children, class: extra = "" }) {
  return (
    <div class={"w-full flex items-center gap-1.5 pt-4 pb-2 pl-1 " + extra}>
      <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
      <span class="type-label-special text-text-dim">{children}</span>
    </div>
  );
}

export function SubPageShell({ icon, title, subtitle, onBack, backDisabled, children, footer }) {
  return (
    <div class="flex flex-col items-stretch min-h-screen w-full">
      <div class="bg-bg-primary flex flex-col items-stretch flex-1 min-h-0 overflow-hidden text-text-primary">
        {/* Top-left blue corner triangle (Figma 42:39981) */}
        <CornerTopLeft />

        {/* Header — fixed 72px, separated from the body by a hairline */}
        <div class="w-full shrink-0 flex items-center gap-4 px-4 h-[72px] border-b border-border">
          <div class="size-10 shrink-0 relative flex items-center justify-center border-l-2 border-blue">
            <span class="absolute inset-0 bg-blue/20" />
            <span class="relative flex items-center justify-center text-blue-hover">
              {icon}
            </span>
          </div>
          <div class="flex-1 min-w-0 flex flex-col gap-1">
            <p class="type-heading-h2 text-text-primary truncate">{title}</p>
            {subtitle && (
              <p class="type-label-caption text-text-muted truncate">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onBack}
            disabled={backDisabled}
            aria-label="Back"
            class="size-10 shrink-0 border border-border bg-transparent flex items-center justify-center cursor-pointer text-text-primary hover:bg-bg-hover transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeftIcon />
          </button>
        </div>

        {/* Scrollable body — pages own their internal padding. `flex
            flex-col` lets a child use `flex-1` to fill/centre the whole
            body (e.g. a centered loading state); normal content children
            stay content-sized at the top. */}
        <div class="flex-1 min-h-0 overflow-y-auto flex flex-col">{children}</div>

        {/* Optional pinned footer (e.g. Cancel / Confirm actions),
            separated from the body by a hairline. */}
        {footer && (
          <div class="w-full shrink-0 border-t border-border px-4 py-4">
            {footer}
          </div>
        )}

        {/* Bottom-right blue corner triangle (Figma 42:40145 mirrored) */}
        <CornerBottomRight />
      </div>
    </div>
  );
}
