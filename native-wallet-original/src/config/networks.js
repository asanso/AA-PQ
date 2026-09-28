// Daisugi-only experimental build. No public/mainnet fallback is enabled.
import { defineChain } from "viem";
import { DEFAULT_CHAIN_ID } from "./chain-defaults.js";
const FACTORY_PLACEHOLDER = "__FACTORY_NOT_DEPLOYED__";
const LEGACY_FACTORY = "0x0000000000000000000000000000000000000000";
// Build-time endpoints are explicit. No local or public fallback is enabled.
export const DAISUGI_RPC_URL = typeof __DAISUGI_RPC_URL__ !== 'undefined' ? __DAISUGI_RPC_URL__ : "";
export const DAISUGI_EXPLORER_URL = typeof __DAISUGI_EXPLORER_URL__ !== 'undefined' ? __DAISUGI_EXPLORER_URL__ : '';
const daisugi = defineChain({
  id: 1337, name: "Daisugi Testnet", nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DAISUGI_RPC_URL] } },
  blockExplorers: { default: { name: "Daisugi", url: DAISUGI_EXPLORER_URL } }, testnet: true,
});
export const NETWORKS = {
  "0x539": {
    chainId: "0x539", networkId: 1337, name: "Daisugi Testnet", shortName: "DAISUGI",
    symbol: "ETH", decimals: 18, testnet: true, blockTimeSec: 2,
    rpcUrl: DAISUGI_RPC_URL, rpcFallbacks: [],
    blockExplorer: DAISUGI_EXPLORER_URL, explorerHashRouting: false, viemChain: daisugi,
    genesisHash: "0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55",
    accountFactory: "0xd07fcbdca6dea83b523faf95386cea236e32d989",
    accountImplementation: "0xFec328C1725F6Ef48160053E14379865aEc07568",
    sphincsVerifier: "0xf505AD2Cff58b84E145D637d99Fae0617B5685BE",
    sphincs: true, sphincsProfile: "sphincs-g",
    priorityFeeWei: 1_000_000_000n, maxFeeCapWei: 3_000_000_000n,
    badge: "EXPERIMENTAL TESTNET", description: "SPHINCS-G native frame transactions. Test ETH only.",
    iconKey: "ethereum", hidden: false,
  },
};

export { DEFAULT_CHAIN_ID };
export const FACTORY_PLACEHOLDER_VALUE = FACTORY_PLACEHOLDER;
export const LEGACY_FACTORY_ADDRESS = LEGACY_FACTORY;

export function isFactoryDeployed(net) {
  return !!net && net.accountFactory !== FACTORY_PLACEHOLDER_VALUE;
}

// Display-name overrides do not change the pinned network identity.
function withOverrides(net) {
  if (!net) return net;
  const name = globalThis.__NT_CHAIN_NAMES?.[net.chainId];
  return typeof name === 'string' && name ? { ...net, name } : net;
}

export function getNetwork(chainId) {
  return withOverrides(NETWORKS[chainId] || null);
}

/* Canonical (un-renamed) name for a chain — used by the rename editor to
   show the default and to detect "reset to default". */
export function getCanonicalNetworkName(chainId) {
  return NETWORKS[chainId]?.name || null;
}

/* Source of truth for non-React code (transactions, blockchain clients)
   that needs to know the active chain without subscribing to a signal.
   The popup/onboarding boot mirrors `chainId` signal → __NT_CHAIN_ID, and
   ChooseChain sets it before calling deploySmartAccount. */
export function getActiveNetwork() {
  const id = globalThis.__NT_CHAIN_ID || DEFAULT_CHAIN_ID;
  if (!NETWORKS[id]) throw new Error("Daisugi-only build: use a fresh extension profile and select chain 1337.");
  return withOverrides(NETWORKS[id]);
}

// The native account uses the SPHINCS-G profile.
export function isSphincsChain(net) {
  return !!net && net.sphincs === true;
}

/* List of networks suitable for the onboarding ChooseChain row, in
   insertion order. Filters out anything flagged `hidden`. Each consumer
   can decide whether to also filter on `isFactoryDeployed` — ChooseChain
   shows un-deployed chains with a red label so the user understands the
   "coming soon" state instead of silently hiding them. */
export function listVisibleNetworks() {
  return Object.values(NETWORKS)
    .filter((n) => !n.hidden)
    .map(withOverrides);
}

/* Trustwallet blockchain directory for a given chainId. Used by
   asset-icon.js to build native + ERC-20 logo URLs. Falls back to
   "ethereum" for unknown chains so we still produce a valid URL (the
   image will simply 404 and the consumer's onError fallback fires). */
export function getIconKey(chainId) {
  return NETWORKS[chainId]?.iconKey || "ethereum";
}

