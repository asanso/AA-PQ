/* ═══════════════════════════════════════════════════════════════════
   Jazzicon — deterministic identicon used as the missing-image fallback
   ───────────────────────────────────────────────────────────────────
   Pure SVG, no dependencies. Given a stable seed (an address, a host,
   "native-<chainId>", …) we hash it, use the hash to seed a tiny PRNG,
   and draw a colored circle plus a handful of rotated/translated
   squares — visually similar to MetaMask's jazzicon.

   Why this exists:
     The TrustWallet CDN doesn't have a logo for every ERC-20. Without
     a fallback the <img> goes "broken-image" or blank. The user asked
     us to show a randomized icon for any asset that lacks artwork, so
     every token still feels visually distinct from the others.

   Notes:
     - Output is just an inline <svg>; the consuming TokenIcon wraps it
       in a `rounded-full overflow-hidden` div which handles the round
       clip. No need to clip inside the SVG.
     - Same seed → same icon, always (deterministic). That's the whole
       point: the user recognizes a token by its colors.
   ═══════════════════════════════════════════════════════════════════ */

const PALETTE = [
  "#01888C", "#FC7500", "#034F5D", "#F73F01", "#FC1960",
  "#C7144C", "#F3C100", "#1598F2", "#2465E1", "#F19E02",
];

/* FNV-1a 32-bit string hash. */
function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* mulberry32 — tiny seedable PRNG. Returns a function: () => [0,1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0)) / 4294967296;
  };
}

export function Jazzicon({ seed = "", size = 40, shapes = 4 }) {
  const rng = mulberry32(hash32(seed || "fallback"));

  // Rotate the palette by a seed-derived offset so different seeds
  // produce different base colors without repeating the same shape
  // colors back-to-back.
  const offset = Math.floor(rng() * PALETTE.length);
  const colors = PALETTE.slice(offset).concat(PALETTE.slice(0, offset));

  const bg = colors[0];
  const els = [];
  for (let i = 1; i <= shapes; i++) {
    const color = colors[i % colors.length];
    const rotation = rng() * 360;
    const tx = rng() * 100 - 50;
    const ty = rng() * 100 - 50;
    els.push(
      <rect
        key={i}
        x="0"
        y="0"
        width="100"
        height="100"
        fill={color}
        transform={`translate(${tx} ${ty}) rotate(${rotation} 50 50)`}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
    >
      <rect x="0" y="0" width="100" height="100" fill={bg} />
      {els}
    </svg>
  );
}
