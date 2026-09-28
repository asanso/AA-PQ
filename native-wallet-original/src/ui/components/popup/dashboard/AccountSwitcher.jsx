/* ═══════════════════════════════════════════════════════════════════
   AccountSwitcher — /accounts page: pick / create / manage accounts
   ───────────────────────────────────────────────────────────────────
   MetaMask-style account list. Every row is an independent account
   derived at m/44'/60'/{index}'/0'/i' (its own FORS stream, smart
   account, balance and history). The 3-dot menu on each row offers
   Rename, Pin to top / Unpin, and Hide account. Hidden accounts move
   to a collapsible section (their keys stay derivable from the seed).
   "New account" derives the next account and switches to it.

   This used to be a modal overlay; it is now a full route rendered via
   <SubPageShell> (Figma 42:39980) — same list-row language as the
   Network page (brand-blue left bar marks the active account). Back
   returns to the dashboard.

   NOTE: rows are inlined (NOT a nested component). Defining a row
   component inside this function would give it a new identity on every
   keystroke during rename, remounting the <input> and dropping focus.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useAccounts, useNetwork } from "@/ui/hooks";
import { chainId as chainIdSignal } from "@/ui/store.js";
import { getNetwork } from "@/config/networks.js";
import { SubPageShell, SectionLabel } from "./SubPageShell.jsx";

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function UserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function DotsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#a5a5a5">
      <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14l-1.5-3V5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v9z" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function TransferIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function truncate(addr) {
  if (!addr) return "—";
  return addr.length > 16 ? addr.slice(0, 8) + "…" + addr.slice(-6) : addr;
}

function avatarFor(addr, name) {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(addr || name)}`;
}

/* Compact in-list section header. Same visual language as
   ExpandablePanel (uppercase label + chevron) but sized for the list. */
function ChevronExpandIcon({ open }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      class={"text-text-dim transition-transform " + (open ? "rotate-90" : "")}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function SectionToggle({ label, count, open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class="w-full flex items-center justify-between bg-transparent border-none cursor-pointer p-0 pt-4 pb-2 pl-1"
    >
      <span class="flex items-center gap-1.5">
        <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
        <span class="type-label-special text-text-dim">
          {label}{count != null ? ` (${count})` : ""}
        </span>
      </span>
      <ChevronExpandIcon open={open} />
    </button>
  );
}

function MenuItem({ onClick, icon, label, disabled, title }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      class="w-full flex items-center gap-2.5 px-3 py-2.5 text-left bg-transparent border-none cursor-pointer text-text-primary type-label-sm normal-case hover:bg-bg-hover disabled:opacity-40 disabled:cursor-default"
    >
      <span class="text-text-muted">{icon}</span>
      {label}
    </button>
  );
}

