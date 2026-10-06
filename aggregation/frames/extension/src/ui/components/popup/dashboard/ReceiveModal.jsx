/* ═══════════════════════════════════════════════════════════════════
   ReceiveModal — address display for incoming transfers
   ───────────────────────────────────────────────────────────────────
   Shows the smart-account address as text (copy-to-clipboard) and as
   a QR code that, when scanned, decodes to the smart-account address
   (no chain prefix, no EIP-681 wrapper — just the raw 0x… address so
   any wallet app or block explorer can pick it up).

   QR is generated client-side via the `qrcode` npm package, drawn
   into a 240×240 canvas. The error-correction level is "M" — a good
   balance of density vs. resilience for a 42-char address.

   This used to be a modal overlay; it is now a full route (/receive)
   rendered via <SubPageShell> (Figma 42:39980). Back returns to the
   dashboard.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import QRCode from "qrcode";
import { smartAddr } from "@/ui/store.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { SubPageShell, SectionLabel } from "./SubPageShell.jsx";

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function DownloadIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="25" height="25" viewBox="0 0 15 15" fill="none">
  <path d="M10.625 4.375L4.375 10.625" stroke="#3F56E3" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10.625 10.625H4.375V4.375" stroke="#3F56E3" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

export function ReceiveModal() {
  const [, navigate] = useLocation();
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);

  const goBack = () => navigate("/dashboard");

  const addr =
    smartAddr.value ||
    vaultManager.smartAccountAddress ||
    vaultManager.activeAddress ||
    "";

  /* Buyer-side "drop point" generation now lives in the dedicated
     Buy account screen (/buy) — pasting a drop point here used to
     conflate two different flows. The Receive modal is back to
     single-purpose: show the SA address for incoming funds. */

  /* ── Render the QR whenever the address changes ───────────────── */
  useEffect(() => {
    if (!canvasRef.current || !addr) return;
    // Error correction "H" (~30% redundancy) — needed because the
    // NiceTry logo overlay obscures the center of the QR. Without this
    // bump the central pixel block would be lost and the address
    // wouldn't decode in some scanners.
    QRCode.toCanvas(canvasRef.current, addr, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: "H",
      color: {
        dark: "#1a1a1a",
        light: "#ffffff",
      },
    }).catch((e) => {
      console.warn("[NiceTry] QR render failed:", e);
    });
  }, [addr]);

  function copy() {
    navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <SubPageShell
      icon={<DownloadIcon />}
      title="Receive"
      subtitle="Your account address"
      onBack={goBack}
    >
      <div class="w-full px-4 pb-4 flex flex-col gap-4">
        {/* QR section (Figma 37:31875) — label + the generated QR in a
            white rounded frame, NiceTry logo overlaid at the center.
            Error-correction is "H" (above) so the obscured pixels don't
            break decoding. */}
        <div class="w-full flex flex-col gap-2 items-center">
          <SectionLabel>Scan the QR code</SectionLabel>
          <div class="relative bg-white rounded-[16px] p-3">
            {addr ? (
              <>
                <canvas ref={canvasRef} class="block size-[240px]" />
                <img
                  src="/nicetry_logo_outline.svg"
                  alt=""
                  aria-hidden="true"
                  class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-12 rounded-full bg-white p-[2px] pointer-events-none select-none"
                />
              </>
            ) : (
              <div class="size-[240px] flex items-center justify-center text-bg-card text-xs text-center px-4">
                No address available
              </div>
            )}
          </div>
        </div>

        {/* Your address (Figma 37:31884) — full address in mono, inside a
            left-accented block. */}
        <div class="w-full border-l border-border flex flex-col gap-2 px-4 py-2">
          <div class="flex items-center gap-1.5">
            <span class="w-[3px] h-3 bg-blue shrink-0" />
            <span class="type-label-special text-text-dim">Your address</span>
          </div>
          <p class="w-full type-mono-address text-text-muted break-all">
            {addr || "—"}
          </p>
        </div>

        {/* Copy button (Figma 43:3096) — bordered ghost, Barlow label. */}
        <button
          onClick={copy}
          disabled={!addr}
          class={
            "w-full h-10 rounded-[8px] border flex items-center justify-center gap-2 cursor-pointer type-label-button transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed " +
            (copied
              ? "border-green/40 bg-green/10 text-green"
              : "border-border-light text-primary-50 hover:bg-bg-hover")
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </SubPageShell>
  );
}
