/* ═══════════════════════════════════════════════════════════════════
   OnboardingBack — shared "go back" arrow for the whole setup flow
   ───────────────────────────────────────────────────────────────────
   Design reference: Figma 536:2173 — the `oui:return-key` arrow icon
   (node 536:2182) that sits OUTSIDE the bordered card, flush to its
   top-right corner. It replaces the per-screen in-card "Back" button:
   inside the rectangle the control didn't fit the layout, so it lives
   in the margin to the right of the card instead.

   Self-contained: reads the current hash route itself (one hashchange
   listener) so it can be mounted as a sibling of the card frame in
   onboarding/App.jsx — i.e. OUTSIDE the frame's overflow-hidden box,
   which is what lets it render past the card's right edge.

   Visible only on the data-entry steps. Hidden on:
     - "/"               Welcome     (nothing to go back to)
     - "/create/done"    FinalStep   (terminal success screen)
     - "/import/scanning" ImportScanning (deploy in progress — its own
                          error state offers a contextual back instead)
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";

/* Where "back" goes from each step. A route absent here renders no arrow. */
const BACK_TARGET = {
  "/create/password": "/",
  "/create/seed": "/create/password",
  "/import/seed": "/",
  "/import/password": "/import/seed",
};

/* oui:return-key — arrow curving back to the left (16-grid, drawn at 32px). */
function ReturnKeyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 16 16" fill="none">
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M5.854 4.146a.5.5 0 0 1 0 .708L3.207 7.5H10.5A2.5 2.5 0 0 0 13 5V3.5a.5.5 0 0 1 1 0V5a3.5 3.5 0 0 1-3.5 3.5H3.207l2.646 2.646a.5.5 0 0 1-.707.708l-3.5-3.5a.5.5 0 0 1 0-.708l3.5-3.5a.5.5 0 0 1 .708 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function OnboardingBack() {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [loc, setLoc] = useState(read());

  useEffect(() => {
    const h = () => setLoc(read());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const target = BACK_TARGET[loc];
  if (!target) return null;

  return (
    <button
      type="button"
      aria-label="Back"
      title="Back"
      onClick={() => {
        window.location.hash = target;
      }}
      class="absolute top-0 -right-12 z-20 flex items-center justify-center size-8 bg-transparent border-none cursor-pointer text-text-primary/60 hover:text-text-primary transition-colors duration-150"
    >
      <ReturnKeyIcon />
    </button>
  );
}
