/* Fee controls retained from the original interface. This SPHINCS build
   supplies no editable fee tiers: it displays a fixed maximum reserve
   computed for the selected transaction mode. */

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
