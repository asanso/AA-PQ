/* ═══════════════════════════════════════════════════════════════════
   SettingsMenu — /settings page: wallet settings
   ───────────────────────────────────────────────────────────────────
   Design reference: Figma 42:42943 — implemented 1:1.

   Compact setting rows grouped into labelled sections. Every row: a
   32px icon tile (icon in Primary/400 blue; Error/400 red for the
   destructive one), a Barlow-uppercase title + one-line description, and
   a trailing control (toggle / segmented / chevron). Active rows carry a
   brand-blue left bar; the destructive row a red one. Rows that belong
   together share edges (hairline between them); separate concerns get an
   8px gap.

     GENERAL:  [Sidebar mode]  ·  [Lock wallet + Auto-lock]  ·  [Show key tree]
     ACCOUNT:  [Delete wallet]

   This used to be a modal overlay; it is now a full route rendered via
   <SubPageShell>. Back returns to the dashboard.

   (Two Figma rows are intentionally dropped on the user's instruction:
   the DEBUG "Signatures made" row — the cumulative counter is disabled
   until it's keyed per account + chain — and the ACCOUNT "Log out" row,
   which would duplicate Lock wallet.)
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { useVault } from "@/ui/hooks";
import { clearSessionKey } from "@/popup/session.js";

import {
  tree,
  logs,
  txHistory,
  smartAddr,
  uiMode,
} from "@/ui/store.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { setUiMode, openWalletSidebar } from "@/ui/utils/ui-mode.js";
import { storageGet, storageSet } from "@/utils/storage.js";
import { theme, setTheme } from "@/ui/theme.js";
import { SubPageShell, SectionLabel } from "./SubPageShell.jsx";

const AUTOLOCK_DEFAULT_MIN = 10;
const AUTOLOCK_OPTIONS = [1, 5, 10, 15, 30, 60];

/* ── Header glyph ── */
function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/* ── 16px row glyphs (match the Figma setting icons) ── */
function SidebarIcon() {
  // Exact Figma glyph (node 47:3421 — a panel with a right sidebar
  // column + a chevron). Reconstructed 1:1 from the two source vectors,
  // positioned in a 16px box at the Figma insets. `currentColor` lets it
  // pick up the row's Primary/400 blue (and any future theme accent).
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<path d="M4.81325 9.64652L6.45992 7.99985L4.81325 6.35318C4.74743 6.29207 4.69932 6.21433 4.67398 6.12817C4.64863 6.042 4.647 5.9506 4.66925 5.86358C4.6915 5.77657 4.73681 5.69716 4.8004 5.63373C4.86399 5.57031 4.94351 5.52521 5.03058 5.50318C5.1175 5.48091 5.20882 5.48246 5.29492 5.50768C5.38103 5.53291 5.45876 5.58087 5.51992 5.64652L7.51992 7.64652C7.61355 7.74027 7.66614 7.86735 7.66614 7.99985C7.66614 8.13235 7.61355 8.25943 7.51992 8.35318L5.51992 10.3532C5.42508 10.4415 5.29971 10.4895 5.17016 10.4873C5.04062 10.485 4.91699 10.4327 4.82525 10.3412C4.73375 10.2494 4.68138 10.1258 4.67915 9.99627C4.67691 9.86673 4.72498 9.74136 4.81325 9.64652Z" fill="#6E88EC"/>
<path d="M2.50004 1.33325H13.5C14.144 1.33325 14.6667 1.85592 14.6667 2.49992V13.4999C14.6667 13.8093 14.5438 14.1061 14.325 14.3249C14.1062 14.5437 13.8095 14.6666 13.5 14.6666H2.50004C2.19062 14.6666 1.89388 14.5437 1.67508 14.3249C1.45629 14.1061 1.33337 13.8093 1.33337 13.4999V2.49992C1.33337 1.85592 1.85604 1.33325 2.50004 1.33325ZM2.33337 2.49992V13.4999C2.33337 13.5919 2.40804 13.6666 2.50004 13.6666H10V2.33325H2.50004C2.45584 2.33325 2.41345 2.35081 2.38219 2.38207C2.35093 2.41332 2.33337 2.45572 2.33337 2.49992ZM11 13.6666H13.5C13.5442 13.6666 13.5866 13.649 13.6179 13.6178C13.6491 13.5865 13.6667 13.5441 13.6667 13.4999V2.49992C13.6667 2.45572 13.6491 2.41332 13.6179 2.38207C13.5866 2.35081 13.5442 2.33325 13.5 2.33325H11V13.6666Z" fill="#6E88EC"/>
</svg>
  );
}

function LockIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<path d="M7.99996 1.33325C6.16196 1.33325 4.66663 2.82859 4.66663 4.66658V6.66658H3.99996C3.26463 6.66658 2.66663 7.26459 2.66663 7.99992V13.3333C2.66663 14.0686 3.26463 14.6666 3.99996 14.6666H12C12.7353 14.6666 13.3333 14.0686 13.3333 13.3333V7.99992C13.3333 7.26459 12.7353 6.66658 12 6.66658H11.3333V4.66658C11.3333 2.82859 9.83796 1.33325 7.99996 1.33325ZM12 7.99992L12.0013 13.3333H3.99996V7.99992H12ZM5.99996 6.66658V4.66658C5.99996 3.56392 6.89729 2.66659 7.99996 2.66659C9.10263 2.66659 9.99996 3.56392 9.99996 4.66658V6.66658H5.99996Z" fill="#6E88EC"/>
</svg>
  );
}

function AutoLockIcon() {
  // Padlock with a rotation arrow — "locks automatically".
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
<g clip-path="url(#clip0_47_3445)">
<path d="M6.66663 2.84008V4.23341C5.11329 4.78675 3.99996 6.26008 3.99996 8.00008C3.99996 9.18008 4.51996 10.2267 5.33329 10.9601V9.33341H6.66663V13.3334H2.66663V12.0001H4.48663C3.91456 11.5025 3.45602 10.8879 3.14203 10.1978C2.82804 9.50773 2.66592 8.75825 2.66663 8.00008C2.66663 5.51341 4.36663 3.43341 6.66663 2.84008ZM13.3333 2.66675H9.33329V6.66675H10.6666V5.04008C11.48 5.77341 12 6.82008 12 8.00008H13.3333C13.3333 6.40008 12.6266 4.97341 11.5133 4.00008H13.3333V2.66675ZM13.3333 11.3334V10.6667C13.3333 9.93341 12.7333 9.33341 12 9.33341C11.2666 9.33341 10.6666 9.93341 10.6666 10.6667V11.3334C10.3 11.3334 9.99996 11.6334 9.99996 12.0001V14.0001C9.99996 14.3667 10.3 14.6667 10.6666 14.6667H13.3333C13.7 14.6667 14 14.3667 14 14.0001V12.0001C14 11.6334 13.7 11.3334 13.3333 11.3334ZM12.6666 11.3334H11.3333V10.6667C11.3333 10.3001 11.6333 10.0001 12 10.0001C12.3666 10.0001 12.6666 10.3001 12.6666 10.6667V11.3334Z" fill="#6E88EC"/>
</g>
<defs>
<clipPath id="clip0_47_3445">
<rect width="16" height="16" fill="white"/>
</clipPath>
</defs>
</svg>
  );
}

