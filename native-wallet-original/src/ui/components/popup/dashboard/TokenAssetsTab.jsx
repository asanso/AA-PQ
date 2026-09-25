/* ═══════════════════════════════════════════════════════════════════
   TokenAssetsTab — "Assets" tab content (Figma 37:14878)
   ───────────────────────────────────────────────────────────────────
   Lists the native asset balance plus any user-imported ERC-20 tokens.
   Tokens come from useTokens (chrome.storage-backed).

   Layout (Figma 37:14878): a labelled list inside the BalanceCard. The
   header carries the brand vertical tick + "WALLET ASSETS" label and two
   compact 20px actions on the right. Each row is a bordered strip (borders
   collapse via -mb-px) with a 2px Primary/400 accent on the left, a 24px
   token avatar, NAME (Barlow uppercase) + symbol, and the balance amount
   (JetBrains mono) with the fiat value beneath it when known.

   Header affordances:
     ☰✕ → toggles "hide mode": rows become selectable and clicking one
          hides the token IMMEDIATELY (no confirm). Hide mode stays on so
          several can be hidden in a row; it exits once the list is empty.
          A hidden token can be re-imported any time via contract address.
     +  → navigates to /import-token (paste contract address)
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useBalance, useNetwork, useTokens, usePriceFeed } from "@/ui/hooks";
import { TokenIcon } from "./TokenIcon.jsx";
import { nativeIconUrl, tokenIconUrl } from "@/ui/utils/asset-icon.js";

/* List-with-× glyph — enters / leaves "hide" mode (Figma 37:14886). */
function ManageIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="14" y2="12" />
      <line x1="3" y1="18" x2="11" y2="18" />
      <path d="M16.5 15.5l5 5M21.5 15.5l-5 5" />
    </svg>
  );
}

/* Plus glyph — navigates to the import-token flow (Figma 37:14888). */
function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function AssetRow({ name, symbol, amount, secondary, iconUrl, seed, hideMode, onPick }) {
  // In hide mode the ERC-20 row becomes a button — clicking it queues
  // the token for confirmation. Outside hide mode it's a static div.
  const interactive = hideMode && !!onPick;
  const Tag = interactive ? "button" : "div";

  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={interactive ? onPick : undefined}
      class={
        "w-full -mb-px border border-border-light flex items-stretch transition-colors duration-150 " +
        (interactive ? "cursor-pointer text-left hover:bg-red/10 hover:border-red" : "")
      }
    >
      {/* Left Primary/400 accent strip (full row height). */}
      <span class="shrink-0 w-0.5 self-stretch bg-blue-hover" />
      <span class="flex-1 min-w-0 flex items-center gap-2 pl-3 pr-4 py-2.5">
        <TokenIcon src={iconUrl} seed={seed} size={24} bgClass="bg-blue-hover" />
        <span class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
          <span class="w-full type-label-button text-text-primary truncate">{name}</span>
          <span class="w-full type-label-caption text-text-dim truncate">{symbol}</span>
        </span>
        <span class="shrink-0 flex flex-col gap-1.5 items-end">
          <span class="type-mono-amount text-text-primary whitespace-nowrap">
            {amount} {symbol}
          </span>
          {secondary && (
            <span class="type-label-caption text-text-dim whitespace-nowrap">{secondary}</span>
          )}
        </span>
      </span>
    </Tag>
  );
}

export function TokenAssetsTab() {
  const [, navigate] = useLocation();
  const bal = useBalance();
  const net = useNetwork();
  const tokensApi = useTokens();
  const price = usePriceFeed();

  // Hide-mode state: the user clicks the manage icon to enter, then
  // clicks a token row to hide it immediately (no confirmation).
  const [hideMode, setHideMode] = useState(false);

  useEffect(() => {
    bal.refresh();
    tokensApi.refresh();
    price.refresh();
  }, []);

  const networkSymbol = net.network.value?.symbol || "ETH";
  const networkName = net.network.value?.name || "Ethereum";
  const importedTokens = tokensApi.list.value;
  const balances = tokensApi.balances.value;
  const nativeUsd = price.toUsd(bal.sa.value);

  function toggleHideMode() {
    setHideMode((v) => !v);
  }

  // Hide immediately on click — no confirmation. Stay in hide mode so
  // several tokens can be hidden in a row; exit once this was the last one.
  function pickForHide(t) {
    tokensApi.remove(t.address);
    if (importedTokens.length <= 1) setHideMode(false);
  }

  // Disable the manage button if there's nothing to hide.
  const canHide = importedTokens.length > 0;

  return (
    <div class="w-full flex flex-col gap-4 pl-4 py-4">
      {/* Header: brand tick + label, then manage / import actions. */}
      <div class="w-full flex items-center justify-between pr-4">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="w-[3px] h-3.5 bg-blue-hover shrink-0" />
          <span class="type-label-special text-text-secondary truncate">Wallet Assets</span>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={toggleHideMode}
            disabled={!canHide}
            aria-label={hideMode ? "Cancel hide mode" : "Hide a token"}
            title={hideMode ? "Cancel hide mode" : "Hide a token"}
            aria-pressed={hideMode}
            class={
              "bg-transparent border-none cursor-pointer p-0 flex items-center justify-center transition-colors duration-150 disabled:opacity-30 disabled:cursor-not-allowed " +
              (hideMode ? "text-red" : "text-text-dim hover:text-text-primary")
            }
          >
            <ManageIcon />
          </button>
          <button
            type="button"
            onClick={() => navigate("/import-token")}
            aria-label="Import token"
            title="Import token"
            class="bg-transparent border-none cursor-pointer p-0 flex items-center justify-center text-text-dim hover:text-text-primary transition-colors duration-150"
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {/* Hide-mode hint. Only rendered while selecting so the resting
          list keeps the design's tight rhythm. */}
      {hideMode && canHide && (
        <p class="w-full pr-4 type-body-sm text-red">
          Select the token you want to hide.
        </p>
      )}

      {/* Asset list — borders collapse between rows via -mb-px. */}
      <div class="w-full flex flex-col">
        {/* Native asset — never selectable in hide mode (no "hide ETH"). */}
        <AssetRow
          name={networkName}
          symbol={networkSymbol}
          amount={bal.sa.value}
          secondary={nativeUsd ? `$${nativeUsd}` : null}
          iconUrl={nativeIconUrl(net.chainId)}
          seed={`native-${net.chainId}`}
        />

        {/* Imported ERC-20 tokens — clickable when hideMode is on. */}
        {importedTokens.map((t) => (
          <AssetRow
            key={t.address}
            name={t.name || t.symbol}
            symbol={t.symbol}
            amount={balances[t.address.toLowerCase()] ?? "—"}
            iconUrl={tokenIconUrl(net.chainId, t.address)}
            seed={t.address}
            hideMode={hideMode}
            onPick={() => pickForHide(t)}
          />
        ))}
      </div>
    </div>
  );
}
