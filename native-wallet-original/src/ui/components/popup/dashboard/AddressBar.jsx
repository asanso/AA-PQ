/* ═══════════════════════════════════════════════════════════════════
   AddressBar — smart-account address pill (Figma 37:17004)
   ───────────────────────────────────────────────────────────────────
   Mono address pill with two interactive zones:
     - Click the address → open the active chain's block explorer
     - Click the copy icon → copy the full address (brief checkmark)

   The address renders in JetBrains Mono (.type-mono-address) per the
   design; the full address is always what gets copied / opened.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { smartAddr } from "@/ui/store.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { explorerUrl } from "@/utils/format.js";
import { useNetwork } from "@/ui/hooks/useNetwork.js";

function CopyIcon() {
  return (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
<path d="M3.33301 1.66699H11.6663C12.5855 1.66699 13.333 2.41449 13.333 3.33366V6.66699H16.6663C17.5855 6.66699 18.333 7.41449 18.333 8.33366V16.667C18.333 17.5862 17.5855 18.3337 16.6663 18.3337H8.33301C7.41384 18.3337 6.66634 17.5862 6.66634 16.667V13.3337H3.33301C2.41384 13.3337 1.66634 12.5862 1.66634 11.667V3.33366C1.66634 2.41449 2.41384 1.66699 3.33301 1.66699ZM16.6663 16.667V8.33366H8.33301L8.33134 16.667H16.6663ZM3.33301 11.667H6.66634V8.33366C6.66634 7.41449 7.41384 6.66699 8.33301 6.66699H11.6663V3.33366H3.33301V11.667Z" fill="#D6D6D6"/>
<path d="M15 10H10V11.6667H15V10ZM15 13.3333H10V15H15V13.3333Z" fill="#D6D6D6"/>
</svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-green)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function AddressBar() {
  const [copied, setCopied] = useState(false);
  const net = useNetwork();
  const networkName = net.network.value?.name || "";

  const addr =
    smartAddr.value ||
    vaultManager.smartAccountAddress ||
    "";

  function copy() {
    if (!addr) return;
    navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  function openExplorer() {
    if (!addr) return;
    window.open(explorerUrl(addr, "address"), "_blank", "noopener,noreferrer");
  }

  // Middle-ellipsis truncate; the full address is always copied / opened.
  const display = addr
    ? addr.length > 41
      ? addr.slice(0, 19) + "..." + addr.slice(-19)
      : addr
    : "No account";

  return (
    <div class="w-full h-10 bg-bg-hover flex items-center justify-between px-3 py-2">
      <button
        type="button"
        onClick={openExplorer}
        disabled={!addr}
        title={addr ? `View on ${networkName} explorer` : ""}
        class="flex-1 min-w-0 text-left bg-transparent border-none cursor-pointer disabled:cursor-default p-0"
      >
        <span class="type-mono-address text-text-dim hover:text-blue-hover truncate block">
          {display}
        </span>
      </button>
      <button
        type="button"
        onClick={copy}
        disabled={!addr}
        aria-label="Copy address"
        class="ml-2 shrink-0 bg-transparent border-none cursor-pointer p-0 flex items-center justify-center disabled:cursor-default"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
