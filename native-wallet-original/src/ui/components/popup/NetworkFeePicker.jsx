/* ═══════════════════════════════════════════════════════════════════
   NetworkFeePicker — gas control for the Send recap (Figma 181:6248 /
   181:6494 / 181:10760)
   ───────────────────────────────────────────────────────────────────
   <NetworkFeeButton> is the full-width row under the recap cards
   (icon + "NETWORK FEE" + current tier/cost + chevron). Pressing it
   swaps the Send screen for <NetworkFeePage>, a full SubPageShell
   page with the Low / Market / Aggressive presets (Pimlico
   slow/standard/fast) and a live Network-status card. The Advanced
   item navigates one level deeper to <AdvancedFeePage> (Figma
   181:10760): max base fee + priority fee in gwei (MetaMask
   semantics — max fee per gas = base + priority) and the op's gas
   limit, read-only because FORS gas ceilings are wallet-managed.

   Confirm writes the choice to the `sendFeeChoice` signal
   (src/blockchain/fee-preferences.js), which sendAndRotateFors reads
   at submit time — the previewed fee is exactly what gets signed.
   Cancel/back discards the draft.

   Pricing uses `gasCheck` from estimateUserOpCost (totalGas + raw
   tier quotes); Send live-refreshes the tiers every 5s, and since
   both pages derive everything from the gasCheck prop, prices and
   validation floors follow along. When tiers are unavailable
   (Pimlico fallback path, SPHINCS-signed op) the recap row degrades
   to a fixed, non-navigable line.
   ═══════════════════════════════════════════════════════════════════ */

import { useState } from "preact/hooks";
import { formatEther, formatGwei, parseGwei } from "viem";
import {
  sendFeeChoice,
  feeTierLabel,
  FEE_TIERS,
} from "@/blockchain/fee-preferences.js";
import { SubPageShell, SectionLabel } from "./dashboard/SubPageShell.jsx";

/* Inclusion-time hints per preset (12s L1 blocks; decorative). */
const TIER_ETA = {
  low: "24-48 sec",
  market: "12-36 sec",
  aggressive: "12-24 sec",
};

function fmtGwei(bn) {
  try {
    const s = formatGwei(BigInt(bn));
    return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  } catch {
    return String(bn);
  }
}

function fmtEth(wei) {
  try {
    const n = parseFloat(formatEther(BigInt(wei)));
    if (!isFinite(n)) return formatEther(BigInt(wei));
    if (n > 0 && n < 0.000001) return "<0.000001";
    return n
      .toFixed(6)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
  } catch {
    return String(wei);
  }
}

