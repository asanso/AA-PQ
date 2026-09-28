/* ═══════════════════════════════════════════════════════════════════
   fee-preferences.js — user-selected network-fee tier for FORS sends
   ───────────────────────────────────────────────────────────────────
   MetaMask-style gas control. The recap's Network-fee row lets the
   user pick Low / Market / Aggressive (mapped onto Pimlico's
   slow / standard / fast gas-price tiers) or Custom (explicit
   maxFeePerGas + maxPriorityFeePerGas in gwei).

   The choice lives in a signal read by BOTH the Send recap UI (fee
   preview + prefund sufficiency) and sendAndRotateFors at submit time,
   so what the user sees is exactly what gets signed.

   Default = "aggressive" (the wallet's historical fast-tier
   behaviour): FORS is few-time, a stuck op costs a re-sign (q→q+1),
   so we bias toward inclusion. Not persisted across popup sessions on
   purpose — a lowered fee should not silently survive into next week's
   send.

   SPHINCS-signed ops (re-import enroll+send, signing-method toggle)
   keep their own hardcoded over-provisioned fees — the picker does not
   apply there.
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";

/* { tier: "low"|"market"|"aggressive"|"custom",
     maxFeePerGas?: hex string, maxPriorityFeePerGas?: hex string } */
export const sendFeeChoice = signal({ tier: "aggressive" });

export const FEE_TIERS = [
  { key: "low", label: "Low", pimlico: "slow" },
  { key: "market", label: "Market", pimlico: "standard" },
  { key: "aggressive", label: "Aggressive", pimlico: "fast" },
];

export function feeTierLabel(tier) {
  if (tier === "custom") return "Custom";
  return FEE_TIERS.find((t) => t.key === tier)?.label || "Aggressive";
}

/**
 * Resolve the user's choice against a Pimlico getUserOperationGasPrice
 * result ({slow, standard, fast} with BigInt fields). Falls back to
 * fast when the chosen tier is missing or the custom values are
 * malformed — never returns undefined fees.
 */
export function resolveSendFees(feeData) {
  const c = sendFeeChoice.value || {};
  if (c.tier === "custom" && c.maxFeePerGas && c.maxPriorityFeePerGas) {
    try {
      const maxFeePerGas = BigInt(c.maxFeePerGas);
      let maxPriorityFeePerGas = BigInt(c.maxPriorityFeePerGas);
      if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
      if (maxFeePerGas > 0n) return { maxFeePerGas, maxPriorityFeePerGas };
    } catch {
      /* malformed custom → fall through to tier fallback */
    }
  }
  const pim = FEE_TIERS.find((t) => t.key === c.tier)?.pimlico || "fast";
  const t = feeData?.[pim] || feeData?.fast;
  return {
    maxFeePerGas: t.maxFeePerGas,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas,
  };
}
