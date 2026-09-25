/* ═══════════════════════════════════════════════════════════════════
   NetworkSwitcher — /network page: pick the live chain at runtime
   ───────────────────────────────────────────────────────────────────
   Lists the supported networks (config/networks.js, minus hidden ones)
   and switches instantly on tap via useNetwork().switchChain(). The
   smart-account address is identical on every chain, so switching only
   re-points the per-chain view (rotation index, balance, history).

   This used to be a modal overlay; it is now a full route rendered via
   <SubPageShell> (Figma 42:39980): a section label + list rows with a
   brand-blue left bar marking the active chain. Back returns to the
   dashboard.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useNetwork } from "@/ui/hooks/useNetwork.js";
import { useAccounts } from "@/ui/hooks";
import { TokenIcon } from "./TokenIcon.jsx";
import { chainLogoUrl } from "@/ui/utils/asset-icon.js";
import { SubPageShell, SectionLabel } from "./SubPageShell.jsx";

function NetworkGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/* "ETH Testnet" style subtitle from the chain's native ticker + tier. */
function netSubtitle(n) {
  const tier = n.badge === "MAINNET" ? "Mainnet" : "Testnet";
  return `${n.symbol} ${tier}`;
}

/* Vertical 3-dots — opens the per-chain edit page (rename + custom RPC). */
function KebabIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

function NetworkRow({ n, isActive, busy, onSelect, onEdit }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}
      class={
        "w-full flex items-stretch text-left border transition-colors duration-150 " +
        (busy ? "cursor-wait opacity-60 " : "cursor-pointer ") +
        (isActive
          ? "bg-blue/20 border-border"
          : "border-border bg-transparent hover:bg-bg-hover")
      }
    >
      {/* Active indicator: full-height 3px brand-blue bar (Figma 42:40032).
          Kept (transparent) on inactive rows so the content stays aligned. */}
      <span class={"w-[3px] shrink-0 " + (isActive ? "bg-blue" : "bg-transparent")} />
      <div class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
        <TokenIcon
          src={chainLogoUrl(n.chainId)}
          seed={`chain-${n.chainId}`}
          size={40}
          bgClass="bg-white"
        />
        <div class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
          <span class="type-label-button text-text-primary truncate">{n.name}</span>
          <span class="type-label-caption text-text-muted truncate">{netSubtitle(n)}</span>
        </div>
        {/* ⋮ — edit RPC / rename. Stops propagation so it doesn't also
            trigger the row's chain switch. */}
        <button
          type="button"
          aria-label={`Edit ${n.name}`}
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          class="shrink-0 size-8 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors duration-150"
        >
          <KebabIcon />
        </button>
      </div>
    </div>
  );
}

export function NetworkSwitcher() {
  const net = useNetwork();
  const accounts = useAccounts();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const goBack = () => navigate("/dashboard");

  const fullList = net.list || [];
  const activeId = net.chainId;

  /* Imported accounts are bound to a single chain (the one where the
     giver signed the transfer). Showing every other network is
     misleading — they'd all auto-switch the account anyway via
     useNetwork.switchChain. We filter the list down to the bound
     chain so the user can't accidentally pick one that isn't valid
     for the current account. */
  const activeAccount = (accounts.list || []).find((a) => a.isActive);
  const boundChain = activeAccount?.imported
    ? String(activeAccount.importedChainId || "").toLowerCase()
    : null;
  const list = boundChain
    ? fullList.filter((n) => String(n.chainId).toLowerCase() === boundChain)
    : fullList;

  async function select(id) {
    if (busy) return;
    if (id === activeId) {
      goBack();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await net.switchChain(id);
      goBack();
    } catch (e) {
      setError(e?.message || String(e));
      setBusy(false);
    }
  }

  return (
    <SubPageShell
      icon={<NetworkGlyph />}
      title="Networks"
      subtitle="Pick the active chain"
      onBack={goBack}
    >
      <div class="w-full px-4 pb-4 flex flex-col">
        {boundChain && (
          <div class="w-full mt-4 bg-blue/10 border border-blue/30 rounded-[8px] p-3">
            <p class="type-body-md text-text-primary">
              <span class="font-bold">{activeAccount?.name}</span> is locked to its chain. Switch account to use others.
            </p>
          </div>
        )}

        <SectionLabel>supported network</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          {list.map((n) => (
            <NetworkRow
              key={n.chainId}
              n={n}
              isActive={n.chainId === activeId}
              busy={busy}
              onSelect={() => select(n.chainId)}
              onEdit={() => navigate(`/network-edit/${n.chainId}`)}
            />
          ))}
        </div>

        {error && (
          <p class="type-body-md text-red break-all mt-3">{error}</p>
        )}
      </div>
    </SubPageShell>
  );
}
