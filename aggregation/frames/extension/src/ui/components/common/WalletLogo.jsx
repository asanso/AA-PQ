/* ═══════════════════════════════════════════════════════════════════
   WalletLogo — single source of truth for the NiceTry round logo
   ───────────────────────────────────────────────────────────────────
   Mirrors figma 154:585 (`nicetry_logo_outline`). The logo SVG already
   contains its own off-white circle + dark border + symbol; this
   component only adds the outer light-lavender ring (#f0f3fe) shown
   in the popup mockups.

   The logo image is rendered at the FULL outer size — no inner empty
   padding ring — so the dark blue body of the logo nearly touches the
   circle edge, with just a very thin ring of #f0f3fe visible. This is
   the look expected by the dashboard header and the dApp approval
   screens.

   Usage:
     <WalletLogo size={42.667} />     // popup header default
     <WalletLogo size={80} />          // big hero variant
     <WalletLogo size={72} ringed={false} />   // SVG only, no outer ring
   ═══════════════════════════════════════════════════════════════════ */

export function WalletLogo({ size = 42.667, ringed = true, className = "" }) {
  if (!ringed) {
    return (
      <img
        src="/nicetry_logo_outline.svg"
        alt=""
        class={"block rounded-full " + className}
        style={{ width: `${size}px`, height: `${size}px` }}
      />
    );
  }

  return (
    <div
      class={
        "bg-primary-50 rounded-full flex items-center justify-center shrink-0 " +
        className
      }
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      <img
        src="/nicetry_logo_outline.svg"
        alt=""
        class="block rounded-full"
        style={{ width: `${size}px`, height: `${size}px` }}
      />
    </div>
  );
}
