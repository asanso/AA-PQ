/* ═══════════════════════════════════════════════════════════════════
   ImportToken — full-screen "add ERC-20 to wallet" flow (Figma 37:15173)
   ───────────────────────────────────────────────────────────────────
   Single input (token contract address). As soon as the user types a
   valid 0x + 40-hex string we kick off a debounced on-chain read of
   name/symbol/decimals + balanceOf(smartAddr) and render a preview
   card so the user can verify before committing.

   Confirm path:
     1. Save metadata to the token store (chrome.storage-backed)
     2. Refresh ERC-20 balances
     3. Navigate to /dashboard on the Assets tab so the user sees the
        token already listed.

   Chrome: the shared <SubPageShell> (accent icon box + title/subtitle +
   back button header, scrollable body, pinned Cancel / Confirm footer) —
   same as Send / Network / Settings. The body holds the brand-tick
   section label, the address field (Primary/500 border, JetBrains mono)
   and the live preview card.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useTokens, useNetwork } from "@/ui/hooks";
import {
  fetchErc20Metadata,
  fetchErc20Balance,
  fetchErc20IconUrl,
} from "@/blockchain/erc20.js";
import { smartAddr, activeTab } from "@/ui/store.js";
import { TokenIcon } from "./dashboard/TokenIcon.jsx";
import { SubPageShell } from "./dashboard/SubPageShell.jsx";
import { sanitizeExternalIconUrl, tokenIconUrl } from "@/ui/utils/asset-icon.js";

const PREVIEW_DEBOUNCE_MS = 300;

/* Plus-in-square — header accent icon (currentColor → SubPageShell tints
   it Primary/400). */
function ImportTokenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

/* Symbol / Decimals / Balance line inside the preview card. */
function DetailRow({ label, value }) {
  return (
    <div class="w-full flex items-center justify-between gap-3">
      <span class="type-label-special text-text-dim">{label}</span>
      <span class="type-label-md text-text-primary truncate text-right">{value}</span>
    </div>
  );
}

function validAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

