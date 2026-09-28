/* ═══════════════════════════════════════════════════════════════════
   chain-defaults.js — viem-free chain defaults
   ───────────────────────────────────────────────────────────────────
   This module deliberately avoids importing from viem so it can be
   pulled into bundles where viem is unwanted (the inpage provider
   that runs inside dApp pages, where every byte counts).

   `networks.js` is the SINGLE SOURCE OF TRUTH for everything else
   (factories, RPCs, bundlers, explorers). It re-exports the
   constants from this file so the chain-id default is defined ONCE.
   ═══════════════════════════════════════════════════════════════════ */

/** Hex chainId used when no chain has been picked yet (or when the
    user hasn't completed onboarding). Update this single value to
    change the default chain everywhere — popup boot, background SW
    boot, dApp-injected provider boot. */
export const DEFAULT_CHAIN_ID = "0x539"; // Daisugi private testnet
