/* ═══════════════════════════════════════════════════════════════════
   erc20.js — minimal ERC-20 read helpers
   ───────────────────────────────────────────────────────────────────
   Used by the token-import flow (metadata) and by useTokens (balance
   refresh). Read-only — never sends transactions. The actual sending
   path is the existing rotation modules, which are ETH-only for now.

   All functions throw on invalid contracts so the UI can present a
   clear error to the user. We deliberately don't catch here.
   ═══════════════════════════════════════════════════════════════════ */

import { encodeFunctionData, formatUnits, parseUnits } from "viem";
import { publicClient } from "./client.js";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

const ERC20_METADATA_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
];

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

export async function fetchErc20Metadata(tokenAddress) {
  const [name, symbol, decimals] = await Promise.all([
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_METADATA_ABI,
      functionName: "name",
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_METADATA_ABI,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
    }),
  ]);
  return { name, symbol, decimals: Number(decimals) };
}

/* Non-standard "icon URL" extensions some ERC-20 contracts implement
   alongside name/symbol/decimals. Tried opportunistically — most
   tokens won't expose these and the calls revert silently. */
const ERC20_ICON_ABI = [
  { name: "iconURI", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "logoURI", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "logoUri", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "logo",    type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

/**
 * Best-effort on-chain icon URL fetch. Tries a handful of non-standard
 * getter names that some token contracts expose. Returns the first
 * non-empty string found, or null if none of them work.
 *
 * Never throws — the caller can fall back to an off-chain CDN URL.
 */
export async function fetchErc20IconUrl(tokenAddress) {
  const fns = ["iconURI", "logoURI", "logoUri", "logo"];
  for (const fn of fns) {
    try {
      const v = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ICON_ABI,
        functionName: fn,
      });
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // Function doesn't exist on this contract — try the next one.
    }
  }
  return null;
}

export async function fetchErc20BalanceRaw(tokenAddress, owner) {
  const raw = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  return raw;
}

/** Returns a 6-decimal display string (matches useBalance formatting). */
export async function fetchErc20Balance(tokenAddress, owner, decimals) {
  const raw = await fetchErc20BalanceRaw(tokenAddress, owner);
  const formatted = formatUnits(raw, decimals);
  return Number(formatted).toFixed(6);
}

/** Convert a human amount to its uint256 raw value using `decimals`. */
export function parseTokenAmount(amount, decimals) {
  return parseUnits(String(amount || "0"), decimals);
}

/** ABI-encode `transfer(to, value)` — calldata for the smart-account
    `execute(target=tokenAddress, value=0, data=<this>)` path. */
export function encodeErc20Transfer(to, rawValue) {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, rawValue],
  });
}
