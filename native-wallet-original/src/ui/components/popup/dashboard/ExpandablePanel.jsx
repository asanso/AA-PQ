/* ═══════════════════════════════════════════════════════════════════
   ExpandablePanel — collapsible Dashboard row (Figma 37:17147 / 37:17318)
   ───────────────────────────────────────────────────────────────────
   Icon tile + heading + chevron. The header inverts to a light surface
   while the panel is OPEN (matching the Ephemeral Key Tree in the
   mockup), giving a clear "this section is expanded" affordance.

   Kept dumb so Transactions and the Key Tree reuse it without
   duplicating the header layout.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";

function ChevronIcon({ open }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      class={"transition-transform " + (open ? "rotate-90" : "")}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function ExpandablePanel({ icon, label, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div class="w-full flex flex-col">
      <button
        onClick={() => setOpen(!open)}
        class={
          "w-full h-13 px-3 flex items-center gap-3 border-none cursor-pointer transition-colors duration-150 " +
          (open
            ? "bg-text-primary text-bg-primary"
            : "bg-bg-card text-text-primary hover:bg-bg-hover")
        }
      >
        {/* Square icon tile. Both the tile fill AND the (currentColor)
            glyph flip on open: dark tile + blue glyph when closed →
            blue tile + light glyph when open (Figma 37:17149 / 37:17319). */}
        <span
          class={
            "size-8 shrink-0 flex items-center justify-center transition-colors duration-150 " +
            (open ? "bg-blue text-text-primary" : "bg-bg-primary text-blue-hover")
          }
        >
          {icon}
        </span>
        <span class="flex-1 min-w-0 text-left type-heading-h3">{label}</span>
        <ChevronIcon open={open} />
      </button>
      {/* Open content frame (Figma 181:4342): 16px inner gutter, 24px
          bottom spacing, hairline border around the section (the header
          caps the top edge). */}
      {open && (
        <div class="w-full px-4 pb-6 border-l border-r border-b border-border">
          {children}
        </div>
      )}
    </div>
  );
}