function parseGweiSafe(s) {
  try {
    const v = parseGwei(String(s).trim().replace(",", "."));
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/* Base-fee component of a tier quote (maxFee − priority), floored at
   the full maxFee if the quote is priority-heavy. Display only. */
function tierBase(t) {
  const b = t.maxFeePerGas - t.maxPriorityFeePerGas;
  return b > 0n ? b : t.maxFeePerGas;
}

function BoltIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

function ChevronRightIcon({ class: extra = "" }) {
  return (
    <svg class={extra} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

const cancelBtnClass =
  "flex-1 min-w-0 h-10 rounded-[8px] border border-border-light bg-transparent flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-bg-hover";
const confirmBtnClass =
  "flex-1 min-w-0 h-10 rounded-[8px] bg-primary-600 border-none flex items-center justify-center type-label-button text-primary-50 cursor-pointer transition-colors duration-150 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed";

/* ─────────────────────────────────────────────────────────────────
   Recap row button (Figma 181:6467)
   ───────────────────────────────────────────────────────────────── */

/**
 * Full-width "NETWORK FEE" row under the recap cards. `costEth` is the
 * already-computed cost string for the CURRENT choice (the caller
 * derives it so sufficiency and the display always agree). `locked`
 * renders a fixed, non-navigable line (SPHINCS ops, Pimlico fallback
 * quote); `checking` shows the in-flight estimate state.
 */
export function NetworkFeeButton({ gasCheck, symbol, costEth, locked, checking, onOpen }) {
  const editable =
    !locked && !checking && gasCheck?.tiers && gasCheck?.totalGas != null;
  const tier = sendFeeChoice.value?.tier || "aggressive";

  const subtitle = checking
    ? "Estimating network fee…"
    : editable
      ? `${feeTierLabel(tier)} · ~${Number(costEth).toFixed(6)} ${symbol}`
      : `Maximum · ${Number(costEth).toFixed(6)} ${symbol}`;

  return (
    <button
      type="button"
      onClick={editable ? onOpen : undefined}
      disabled={!editable}
      class={
        "w-full bg-bg-card flex gap-3 items-center px-3 py-2.5 border-none text-left transition-colors duration-150 " +
        (editable
          ? "cursor-pointer hover:bg-bg-hover"
          : "cursor-default " + (checking ? "opacity-70" : ""))
      }
    >
      <div class="size-8 shrink-0 bg-bg-primary flex items-center justify-center text-blue-hover">
        <BoltIcon size={12} />
      </div>
      <div class="flex-1 min-w-0 flex flex-col gap-1 items-start justify-center">
        <p class="type-label-button text-text-secondary uppercase whitespace-nowrap">
          Network fee
        </p>
        <p class="font-body text-[12px] leading-[1.6] text-text-dim truncate w-full">
          {subtitle}
        </p>
      </div>
      {editable && <ChevronRightIcon class="shrink-0 text-text-dim" />}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Advanced page (Figma 181:10760)
   ───────────────────────────────────────────────────────────────── */

/* Labelled gwei input group: blue-tick label, mono input with a GWEI
   suffix, and a Current / live-range caption row underneath.
   `onValue` receives the sanitized string — digits and one decimal
   point only (same guard as the Send amount field). */
function GweiField({ label, value, onValue, currentWei, rangeLo, rangeHi, error }) {
  return (
    <div class="w-full flex flex-col gap-2 items-start">
      <div class="w-full flex items-center gap-1.5 px-1">
        <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
        <span class="type-label-special text-text-dim truncate">{label}</span>
      </div>
      <div
        class={
          "w-full h-10 bg-bg-input border flex items-center gap-2.5 px-3 transition-colors duration-150 focus-within:border-blue " +
          (error ? "border-red/60" : "border-border-light")
        }
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onInput={(e) => {
            /* Digits + a single decimal point (comma normalizes to a
               dot). Force the DOM value too: when the sanitized result
               equals the current state, the signal doesn't change and
               Preact wouldn't re-render, leaving the rejected char
               visible. */
            const v = e.currentTarget.value
              .replace(/,/g, ".")
              .replace(/[^0-9.]/g, "")
              .replace(/(\..*)\./g, "$1");
            e.currentTarget.value = v;
            onValue(v);
          }}
          placeholder="Ex. 0.0425"
          class="flex-1 min-w-0 bg-transparent border-none outline-none p-0 font-mono text-[12px] leading-[1.2] text-text-primary placeholder:text-text-primary/25"
        />
        <span class="shrink-0 font-mono text-[12px] leading-[1.2] text-text-primary/25">
          GWEI
        </span>
      </div>
      {error ? (
        <p class="w-full font-body text-[10px] leading-[1.6] text-red">{error}</p>
      ) : (
        <div class="w-full flex items-start justify-between">
          <p class="font-body text-[10px] leading-[1.6] text-text-muted whitespace-nowrap">
            Current: {fmtGwei(currentWei)} GWEI
          </p>
          <p class="font-body text-[10px] leading-[1.6] text-text-muted whitespace-nowrap">
            Now: {fmtGwei(rangeLo)}-{fmtGwei(rangeHi)} GWEI
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Advanced fee settings — max base fee + priority fee in gwei
 * (committed as maxFeePerGas = base + priority). Confirm commits to
 * sendFeeChoice and unwinds to the recap via `onDone`; Cancel/back
 * returns to the preset page via `onBack`.
 */
function AdvancedFeePage({ gasCheck, symbol, onBack, onDone }) {
  const current = sendFeeChoice.value || {};
  const tiers = gasCheck.tiers;
  const gas = gasCheck.totalGas;

  /* Fields start EMPTY so the Figma placeholder shows (Ex. 0.0425 at
     25%); typed text renders full-strength. Only a previously
     committed custom split is echoed back for editing. */
  const isCustom =
    current.tier === "custom" && current.maxFeePerGas && current.maxPriorityFeePerGas;
  let initPrio = "";
  let initBase = "";
  if (isCustom) {
    try {
      const prio = BigInt(current.maxPriorityFeePerGas);
      const max = BigInt(current.maxFeePerGas);
      initPrio = fmtGwei(prio);
      initBase = fmtGwei(max > prio ? max - prio : max);
    } catch {
      initPrio = "";
      initBase = "";
    }
  }

  const [baseStr, setBaseStr] = useState(initBase);
  const [prioStr, setPrioStr] = useState(initPrio);

  const baseWei = parseGweiSafe(baseStr);
  const prioWei = parseGweiSafe(prioStr);
  const maxFeeWei = baseWei != null && prioWei != null ? baseWei + prioWei : null;

  /* Bundler floor: Pimlico rejects submissions below its slow tier. */
  const minMax = tiers.slow.maxFeePerGas;
  const minPrio = tiers.slow.maxPriorityFeePerGas;

  /* Untouched (empty) fields just disable Confirm — no red error until
     the user has actually typed something wrong. */
  const baseError = !baseStr.trim()
    ? null
    : baseWei == null
      ? "Enter a valid gwei value"
      : maxFeeWei != null && maxFeeWei < minMax
        ? `Base + priority below the bundler floor (min ${fmtGwei(minMax)} gwei total)`
        : null;
  const prioError = !prioStr.trim()
    ? null
    : prioWei == null
      ? "Enter a valid gwei value"
      : prioWei < minPrio
        ? `Priority below the bundler floor (min ${fmtGwei(minPrio)} gwei)`
        : null;
  const invalid = baseWei == null || prioWei == null || !!baseError || !!prioError;

  function save() {
    if (invalid) return;
    sendFeeChoice.value = {
      tier: "custom",
      maxFeePerGas: "0x" + maxFeeWei.toString(16),
      maxPriorityFeePerGas: "0x" + prioWei.toString(16),
    };
    onDone?.();
  }

  return (
    <SubPageShell
      icon={<BoltIcon size={18} />}
      title="Advanced fee"
      subtitle="Set max base fee and priority manually"
      onBack={() => onBack?.()}
      footer={
        <div class="w-full flex gap-4 items-center">
          <button type="button" onClick={() => onBack?.()} class={cancelBtnClass}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={invalid} class={confirmBtnClass}>
            Confirm
          </button>
        </div>
      }
    >
      <div class="w-full flex flex-col px-4 py-4">
        <div class="w-full border border-border-light p-4 flex flex-col gap-6">
          <GweiField
            label="Max base fee"
            value={baseStr}
            onValue={setBaseStr}
            currentWei={tierBase(tiers.standard)}
            rangeLo={tierBase(tiers.slow)}
            rangeHi={tierBase(tiers.fast)}
            error={baseError}
          />
          <GweiField
            label="Priority fee"
            value={prioStr}
            onValue={setPrioStr}
            currentWei={tiers.standard.maxPriorityFeePerGas}
            rangeLo={tiers.slow.maxPriorityFeePerGas}
            rangeHi={tiers.fast.maxPriorityFeePerGas}
            error={prioError}
          />

          {/* Gas limit — display only. FORS ops submit wallet-managed
              ceilings (see gas-estimate.js / config/constants.js): a
              user-lowered limit would AA23 on the FORS verification. */}
          <div class="w-full flex flex-col gap-2 items-start">
            <div class="w-full flex items-center gap-1.5 px-1">
              <span class="w-[3px] h-3 bg-primary-600 shrink-0" />
              <span class="type-label-special text-text-dim truncate">Gas limit</span>
            </div>
            <div class="w-full h-10 bg-bg-input border border-border-light flex items-center px-3">
              <span class="flex-1 min-w-0 font-mono text-[12px] leading-[1.2] text-text-primary/60 truncate">
                {gas.toString()}
              </span>
            </div>
            <div class="w-full flex items-start justify-between gap-2">
              <p class="font-body text-[10px] leading-[1.6] text-text-muted">
                Managed by the wallet (FORS verification ceilings)
              </p>
              {maxFeeWei != null && (
                <p class="font-body text-[10px] leading-[1.6] text-text-muted whitespace-nowrap">
                  max ~{fmtEth(gas * maxFeeWei)} {symbol}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </SubPageShell>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Preset page (Figma 181:6494)
   ───────────────────────────────────────────────────────────────── */

/**
 * Rendered by Send INSTEAD of its own SubPageShell while the picker is
 * open (Send stays mounted, so gasCheck/step survive). Confirm commits
 * the draft to sendFeeChoice; Cancel and the header back both discard.
 * The Advanced row pushes <AdvancedFeePage>, whose own Confirm commits
 * and unwinds all the way back to the recap.
 */
export function NetworkFeePage({ gasCheck, symbol, onClose }) {
  const current = sendFeeChoice.value || { tier: "aggressive" };
  const tiers = gasCheck.tiers;
  const gas = gasCheck.totalGas;

  const [tier, setTier] = useState(current.tier);
  const [advOpen, setAdvOpen] = useState(false);

  if (advOpen) {
    return (
      <AdvancedFeePage
        gasCheck={gasCheck}
        symbol={symbol}
        onBack={() => setAdvOpen(false)}
        onDone={() => onClose?.()}
      />
    );
  }

  function save() {
    /* "custom" as the draft tier only happens when the committed choice
       already IS custom (the Advanced page does its own committing) —
       Confirm just keeps it. */
    if (tier !== "custom") sendFeeChoice.value = { tier };
    onClose?.();
  }

  /* ── Network-status card data ─────────────────────────────────────
     Derived from the tier quotes already in hand — no extra RPCs.
     Base fee ≈ standard maxFee − standard priority (Pimlico quotes
     maxFee as base-derived + priority; close enough for display).
     "Busy" when the fast priority runs ≥3× the slow one — a wide
     spread means searchers are bidding up inclusion. */
  const baseFee = tierBase(tiers.standard);
  const slowPrio = tiers.slow.maxPriorityFeePerGas;
  const busy = tiers.fast.maxPriorityFeePerGas >= (slowPrio > 0n ? slowPrio : 1n) * 3n;

  const labelClass =
    "font-display font-semibold text-[13px] leading-[1.2] text-text-dim uppercase tracking-[0.44px]";
  const valueClass =
    "font-body font-medium text-[13px] leading-[1.2] text-text-primary whitespace-nowrap";

  /* One preset row (Figma "Ephemeral Key Tree Item" styling: selected =
     blue/20 fill + 3px blue bar; idle = hairline border, hover fill). */
  const presetRow = (key, label, maxFee) => {
    const sel = tier === key;
    return (
      <button
        type="button"
        onClick={() => setTier(key)}
        class={
          "w-full flex items-stretch border text-left bg-transparent p-0 cursor-pointer transition-colors duration-150 " +
          (sel ? "bg-blue/20 border-border" : "border-border hover:bg-bg-hover")
        }
      >
        <span class={"w-[3px] shrink-0 self-stretch bg-blue " + (sel ? "" : "opacity-0")} />
        <span class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
          <span class="flex-1 min-w-0 flex flex-col gap-1.5 items-start justify-center">
            <span class="type-label-button text-text-primary uppercase whitespace-nowrap">
              {label}
            </span>
            <span class="font-body text-[12px] leading-[1.2] text-text-muted whitespace-nowrap">
              {TIER_ETA[key] || ""}
            </span>
          </span>
          <span class="shrink-0 flex flex-col gap-1.5 items-end justify-center font-body text-[12px] leading-[1.2] text-text-muted">
            <span class="whitespace-nowrap">{fmtGwei(maxFee)} gwei</span>
            <span class="whitespace-nowrap">
              max ~{fmtEth(gas * maxFee)} {symbol}
            </span>
          </span>
        </span>
      </button>
    );
  };

  /* Advanced row — navigates to the custom page. Highlighted when the
     committed choice is custom, with its split in the subtitle. */
  const customSel = tier === "custom";
  const customSubtitle =
    customSel && current.maxFeePerGas && current.maxPriorityFeePerGas
      ? (() => {
          try {
            return `${fmtGwei(BigInt(current.maxFeePerGas))} gwei max · ${fmtGwei(BigInt(current.maxPriorityFeePerGas))} priority`;
          } catch {
            return "Set max fee and priority manually";
          }
        })()
      : "Set max fee and priority manually";

  return (
    <SubPageShell
      icon={<BoltIcon size={18} />}
      title="Network fee"
      subtitle="Choose how fast this transaction confirms"
      onBack={() => onClose?.()}
      footer={
        <div class="w-full flex gap-4 items-center">
          <button type="button" onClick={() => onClose?.()} class={cancelBtnClass}>
            Cancel
          </button>
          <button type="button" onClick={save} class={confirmBtnClass}>
            Confirm
          </button>
        </div>
      }
    >
      <div class="w-full flex flex-col px-4 pb-4">
        <SectionLabel>Fee preset</SectionLabel>

        <div class="w-full flex flex-col">
          {FEE_TIERS.map((t) =>
            presetRow(t.key, t.label, tiers[t.pimlico]?.maxFeePerGas),
          )}

          {/* Advanced (Figma 181:10700) → AdvancedFeePage */}
          <button
            type="button"
            onClick={() => setAdvOpen(true)}
            class={
              "w-full flex items-stretch border text-left bg-transparent p-0 cursor-pointer transition-colors duration-150 " +
              (customSel ? "bg-blue/20 border-border" : "border-border hover:bg-bg-hover")
            }
          >
            <span
              class={"w-[3px] shrink-0 self-stretch bg-blue " + (customSel ? "" : "opacity-0")}
            />
            <span class="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5">
              <span class="flex-1 min-w-0 flex flex-col gap-1.5 items-start justify-center">
                <span class="type-label-button text-text-primary uppercase whitespace-nowrap">
                  Advanced
                </span>
                <span class="font-body text-[12px] leading-[1.2] text-text-muted truncate w-full">
                  {customSubtitle}
                </span>
              </span>
              <ChevronRightIcon class="shrink-0 text-text-dim" />
            </span>
          </button>
        </div>

        <SectionLabel>Network status</SectionLabel>

        <div class="w-full border border-border p-4 flex flex-col gap-4">
          <div class="w-full flex items-center justify-between">
            <p class={labelClass}>Base fee</p>
            <p class={valueClass}>{fmtGwei(baseFee)} gwei</p>
          </div>
          <div class="w-full flex items-center justify-between">
            <p class={labelClass}>Priority fee</p>
            <p class={valueClass}>
              {fmtGwei(tiers.slow.maxPriorityFeePerGas)}–{fmtGwei(tiers.fast.maxPriorityFeePerGas)} gwei
            </p>
          </div>
          <div class="w-full flex items-center justify-between">
            <p class={labelClass}>Status</p>
            <p
              class={
                "font-body font-medium text-[13px] leading-[1.2] uppercase whitespace-nowrap " +
                (busy ? "text-red" : "text-green")
              }
            >
              {busy ? "Busy" : "Normal"}
            </p>
          </div>
        </div>
      </div>
    </SubPageShell>
  );
}