// Use one configured network endpoint. Never fall back to a different chain.
export function getRpcUrls(net) {
  if (!net) return [];
  const primary = net.rpcUrl ? [net.rpcUrl] : [];
  const fallbacks = Array.isArray(net.rpcFallbacks) ? net.rpcFallbacks : [];
  const base = [...primary, ...fallbacks];

  // An explicit override replaces the default endpoint entirely.
  const custom = net.chainId ? globalThis.__NT_CUSTOM_RPC?.[net.chainId] : null;
  if (custom && typeof custom === "string") {
    return [custom];
  }
  return base;
}

/* ── User custom RPC override (Settings → Network) ─────────────────────
   Persisted as a per-chain map in chrome.storage.local under
   CUSTOM_RPC_STORAGE_KEY: { [chainId]: "https://…" }. Mirrored to the
   synchronous globalThis.__NT_CUSTOM_RPC so getRpcUrls() (sync; called by
   the viem clients AND the background fetch proxy) can use it without
   an async storage read.

   hydrateCustomRpc() MUST run at boot in every context that builds RPC
   clients — popup, onboarding, and the background SW — mirroring how
   hydrateChainId seeds __NT_CHAIN_ID. The background also re-hydrates on a
   chrome.storage.onChanged tick so a change made in the popup propagates
   to the SW's own globalThis. */
export const CUSTOM_RPC_STORAGE_KEY = "nt_customRpc";

export async function hydrateCustomRpc() {
  try {
    const res = await chrome.storage.local.get([CUSTOM_RPC_STORAGE_KEY]);
    const map = res?.[CUSTOM_RPC_STORAGE_KEY];
    globalThis.__NT_CUSTOM_RPC = map && typeof map === "object" ? map : {};
  } catch {
    globalThis.__NT_CUSTOM_RPC = globalThis.__NT_CUSTOM_RPC || {};
  }
  return globalThis.__NT_CUSTOM_RPC;
}

export function getCustomRpc(chainId) {
  return globalThis.__NT_CUSTOM_RPC?.[chainId] || null;
}

/* Set (url truthy) or clear (url null/empty) the custom RPC for one chain.
   Updates the sync mirror immediately and persists the per-chain map.
   Returns the new map. The caller must invalidate any memoized client for
   that chain (blockchain/client.js → resetPublicClient) so the next call
   rebuilds the transport with the new endpoint. */
export async function setCustomRpc(chainId, url) {
  const next = { ...(globalThis.__NT_CUSTOM_RPC || {}) };
  // Storing the built-in default as a "custom" value is redundant — treat
  // it as a clear so the chain falls back to the shipped endpoint list.
  if (url && url !== NETWORKS[chainId]?.rpcUrl) next[chainId] = url;
  else delete next[chainId];
  globalThis.__NT_CUSTOM_RPC = next;
  try {
    await chrome.storage.local.set({ [CUSTOM_RPC_STORAGE_KEY]: next });
  } catch {}
  return next;
}

/* ── User custom chain NAME override (chain ⋮ → Edit) ───────────────────
   Per-chain map { [chainId]: "My Daisugi" } persisted under
   CUSTOM_NAME_STORAGE_KEY, mirrored to globalThis.__NT_CHAIN_NAMES so
   withOverrides() (sync, in getNetwork) can rename the chain everywhere it
   is displayed. Only the popup/onboarding UI shows names, so the SW does
   not hydrate this — getNetwork there just returns the canonical name. */
export const CUSTOM_NAME_STORAGE_KEY = "nt_customChainNames";

export async function hydrateCustomChainNames() {
  try {
    const res = await chrome.storage.local.get([CUSTOM_NAME_STORAGE_KEY]);
    const map = res?.[CUSTOM_NAME_STORAGE_KEY];
    globalThis.__NT_CHAIN_NAMES = map && typeof map === "object" ? map : {};
  } catch {
    globalThis.__NT_CHAIN_NAMES = globalThis.__NT_CHAIN_NAMES || {};
  }
  return globalThis.__NT_CHAIN_NAMES;
}

export function getCustomChainName(chainId) {
  return globalThis.__NT_CHAIN_NAMES?.[chainId] || null;
}

/* Set (name truthy & different from canonical) or clear the custom name
   for one chain. Persists + updates the sync mirror. Returns the new map. */
export async function setCustomChainName(chainId, name) {
  const next = { ...(globalThis.__NT_CHAIN_NAMES || {}) };
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed && trimmed !== NETWORKS[chainId]?.name) next[chainId] = trimmed;
  else delete next[chainId];
  globalThis.__NT_CHAIN_NAMES = next;
  try {
    await chrome.storage.local.set({ [CUSTOM_NAME_STORAGE_KEY]: next });
  } catch {}
  return next;
}
