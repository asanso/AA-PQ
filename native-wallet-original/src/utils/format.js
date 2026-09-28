export function truncateAddress(addr) {
  return addr ? addr.slice(0, 8) + "\u2026" + addr.slice(-6) : "\u2014";
}

export function timestamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

/* Build the explorer URL for a tx hash or address.
   Chain selection rules, in order:
     1. explicit `chainId` arg — used by tx history, where each entry
        records the chain it was made on (so a tx opens the explorer of
        the chain it was made on, even after the user switches chain).
     2. globalThis.__NT_CHAIN_ID — current active chain, mirror of the
        `chainId` signal kept in sync by store.js.
     3. Daisugi fallback if everything else is missing (defensive — should
        never hit in normal operation since chainId is hydrated at boot).
*/
import { NETWORKS, DEFAULT_CHAIN_ID, DAISUGI_EXPLORER_URL } from "@/config/networks.js";

const EXPLORER_FALLBACK = DAISUGI_EXPLORER_URL;

export function explorerUrl(hashOrAddr, type = "tx", chainId) {
  const id = chainId || globalThis.__NT_CHAIN_ID || DEFAULT_CHAIN_ID;
  const base = NETWORKS[id]?.blockExplorer || EXPLORER_FALLBACK;
  const route = type === "address" ? "address" : type === "op" ? "op" : "tx";
  if (NETWORKS[id]?.explorerHashRouting) return `${base}/#${route}/${hashOrAddr}`;
  return `${base}/${route}/${hashOrAddr}`;
}

// Native activities link to the actual transaction hash.
export function activityExplorerUrl(tx) {return tx?.txHash ? explorerUrl(tx.txHash,'tx',tx.chainId) : undefined;}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}
