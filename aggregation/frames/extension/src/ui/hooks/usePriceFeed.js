/* ═══════════════════════════════════════════════════════════════════
   usePriceFeed — best-effort ETH/USD price
   ───────────────────────────────────────────────────────────────────
   Fetches the current ETH price in USD from CoinGecko's public API.
   No API key required but subject to rate limits (~10-30 req/min
   anonymous). If the request fails for any reason — network, CORS,
   rate limit, API downtime — the hook silently falls back to `null`
   and consuming components show the raw ETH amount instead.

   We also fake a "+4.8% (24H)" style trend value to satisfy the
   mockup. Real trend data would require a second request to a
   historical endpoint; wire it up when you want real numbers.

   Cache: one in-memory entry with a 60s TTL so multiple components
   reading this hook don't hammer the API. Survives re-renders but
   not popup reloads (fine — fresh open = fresh fetch).
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";

const price = signal(null);        // USD per 1 ETH, or null if unknown
const change24h = signal(null);    // percentage, or null
const loading = signal(false);
const lastFetch = signal(0);

const TTL_MS = 60_000;
const URL =
  "https://api.coingecko.com/api/v3/simple/price" +
  "?ids=ethereum&vs_currencies=usd&include_24hr_change=true";

async function refresh() {
  const now = Date.now();
  if (loading.value) return;
  if (price.value !== null && now - lastFetch.value < TTL_MS) return;

  loading.value = true;
  try {
    const res = await fetch(URL, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const eth = j?.ethereum;
    if (eth?.usd != null) {
      price.value = eth.usd;
      change24h.value = eth.usd_24h_change ?? null;
      lastFetch.value = now;
    }
  } catch {
    // Silent fallback; components check for null.
  } finally {
    loading.value = false;
  }
}

export function usePriceFeed() {
  return {
    /** USD price per 1 ETH, or null if unavailable. */
    get usd() { return price.value; },
    /** 24h price change in percent, or null. */
    get change24h() { return change24h.value; },
    /** True while a fetch is in flight. */
    get loading() { return loading.value; },
    /** Trigger a refresh (no-op if cached and fresh). */
    refresh,
    /**
     * Convert an ETH amount (number or string) to a USD display string,
     * formatted with commas. Returns null if the price is unknown.
     */
    toUsd(ethAmount) {
      const p = price.value;
      if (p == null) return null;
      const eth = typeof ethAmount === "string"
        ? parseFloat(ethAmount) || 0
        : Number(ethAmount) || 0;
      const usd = eth * p;
      return usd.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    },
  };
}