function KeyTreeGlyph() {
  // The wallet's own Ephemeral Key Tree mark (Dashboard KeyTreeIcon).
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M9 1H1V9H9V6H11V20H15V23H23V15H15V18H13V6H15V9H23V1H15V4H9V1ZM21 3H17V7H21V3ZM17 17H21V21H17V17Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
  <path d="M5.625 2.875H5.5C5.56875 2.875 5.625 2.81875 5.625 2.75V2.875H10.375V2.75C10.375 2.81875 10.4312 2.875 10.5 2.875H10.375V4H11.5V2.75C11.5 2.19844 11.0516 1.75 10.5 1.75H5.5C4.94844 1.75 4.5 2.19844 4.5 2.75V4H5.625V2.875ZM13.5 4H2.5C2.22344 4 2 4.22344 2 4.5V5C2 5.06875 2.05625 5.125 2.125 5.125H3.06875L3.45469 13.2969C3.47969 13.8297 3.92031 14.25 4.45312 14.25H11.5469C12.0812 14.25 12.5203 13.8312 12.5453 13.2969L12.9312 5.125H13.875C13.9437 5.125 14 5.06875 14 5V4.5C14 4.22344 13.7766 4 13.5 4ZM11.4266 13.125H4.57344L4.19531 5.125H11.8047L11.4266 13.125Z" fill="#F3767B"/>
</svg>
  );
}

/* Half-filled disc — the two neutral skins (stone / slate). currentColor
   for the outline so it picks the row's Primary/400 blue tile. */
function ThemeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3 a9 9 0 0 1 0 18 z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/* Pill toggle (Figma 30:4413). Purely visual — the enclosing row's
   button owns the click. ON: Primary/500 track + Primary/50 knob.
   OFF: Neutral/700 track + Neutral/500 knob. */
function Toggle({ on }) {
  return (
    <span
      class={
        "relative w-10 h-6 rounded-full shrink-0 transition-colors duration-150 " +
        (on ? "bg-blue" : "bg-border-light border border-border")
      }
    >
      <span
        class={
          "absolute top-1 size-4 rounded-full transition-all duration-150 " +
          (on ? "right-1 bg-primary-50" : "left-1 bg-text-dim")
        }
      />
    </span>
  );
}

const Divider = () => <div class="h-px w-full bg-border-light" />;

/* One setting row. `accent`: "active" (blue bar) | "danger" (red bar +
   error tint) | undefined (plain). `onClick` makes the whole row a
   button; `footer` renders a second block (e.g. a segmented control)
   inside the same surface. Icons are Primary/400 (Error/400 for danger). */
function SettingRow({ icon, title, desc, accent, onClick, control, footer, ariaPressed }) {
  const bar =
    accent === "active" ? "bg-blue" : accent === "danger" ? "bg-red" : "bg-transparent";
  const surface = accent === "danger" ? "bg-error-500/20" : "bg-bg-card";
  const iconTile =
    accent === "danger" ? "bg-error-900 text-error-400" : "bg-bg-primary text-blue-hover";
  const titleColor = accent === "danger" ? "text-error-400" : "text-text-secondary";

  const Body = onClick ? "button" : "div";
  // Rows without a footer use py-10 (Figma); the segmented Auto-lock row
  // uses py-16 with a 16px gap before the selector.
  const pad = footer ? "py-4" : "py-2.5";
  return (
    <div class="w-full flex items-stretch">
      <span class={"w-[3px] shrink-0 " + bar} />
      <Body
        {...(onClick
          ? { type: "button", onClick, role: ariaPressed != null ? "switch" : undefined, "aria-checked": ariaPressed }
          : {})}
        class={
          "flex-1 min-w-0 px-3 text-left border-none " + pad + " " +
          surface +
          (onClick ? " cursor-pointer hover:brightness-110 transition-[filter] duration-150" : "")
        }
      >
        <div class="flex gap-3 items-center">
          <span class={"size-8 shrink-0 flex items-center justify-center " + iconTile}>
            {icon}
          </span>
          <span class="flex-1 min-w-0 flex flex-col gap-1 items-start">
            <span class={"type-label-button truncate " + titleColor}>{title}</span>
            {/* Description reserves two text lines (in `lh`, so it tracks
                the line-height — not a hardcoded px) and clamps to two,
                matching the Figma rows whose height is driven by a
                two-line description (→ ~76px rows). */}
            {desc && (
              <span class="type-body-md text-text-muted text-left line-clamp-2 min-h-[2lh]">
                {desc}
              </span>
            )}
          </span>
          {control}
        </div>
        {footer && <div class="mt-4">{footer}</div>}
      </Body>
    </div>
  );
}