export function AccountSwitcher() {
  const accounts = useAccounts();
  const net = useNetwork();
  const [, setLocation] = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [menuFor, setMenuFor] = useState(null);      // index whose ⋮ menu is open
  const [renamingFor, setRenamingFor] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [showTransferred, setShowTransferred] = useState(false);
  /* Per-chain open state for the Imported sections. Uses an "override"
     object instead of a plain Set so the user can explicitly close a
     dropdown that defaulted open (because an active account lived in
     it). Without the override the default-open logic would force
     re-open on every render. Values: true = forced open, false =
     forced closed, undefined = default (open if active account
     belongs to that chain). */
  const [importedChainOverrides, setImportedChainOverrides] = useState({});
  function toggleImportedChain(cid, defaultOpen) {
    setImportedChainOverrides((prev) => {
      const current = prev[cid];
      const effective = current != null ? current : defaultOpen;
      return { ...prev, [cid]: !effective };
    });
  }

  const goBack = () => setLocation("/dashboard");

  const list = accounts.list || [];
  const activeChain = String(chainIdSignal.value || "").toLowerCase();
  /* net.network is a Preact signal — read .value to reach the network
     object. Fallback chain: signal value → direct getNetwork lookup →
     raw hex. Otherwise the user would see "Transferred on 0xaa36a7"
     instead of "Transferred on Sepolia". */
  const netName =
    net.network.value?.name ||
    getNetwork(activeChain)?.name ||
    activeChain;

  /* Classify each account for THIS chain. Priority (top-down):
       transferredOnChain → has transferred[activeChain] entry (any
         status): the user has signed it over.
       imported           → purchased from someone else; bound to one
         chain. Lives in its own dropdown so it doesn't mix with
         seed-derived accounts.
       hidden             → user-hidden.
       visible            → seed-derived, not hidden — the "main" list.
     Each bucket is mutually exclusive (no duplicates between
     visible/imported/transferred/hidden). */
  const isTransferredHere = (a) =>
    !!(a.transferred && a.transferred[activeChain]);
  const transferredOnChain = list.filter(isTransferredHere);
  const remaining = list.filter((a) => !isTransferredHere(a));
  const importedAccounts = remaining.filter((a) => a.imported);
  const seedDerived = remaining.filter((a) => !a.imported);
  const visible = seedDerived.filter((a) => !a.hidden);
  const hidden = seedDerived.filter((a) => a.hidden);
  const canHide = visible.length > 1;

  /* Group imported accounts by their bound chain, sorted by chain name
     so the dropdowns appear in a stable order regardless of import
     order. Each group becomes its own collapsible "Imported on
     {chain}" section. */
  const importedByChain = importedAccounts.reduce((acc, a) => {
    const cid = String(a.importedChainId || "").toLowerCase();
    if (!cid) return acc;
    (acc[cid] = acc[cid] || []).push(a);
    return acc;
  }, {});
  const importedChainIds = Object.keys(importedByChain).sort((x, y) => {
    const nx = getNetwork(x)?.name || x;
    const ny = getNetwork(y)?.name || y;
    return nx.localeCompare(ny);
  });

  /* Sell flow needs the account to be the active one (TransferOwnership
     screen reads smartAddr / activeAccount signals). We switch first
     then navigate. */




  /* Drop a pending purchase entry: removes the vault row + tells the
     SW to stop polling that SA. Used when a giver bails or the
     receiver realises they pasted the wrong info. */


  async function run(fn) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function selectAccount(index) {
    if (renamingFor === index) return; // don't switch while renaming
    const target = list.find((a) => a.index === index);
    /* Pending accounts (created at watch start) aren't usable yet —
       their owner() is still the giver's slot, so any signing attempt
       would fail pre-flight. Block the click until the handover
       signal flips pending off. */
    if (target?.pending) return;
    await run(async () => {
      await accounts.switch(index);
      goBack();
    });
  }

  function startRename(a) {
    setMenuFor(null);
    setRenameValue(a.name);
    setRenamingFor(a.index);
  }

  async function commitRename(index) {
    const name = renameValue.trim();
    setRenamingFor(null);
    if (name) await run(() => accounts.rename(index, name));
  }

  return (
    <SubPageShell
      icon={<UserIcon />}
      title="Accounts"
      subtitle="Switch or create"
      onBack={goBack}
    >
      <div
        onClick={() => setMenuFor(null)}
        class="w-full px-4 pb-4 flex flex-col"
      >
        <SectionLabel>accounts</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          {visible.map((a) => {
            const addr = a.smartAccount || a.identityAddress || "";
            const isRenaming = renamingFor === a.index;
            const menuOpen = menuFor === a.index;
            return (
              <div key={a.index} class="relative">
                <div
                  onClick={() => selectAccount(a.index)}
                  class={
                    "w-full flex items-stretch border cursor-pointer transition-colors duration-150 " +
                    (a.isActive
                      ? "bg-blue/20 border-border"
                      : "border-border bg-transparent hover:bg-bg-hover")
                  }
                >
                  <span class={"w-[3px] shrink-0 " + (a.isActive ? "bg-blue" : "bg-transparent")} />
                  <div class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
                    <div class="size-10 shrink-0 rounded-full overflow-hidden flex items-center justify-center bg-bg-hover">
                      <img src={avatarFor(addr, a.name)} alt="" class="block w-full h-full" referrerPolicy="no-referrer" />
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onClick={(e) => e.stopPropagation()}
                          onInput={(e) => setRenameValue(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") commitRename(a.index);
                            else if (e.key === "Escape") setRenamingFor(null);
                          }}
                          onBlur={() => commitRename(a.index)}
                          class="w-full bg-bg-input border border-blue/50 rounded px-2 py-1 type-label-md text-text-primary outline-none"
                        />
                      ) : (
                        <div class="flex items-center gap-1.5 flex-wrap">
                          <p class="type-label-button text-text-primary truncate">
                            {a.name}
                          </p>
                          {a.pinned && <span class="text-blue-hover" title="Pinned"><PinIcon /></span>}
                        </div>
                      )}
                      <p class="type-label-caption text-text-muted truncate">
                        {truncate(addr)}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label="Account options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuOpen ? null : a.index);
                      }}
                      class="size-7 shrink-0 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover"
                    >
                      <DotsIcon />
                    </button>
                  </div>
                </div>

                {menuOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    class="absolute right-2 top-[calc(100%-6px)] z-10 w-44 bg-bg-card border border-border-light rounded-[8px] shadow-lg overflow-hidden flex flex-col"
                  >
                    <MenuItem onClick={() => startRename(a)} icon={<PencilIcon />} label="Rename" />
                    <MenuItem
                      onClick={() => { setMenuFor(null); run(() => accounts.setPinned(a.index, !a.pinned)); }}
                      icon={<PinIcon />}
                      label={a.pinned ? "Unpin" : "Pin to top"}
                    />
                    <MenuItem
                      onClick={() => { setMenuFor(null); run(() => accounts.hide(a.index)); }}
                      icon={<EyeOffIcon />}
                      label="Hide account"
                      disabled={!canHide}
                    />
                    <div class="h-px bg-border my-0.5" />

                  </div>
                )}
              </div>
            );
          })}
        </div>

        {hidden.length > 0 && (
          <div class="w-full flex flex-col gap-2">
            <SectionToggle
              label="Hidden"
              count={hidden.length}
              open={showHidden}
              onClick={() => setShowHidden((v) => !v)}
            />
            {showHidden &&
              hidden.map((a) => {
                const hAddr = a.smartAccount || a.identityAddress || "";
                return (
                  <div
                    key={a.index}
                    class="w-full flex items-stretch border border-border bg-transparent"
                  >
                    <span class="w-[3px] shrink-0 bg-transparent" />
                    <div class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
                      <div class="size-10 shrink-0 rounded-full overflow-hidden flex items-center justify-center bg-bg-hover">
                        <img src={avatarFor(hAddr, a.name)} alt="" class="block w-full h-full" referrerPolicy="no-referrer" />
                      </div>
                      <div class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
                        <p class="type-label-button text-text-primary truncate">{a.name}</p>
                        <p class="type-label-caption text-text-muted truncate">{truncate(hAddr)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => run(() => accounts.unhide(a.index))}
                        class="shrink-0 size-7 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-blue-hover hover:bg-bg-hover"
                        title="Show"
                      >
                        <EyeIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* One Imported dropdown per chain. The chain name is in the
            section header — rows stay clean. */}
        {importedChainIds.map((cid) => {
          const group = importedByChain[cid];
          const chainName = getNetwork(cid)?.name || cid;
          const isActiveHere = group.some((a) => a.isActive);
          /* Default open if the active account lives here; the user
             can collapse via toggle (override stored in state). */
          const override = importedChainOverrides[cid];
          const isOpen = override != null ? override : isActiveHere;
          return (
            <div key={cid} class="w-full flex flex-col gap-2">
              <SectionToggle
                label={`Imported on ${chainName}`}
                count={group.length}
                open={isOpen}
                onClick={() => toggleImportedChain(cid, isActiveHere)}
              />
              {isOpen &&
                group.map((a) => {
                  const iAddr = a.smartAccount || "";
                  const isPending = !!a.pending;
                  const menuOpen = menuFor === a.index;
                  return (
                    <div key={a.index} class="relative">
                      <div
                        onClick={() => selectAccount(a.index)}
                        title={isPending ? "Waiting for the giver's transfer — not yet usable" : undefined}
                        class={
                          "w-full flex items-stretch border transition-colors duration-150 " +
                          (isPending
                            ? "border-border bg-transparent opacity-60 cursor-not-allowed"
                            : a.isActive
                              ? "cursor-pointer bg-blue/20 border-border"
                              : "cursor-pointer border-border bg-transparent hover:bg-bg-hover")
                        }
                      >
                        <span class={"w-[3px] shrink-0 " + (a.isActive && !isPending ? "bg-blue" : "bg-transparent")} />
                        <div class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
                          <div class="size-10 shrink-0 rounded-full overflow-hidden flex items-center justify-center bg-bg-hover">
                            <img src={avatarFor(iAddr, a.name)} alt="" class="block w-full h-full" referrerPolicy="no-referrer" />
                          </div>
                          <div class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
                            <div class="flex items-center gap-1.5 flex-wrap">
                              <p class="type-label-button text-text-primary truncate">
                                {a.name}
                              </p>
                              {isPending && (
                                <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-[0.4px] bg-amber/15 text-amber border border-amber/30">
                                  Pending
                                </span>
                              )}
                            </div>
                            <p class="type-label-caption text-text-muted truncate">
                              {truncate(iAddr) || "—"}
                            </p>
                          </div>
                          {/* Every imported row gets a 3-dot menu. The
                              label switches based on state: pending →
                              "Remove pending" (deal never came through);
                              claimed → "Remove account" (user wants the
                              entry gone for any reason). Both wipe the
                              vault row AND the SW watch entry. */}
                          <button
                            type="button"
                            aria-label="Account options"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuFor(menuOpen ? null : a.index);
                            }}
                            class="size-7 shrink-0 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-bg-hover"
                            style={{ pointerEvents: "auto" }}
                          >
                            <DotsIcon />
                          </button>
                        </div>
                      </div>

                      {menuOpen && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          class="absolute right-2 top-[calc(100%-6px)] z-10 w-44 bg-bg-card border border-border-light rounded-[8px] shadow-lg overflow-hidden flex flex-col"
                        >
                          <MenuItem
                            onClick={() => removePending(a)}
                            icon={<TransferIcon />}
                            label={isPending ? "Remove pending" : "Remove account"}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}

        {/* Accounts transferred on the active chain. Visually identical
            to regular rows: the user already knows what these are
            because they're inside the "Transferred on {chain}"
            dropdown. */}
        {transferredOnChain.length > 0 && (
          <div class="w-full flex flex-col gap-2">
            <SectionToggle
              label={`Transferred on ${netName}`}
              count={transferredOnChain.length}
              open={showTransferred}
              onClick={() => setShowTransferred((v) => !v)}
            />
            {showTransferred &&
              transferredOnChain.map((a) => {
                const tAddr = a.smartAccount || a.identityAddress || "";
                return (
                  <div
                    key={a.index}
                    class="w-full flex items-stretch border border-border bg-transparent"
                  >
                    <span class="w-[3px] shrink-0 bg-transparent" />
                    <div class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
                      <div class="size-10 shrink-0 rounded-full overflow-hidden flex items-center justify-center bg-bg-hover">
                        <img src={avatarFor(tAddr, a.name)} alt="" class="block w-full h-full" referrerPolicy="no-referrer" />
                      </div>
                      <div class="flex-1 min-w-0 flex flex-col gap-1.5 items-start">
                        <p class="type-label-button text-text-primary truncate">
                          {a.name}
                        </p>
                        <p class="type-label-caption text-text-muted truncate">
                          {truncate(tAddr)}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {error && (
          <p class="type-body-md text-red break-all mt-3">{error}</p>
        )}

        <div class="w-full flex flex-col gap-2 mt-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => run(async () => { await accounts.create(); goBack(); })}
            class="w-full bg-blue/10 border border-blue/30 p-3 flex gap-3 items-center text-left cursor-pointer hover:bg-blue/15 transition-colors duration-150 disabled:opacity-60 disabled:cursor-default"
          >
            <div class="size-8 shrink-0 bg-blue/20 flex items-center justify-center text-blue-hover">
              <PlusIcon />
            </div>
            <p class="type-label-sm text-text-primary">
              {busy ? "Working…" : "New account"}
            </p>
          </button>


        </div>
      </div>
    </SubPageShell>
  );
}
