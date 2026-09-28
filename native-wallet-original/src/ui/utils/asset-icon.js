/* ═══════════════════════════════════════════════════════════════════
   asset-icon.js — URL helpers for native + ERC-20 token icons
   ───────────────────────────────────────────────────────────────────
   Pure URL-builder helpers, no network calls and no caching. They
   return a deterministic URL pointing at TrustWallet's public asset
   CDN; the consuming <TokenIcon> component does the actual <img>
   load and falls back to a blue circle on error / 404.

   Why TrustWallet:
     - Public, CDN-fronted GitHub raw URL — no API key, no rate limit
     - Coverage matches mainnet ERC-20s by checksummed address
     - Consistent square PNG logos sized for a circle crop

   The trustwallet directory per chain comes from `iconKey` on the
   NETWORKS record (src/config/networks.js). Sepolia-family testnets
   map to the ethereum mainnet directory: native ETH logo
   applies regardless, and any imported testnet ERC-20 with a
   different address from its mainnet counterpart will simply 404 and
   fall back to the placeholder. That matches the spec — "if the icon
   doesn't exist, leave the blue circle".
   ═══════════════════════════════════════════════════════════════════ */

import { getAddress } from "viem";
import { getIconKey } from "@/config/networks.js";

const TW_BASE =
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

function isIpLiteral(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!isIpLiteral(host)) return false;

  if (host.includes(":")) return true;
  const parts = host.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function sanitizeExternalIconUrl(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (isBlockedHost(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Native asset logo. The native token is ETH on every supported chain,
    so the asset list / send screen always show the Ethereum logo
    regardless of chainId. (The per-chain L2 logos are reserved for the
    network picker — see chainLogoUrl.) */
export const ETH_LOGO_URL = `${TW_BASE}/ethereum/info/logo.png`;
export function nativeIconUrl(_chainId) {
  return ETH_LOGO_URL;
}

/** Per-chain network logo (Ethereum / Base / Arbitrum / Optimism …),
    from the chain's `iconKey`. Used by the network picker rows. */
export function chainLogoUrl(chainId) {
  return `${TW_BASE}/${getIconKey(chainId)}/info/logo.png`;
}

/** ERC-20 token logo URL for a given chainId + contract address.
    Returns null if the address is missing or fails checksum encoding. */
export function tokenIconUrl(chainId, address) {
  if (!address) return null;
  let checksum;
  try {
    checksum = getAddress(address);
  } catch {
    return null;
  }
  return `${TW_BASE}/${getIconKey(chainId)}/assets/${checksum}/logo.png`;
}

/**
 * Best-guess favicon URL for a dApp origin (e.g. "https://app.uniswap.org").
 * Uses Google's public S2 favicon CDN — it handles HTML parsing of the
 * site's <link rel="icon"> tags and serves a normalized PNG. Returns
 * null if the origin can't be parsed; the consumer should fall back
 * to the blue circle placeholder in that case.
 */
export function dappIconUrl(origin, size = 128) {
  if (!origin || typeof origin !== "string") return null;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    // Maybe we got a bare host already.
    host = origin.replace(/^https?:\/\//, "").split("/")[0];
  }
  if (!host) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}
