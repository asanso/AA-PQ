/* ═══════════════════════════════════════════════════════════════════
   BalanceCard — unified balance / assets overview (Figma 37:17012)
   ───────────────────────────────────────────────────────────────────
   One bordered card containing the whole hero block:
     · BALANCE / ASSETS segmented tabs (the active tab carries the
       primary fill + square marker)
     · TOTAL BALANCE label + live 24h price trend
     · hero balance (Barlow display) + dimmed symbol
     · USD value + decorative mini-chart
     · SEND / RECEIVE footer

   Selecting ASSETS swaps the body for <TokenAssetsTab/> in place, so
   the card frame stays put. Data: useBalance (native balance),
   usePriceFeed (USD + 24h change). Navigation is delegated to the
   parent via onSend / onReceive.

   Typography: .type-* (display-hero, display-title, label-*). Colours:
   semantic theme tokens → follows stone/slate.
   ═══════════════════════════════════════════════════════════════════ */

import { useEffect } from "preact/hooks";
import { useBalance, useNetwork, usePriceFeed } from "@/ui/hooks";
import { TokenAssetsTab } from "./TokenAssetsTab.jsx";

const TABS = [
  { id: "balance", label: "Balance" },
  { id: "assets", label: "Assets" },
];

function SendIcon() {
  return (
   <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none">
  <path d="M4.375 4.375H10.625V10.625" stroke="#F0F3FE" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M4.375 10.625L10.625 4.375" stroke="#F0F3FE" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

function ReceiveIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15" fill="none">
  <path d="M10.625 4.375L4.375 10.625" stroke="currentColor" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10.625 10.625H4.375V4.375" stroke="currentColor" stroke-width="1.5625" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
  );
}

function TrendArrow({ up }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {up ? (
        <>
          <line x1="7" y1="17" x2="17" y2="7" />
          <polyline points="7 7 17 7 17 17" />
        </>
      ) : (
        <>
          <line x1="7" y1="7" x2="17" y2="17" />
          <polyline points="17 7 17 17 7 17" />
        </>
      )}
    </svg>
  );
}

function Tabs({ active, onChange }) {
  return (
    <div class="relative flex h-10 border border-border-light">
      {TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            class={
              "flex-1 min-w-0 flex items-center justify-center gap-1.5 border-none cursor-pointer transition-colors duration-150 " +
              (isActive ? "bg-blue" : "bg-transparent hover:bg-white/5")
            }
          >
            {isActive && <span class="size-[5px] bg-primary-50 shrink-0" />}
            <span class={"type-label-button-sm " + (isActive ? "text-primary-50" : "text-text-muted")}>
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function BalanceCard({ tab, onTab, onSend, onReceive }) {
  const bal = useBalance();
  const net = useNetwork();
  const price = usePriceFeed();

  useEffect(() => {
    bal.refresh();
    price.refresh();
  }, []);

  const symbol = net.network.value?.symbol || "ETH";
  const usd = price.toUsd(bal.sa.value);
  const change = price.change24h;
  const hasChange = typeof change === "number" && Number.isFinite(change);
  const up = hasChange && change >= 0;

  return (
    <div class="relative w-full bg-bg-card overflow-hidden">
      {/* Diagonal sheen (Figma 37:17013) */}
      <div
        class="absolute inset-0 opacity-15 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(128.9deg, var(--color-bg-card) 0%, var(--color-border-light) 25%, var(--color-bg-card) 50%)",
        }}
      />

      <Tabs active={tab} onChange={onTab} />

      {tab === "assets" ? (
        <div class="relative border border-border-light border-t-0">
          <TokenAssetsTab />
        </div>
      ) : (
        <div class="relative border border-border-light border-t-0 flex flex-col">
          {/* TOTAL BALANCE + 24h trend */}
          <div class="flex items-center justify-between pt-4 px-4">
            <div class="flex items-center gap-1.5">
              <span class="w-[3px] h-3.5 bg-blue shrink-0" />
              <span class="type-label-special text-text-muted">Total Balance</span>
            </div>
            {/* {hasChange && (
              <div class={"flex items-center gap-0.5 " + (up ? "text-green" : "text-red")}>
                <span class="type-label-sm">
                  {up ? "+" : ""}{change.toFixed(1)}% (24H)
                </span>
                <TrendArrow up={up} />
              </div>
            )} */}
          </div>

          {/* Balance + chart */}
          <div class="relative flex flex-col gap-1 px-4 pt-2 pb-4 min-h-[137px]">
            <button
              onClick={() => bal.refresh()}
              title="Tap to refresh"
              class="relative z-10 self-start text-left bg-transparent border-none p-0 cursor-pointer flex items-end gap-1"
            >
              {bal.loading.value ? (
                <span class="inline-block h-[42px] w-40 rounded-md bg-white/20 animate-pulse" />
              ) : (
                <span class="type-display-hero text-text-primary">{bal.sa.value}</span>
              )}
              <span class="type-display-title text-text-dim pb-1">{symbol}</span>
            </button>
            <span class="relative z-10 type-label-md text-text-muted">
              ${usd ?? "0.00"} USD
            </span>
            <img
              src="/Vector5.png"
              alt=""
              class="absolute left-0 right-0 bottom-0 w-full h-[85px] object-cover pointer-events-none select-none z-0"
              draggable={false}
            />
          </div>

          {/* SEND / RECEIVE */}
          <div class="flex gap-4 px-4 pt-[17px] pb-4 border-t border-border-light">
            <button
              type="button"
              onClick={onSend}
              class="flex-1 min-w-0 h-10 rounded-[8px] bg-blue flex items-center justify-center gap-1 cursor-pointer border-none transition-colors duration-150 hover:bg-blue-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <SendIcon />
              <span class="type-label-button text-primary-50">Send</span>
            </button>
            <button
              type="button"
              onClick={onReceive}
              class="flex-1 min-w-0 h-10 rounded-[8px] bg-transparent border border-border-light text-text-muted flex items-center justify-center gap-1 cursor-pointer transition-colors duration-150 hover:bg-white hover:text-blue"
            >
              <ReceiveIcon />
              {/* Colour inherits from the button so icon (currentColor) and
                  label flip to blue together on hover. */}
              <span class="type-label-button">Receive</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