export function ImportToken() {
  const [, navigate] = useLocation();
  const tokensApi = useTokens();
  const net = useNetwork();

  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Preview state: tracks the on-chain read for the typed address.
  const [previewState, setPreviewState] = useState("idle"); // idle | loading | ready | error
  const [preview, setPreview] = useState(null); // { name, symbol, decimals, balance }
  const [previewError, setPreviewError] = useState("");

  const owner = smartAddr.value;

  /* ── Debounced metadata + balance fetch ───────────────────────── */
  useEffect(() => {
    const trimmed = address.trim();
    if (!validAddress(trimmed)) {
      setPreview(null);
      setPreviewState("idle");
      setPreviewError("");
      return;
    }
    if (
      tokensApi.list.value.some(
        (t) => t.address.toLowerCase() === trimmed.toLowerCase()
      )
    ) {
      setPreview(null);
      setPreviewState("error");
      setPreviewError("This token is already in your wallet");
      return;
    }

    let cancelled = false;
    setPreviewState("loading");
    setPreviewError("");

    const t = setTimeout(async () => {
      try {
        const meta = await fetchErc20Metadata(trimmed);
        let balance = "0.000000";
        if (owner) {
          try {
            balance = await fetchErc20Balance(trimmed, owner, meta.decimals);
          } catch {
            balance = "—";
          }
        }
        // Best-effort on-chain icon. Non-standard getters; null if none.
        let onchainIcon = null;
        try {
          onchainIcon = await fetchErc20IconUrl(trimmed);
        } catch {
          onchainIcon = null;
        }
        if (cancelled) return;
        setPreview({
          name: meta.name,
          symbol: meta.symbol,
          decimals: meta.decimals,
          balance,
          // Prefer the on-chain URL when available, fall back to the
          // TrustWallet CDN URL built from chainId+address. <TokenIcon>
          // ultimately falls back to the blue circle if the image 404s.
          iconUrl:
            sanitizeExternalIconUrl(onchainIcon) ||
            tokenIconUrl(net.chainId, trimmed),
        });
        setPreviewState("ready");
      } catch {
        if (cancelled) return;
        setPreview(null);
        setPreviewState("error");
        setPreviewError("Could not read token metadata. Verify the address.");
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [address, owner]);

  async function confirm() {
    if (saving) return;
    if (previewState !== "ready" || !preview) {
      setError(previewError || "Enter a valid contract address first");
      return;
    }
    const trimmed = address.trim();
    setSaving(true);
    setError("");
    try {
      tokensApi.add({
        address: trimmed,
        name: preview.name,
        symbol: preview.symbol,
        decimals: preview.decimals,
        chainId: net.chainId,
      });
      // Refresh balances so the new row shows its amount immediately
      // when the user lands on the assets tab.
      tokensApi.refresh().catch(() => {});
      // One-shot: tells Dashboard to mount on the Assets tab. Dashboard
      // resets this back to "balance" so subsequent visits default to
      // the balance tab.
      activeTab.value = "assets";
      navigate("/dashboard");
    } catch (e) {
      setError(e.message || "Failed to add token");
      setSaving(false);
    }
  }

  function cancel() {
    if (saving) return;
    navigate("/dashboard");
  }

  const canConfirm = previewState === "ready" && !saving;

  const cancelBtnClass =
    "flex-1 min-w-0 h-10 rounded-[8px] border border-border-light bg-transparent flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed";
  const confirmBtnClass =
    "flex-1 min-w-0 h-10 rounded-[8px] bg-primary-600 border-none flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed";

  const footer = (
    <div class="w-full flex gap-4 items-center">
      <button type="button" onClick={cancel} disabled={saving} class={cancelBtnClass}>
        Cancel
      </button>
      <button type="button" onClick={confirm} disabled={!canConfirm} class={confirmBtnClass}>
        {saving ? "…" : "Confirm"}
      </button>
    </div>
  );

  return (
    <SubPageShell
      icon={<ImportTokenIcon />}
      title="Import Token"
      subtitle="Add token to your wallet"
      onBack={cancel}
      backDisabled={saving}
      footer={footer}
    >
      <div class="w-full flex flex-col gap-5 px-4 py-4">
        {/* Token Address input */}
        <div class="w-full flex flex-col gap-2 items-start">
          <div class="w-full flex items-center gap-1.5 px-1">
            <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
            <span class="type-label-special text-text-dim">Insert token address</span>
          </div>
          <input
            type="text"
            value={address}
            onInput={(e) => {
              setAddress(e.currentTarget.value);
              setError("");
            }}
            placeholder="0xExample...123456"
            disabled={saving}
            spellcheck={false}
            autoComplete="off"
            class="w-full h-10 bg-bg-input border border-blue outline-none px-3 type-mono-address text-text-secondary placeholder:text-text-dim transition-colors duration-150 focus:border-blue-hover disabled:opacity-50"
          />
          {previewState === "loading" && (
            <p class="w-full type-body-md text-blue-hover">Reading token metadata…</p>
          )}
          {previewState === "error" && (
            <p class="w-full type-body-md text-red">{previewError}</p>
          )}
          {error && previewState !== "error" && (
            <p class="w-full type-body-md text-red">{error}</p>
          )}
        </div>

        {/* Live preview of the resolved token */}
        {previewState === "ready" && preview && (
          <div class="w-full border border-border-light flex flex-col">
            <div class="flex gap-3 items-center p-4 border-b border-border-light">
              <TokenIcon src={preview.iconUrl} seed={address.trim()} size={40} />
              <div class="flex flex-col min-w-0 gap-1">
                <p class="type-label-button text-text-primary truncate">
                  {preview.name || preview.symbol}
                </p>
                <p class="type-label-caption text-text-dim truncate">{preview.symbol}</p>
              </div>
            </div>
            <div class="p-4 flex flex-col gap-3">
              <DetailRow label="Symbol" value={preview.symbol} />
              <DetailRow label="Decimals" value={String(preview.decimals)} />
              <DetailRow label="Balance" value={`${preview.balance} ${preview.symbol}`} />
            </div>
          </div>
        )}
      </div>
    </SubPageShell>
  );
}
