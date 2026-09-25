/* ═══════════════════════════════════════════════════════════════════
   OnboardingCorners — blue triangle corners shared by every card
   ───────────────────────────────────────────────────────────────────
   Design reference: Figma 154:2578 (top-left) and 154:2629
   (bottom-right). Two 40×20 SVG triangles in Primary/500 (#3F56E3)
   that sit flush against the card edges:
     - Top-left: vertices (0,0) (40,0) (0,20)
     - Bottom-right: vertices (40,0) (40,20) (0,20)

   The cards' vanity wrapper is bg #f8f6f4. The exposed half of each
   strip (the cream side of the triangle) blends into the wrapper;
   the blue half forms the visible diagonal corner accent.
   ═══════════════════════════════════════════════════════════════════ */

export function CornerTopLeft({ fill = "var(--color-blue)" }) {
  return (
    <div class="flex items-start w-full shrink-0 z-100">
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20" fill="none">
<path d="M0 0H40L20 20H0V0Z" fill={fill}/>
</svg>
    </div>
  );
}

export function CornerBottomRight({ fill = "var(--color-blue)" }) {
  return (
    <div class="flex items-end justify-end w-full shrink-0 z-100">
     <svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20" fill="none">
<path d="M20 0H40V20H0L20 0Z" fill={fill}/>
</svg>
    </div>
  );
}
