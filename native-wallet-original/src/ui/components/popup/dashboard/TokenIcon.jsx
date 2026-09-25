/* ═══════════════════════════════════════════════════════════════════
   TokenIcon — circular asset icon with jazzicon fallback
   ───────────────────────────────────────────────────────────────────
   Renders a 40px (default) circular avatar for a token / native
   asset. The previous implementation rendered the <img> first and
   only flipped to the Jazzicon after onError fired — that meant the
   browser flashed its broken-image glyph during the round-trip, and
   in some cases (cached 404s, fast component unmounts) the onError
   handler never fired so the fallback never appeared at all.

   Now we pre-flight the URL via a detached `new Image()`. The
   <img> in the DOM only mounts once we KNOW it loads cleanly; for
   every other case (no src, still loading, network error, 404)
   the Jazzicon renders. A module-level cache keys results by URL so
   navigating away and back doesn't re-trigger the same fetch — and
   the verdict for a given token URL stays consistent across screens.

   Props:
     - src     (string|null) — URL of the asset logo. Build it via
                                src/ui/utils/asset-icon.js helpers.
     - seed    (string|null) — Stable seed for the Jazzicon fallback
                                (token contract address, dApp host,
                                "native-<chainId>", …). Same seed →
                                same icon every time.
     - size    (number)      — pixel size for both width and height.
                                Defaults to 40 to match the existing
                                size-10 placeholder in the popup rows.
     - bgClass (string)      — Tailwind class(es) for the wrapper
                                background. Only visible when neither
                                image nor seed is provided.
   ═══════════════════════════════════════════════════════════════════ */

import { useState, useEffect } from "preact/hooks";
import { Jazzicon } from "./Jazzicon.jsx";
import { sanitizeExternalIconUrl } from "@/ui/utils/asset-icon.js";

// URL → "loaded" | "failed". Survives across mounts so re-rendering
// the same token row after a tab switch doesn't fire another request.
const urlStatusCache = new Map();

function preloadStatus(src) {
  return src ? urlStatusCache.get(src) : "failed";
}

export function TokenIcon({ src, seed, size = 40, bgClass = "bg-blue" }) {
  const safeSrc = sanitizeExternalIconUrl(src);
  const [status, setStatus] = useState(() => preloadStatus(safeSrc) || "loading");

  useEffect(() => {
    if (!safeSrc) {
      setStatus("failed");
      return;
    }
    const cached = urlStatusCache.get(safeSrc);
    if (cached) {
      setStatus(cached);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    const probe = new Image();
    probe.referrerPolicy = "no-referrer";
    probe.onload = () => {
      urlStatusCache.set(safeSrc, "loaded");
      if (!cancelled) setStatus("loaded");
    };
    probe.onerror = () => {
      urlStatusCache.set(safeSrc, "failed");
      if (!cancelled) setStatus("failed");
    };
    probe.src = safeSrc;
    return () => {
      cancelled = true;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [safeSrc]);

  // Only show the <img> once we've verified it loads. Anything else —
  // pre-flight in progress, no src, 404, network error — falls through
  // to the Jazzicon (when a seed is provided) or the bgClass disc.
  const showImg = status === "loaded" && !!safeSrc;
  const showJazz = !showImg && !!seed;

  return (
    <div
      class={`${bgClass} rounded-full shrink-0 overflow-hidden flex items-center justify-center`}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {showImg && (
        <img
          src={safeSrc}
          alt=""
          class="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
      )}
      {showJazz && <Jazzicon seed={seed} size={size} />}
    </div>
  );
}