/* Segmented selector (Figma 42:43027). Equal cells, hairline dividers,
   the selected cell filled brand-blue. */
function Segmented({ options, value, onSelect }) {
  return (
    <div class="w-full flex rounded-[8px] overflow-hidden border border-border">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect(o.value); }}
            class={
              "flex-1 py-2 type-body-md text-center border-r border-border last:border-r-0 cursor-pointer transition-colors duration-150 " +
              (active
                ? "bg-blue text-primary-50"
                : "bg-bg-hover text-text-muted hover:text-text-primary")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* Signature glyph for the signing-method row. */
function SignIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17c3 0 3-10 6-10s3 8 6 8 3-3 6-3" />
      <path d="M3 21h18" />
    </svg>
  );
}

export function SettingsMenu() {
  const [, navigate] = useLocation();
  const vault = useVault();
  const isSidebar = uiMode.value === "sidebar";

  const goBack = () => navigate("/dashboard");

  // Auto-lock setting. Read once on open, then write through to storage
  // and notify the background SW so it re-arms its running timer with
  // the new value (otherwise the change would only kick in on the next
  // SESSION_ACTIVITY tick).
  const [autolockMin, setAutolockMin] = useState(AUTOLOCK_DEFAULT_MIN);
  useEffect(() => {
    let cancelled = false;
    storageGet("nt_autolock_min").then((v) => {
      const n = Number(v);
      if (!cancelled && Number.isFinite(n) && n > 0) setAutolockMin(n);
    });
    return () => { cancelled = true; };
  }, []);

  // Hydrate the "show key tree" preference so the toggle reflects the
  // stored value when the menu opens (hidden by default).




  async function selectAutolock(n) {
    setAutolockMin(n);
    await storageSet("nt_autolock_min", n);
    chrome.runtime
      .sendMessage({ type: "SETTINGS_AUTOLOCK_CHANGED" })
      .catch?.(() => {});
  }

  async function deleteWallet() {
    // Stock confirm dialog — no custom modal stack here yet. Replace
    // with a proper Are-You-Sure UI when scope allows.
    // eslint-disable-next-line no-alert
    if (!confirm("Delete wallet? This cannot be undone.")) return;
    await vault.destroy();
    clearSessionKey();

    smartAddr.value = "";
    tree.value = [];
    logs.value = [];
    txHistory.value = [];
    chrome.runtime.sendMessage({ type: "SESSION_LOCK" }).catch?.(() => {});
    navigate("/landing");
  }

  function lockWallet() {
    vault.lock();
    clearSessionKey();

    // Zero transient state so a future unlock starts fresh.
    //
    // ORDER MATTERS: clear smartAddr FIRST so the tx-persistence write
    // effect sees an empty key and bails out. If we cleared
    // txHistory first, the effect would write `[]` to the still-valid
    // key and wipe the persisted history — on next unlock, nothing to
    // reload. See src/ui/persistence/tx-persistence.js.
    smartAddr.value = "";
    tree.value = [];
    logs.value = [];
    txHistory.value = [];
    chrome.runtime.sendMessage({ type: "SESSION_LOCK" }).catch?.(() => {});
    navigate("/unlock");
  }

  async function switchToPopup() {
    // Restore default_popup so the toolbar action opens the popup
    // again, and stop sidePanel from hijacking the action click.
    const modeChanged = setUiMode("popup");
    // Firefox requires the close call in the original click handler too.
    const closing = chrome.sidebarAction?.close?.().catch(() => {});
    await modeChanged;
    uiMode.value = "popup";

    // Try to surface the popup right away (requires a user gesture —
    // the click we're handling is one). If it fails (e.g. no toolbar
    // pin) the user can still open it manually via the puzzle icon.
    try {
      const p = chrome?.action?.openPopup?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}

    // Firefox exposes a sidebar API; Chromium panels honor window.close().
    if (closing) await closing;
    else window.close();
  }

  async function switchToSidebar() {
    // Start both operations from the click handler so Firefox keeps the
    // user gesture required to open the sidebar.
    const modeChanged = setUiMode("sidebar");
    const opening = openWalletSidebar().catch(() => {});
    await modeChanged;
    uiMode.value = "sidebar";
    await opening;
    window.close();
  }

  const autolockOpts = AUTOLOCK_OPTIONS.map((n) => ({
    value: n,
    label: n < 60 ? `${n}m` : "1h",
  }));

  return (
    <SubPageShell
      icon={<GearIcon />}
      title="Settings"
      subtitle="Wallet preferences"
      onBack={goBack}
    >
      <div class="w-full px-4 pb-4 flex flex-col">
        {/* ── GENERAL ─────────────────────────────────────────────── */}
        <SectionLabel>general</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          {/* Sidebar mode — toggle. ON when the wallet runs in the
              browser side panel; clicking switches surface. */}
          <div class="flex flex-col">
            <SettingRow
              icon={<SidebarIcon />}
              title="Sidebar mode"
              desc="Open the wallet in the browser's side panel so it stays docked while you browse other tabs."
              accent={isSidebar ? "active" : undefined}
              ariaPressed={isSidebar}
              onClick={isSidebar ? switchToPopup : switchToSidebar}
              control={<Toggle on={isSidebar} />}
            />
            <Divider />
          </div>

          {/* Lock wallet + Auto-lock — grouped (share edges). */}
          <div class="flex flex-col">
            <SettingRow
              icon={<LockIcon />}
              title="Lock wallet"
              desc="End the current session now — your password will be required to unlock the wallet again."
              onClick={lockWallet}
              control={<span class="text-text-muted shrink-0"><ChevronRightIcon /></span>}
            />
            <Divider />
            <SettingRow
              icon={<AutoLockIcon />}
              title="Auto-lock"
              desc="Automatically lock the wallet after the selected period of inactivity for extra safety."
              accent="active"
              footer={
                <Segmented
                  options={autolockOpts}
                  value={autolockMin}
                  onSelect={selectAutolock}
                />
              }
            />
            <Divider />
          </div>

          {/* Show key tree — visibility toggle (hidden by default). */}

        </div>

        {/* ── SIGNING ─────────────────────────────────────────────── */}
        <SectionLabel>signing</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          <div class="flex flex-col">
            <SettingRow
              icon={<SignIcon />}
              title="SPHINCS"
              desc="Wallet transfers use SPHINCS signatures. The signing method is fixed for this test build."
              accent="active"
            />
            <Divider />
          </div>
        </div>

        {/* ── APPEARANCE ──────────────────────────────────────────── */}
        <SectionLabel>appearance</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          {/* Theme — Stone (warm grey) ⇄ Slate (cool blue-grey). Segmented
              selector, same control as Auto-lock. Switching writes the
              <html data-theme> attribute via setTheme (CSS does the rest). */}
          <div class="flex flex-col">
            <SettingRow
              icon={<ThemeIcon />}
              title="Theme"
              desc="Choose the wallet's neutral palette — Stone (warm grey) or Slate (cool blue-grey)."
              accent="active"
              footer={
                <Segmented
                  options={[
                    { value: "stone", label: "Stone" },
                    { value: "slate", label: "Slate" },
                  ]}
                  value={theme.value}
                  onSelect={setTheme}
                />
              }
            />
            <Divider />
          </div>
        </div>

        {/* ── ACCOUNT ─────────────────────────────────────────────── */}
        <SectionLabel>account</SectionLabel>

        <div class="w-full flex flex-col gap-2">
          {/* Delete wallet — destructive: wipes the keyring + seed. No
              trailing divider (matches the Figma). */}
          <div class="flex flex-col">
            <SettingRow
              icon={<TrashIcon />}
              title="Delete wallet"
              desc="Permanently erase the keyring and seed from this device — this action cannot be undone."
              accent="danger"
              onClick={deleteWallet}
              control={<span class="text-error-400 shrink-0"><ChevronRightIcon /></span>}
            />
          </div>
        </div>
      </div>
    </SubPageShell>
  );
}
