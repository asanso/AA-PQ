/* ═══════════════════════════════════════════════════════════════════
   useTokens — imported ERC-20 token registry + balances
   ───────────────────────────────────────────────────────────────────
   Lives alongside useBalance: that one tracks the native ETH balance,
   this one tracks user-imported ERC-20 tokens.

   Two signals, both persisted per (smartAddr, chainId) tuple in
   chrome.storage.local:

     tokens   — Array<{ address, symbol, name, decimals, chainId }>
     balances — { [tokenAddress.toLowerCase()]: "0.123456" }

   Persistence pattern mirrors src/ui/persistence/tx-persistence.js:
   one effect for load (reacts to smartAddr+chainId), one for write
   (reacts to tokens). Balances are NOT persisted — they're refetched
   on mount and after each send.

   Public API:
     const t = useTokens();
     t.list                    // signal: imported tokens
     t.balances                // signal: { addrLower: amount }
     t.add({ address, ... })   // dedup-aware add
     t.remove(address)
     t.refresh()               // re-fetch all balances on-chain
   ═══════════════════════════════════════════════════════════════════ */

import { signal, effect } from "@preact/signals";
import { smartAddr, chainId } from "@/ui/store.js";
import { fetchErc20Balance } from "@/blockchain/erc20.js";

const tokens = signal([]);
const balances = signal({});

let suspendWrites = false;
let installed = false;

function storageKeyFor(addr, cid) {
  if (!addr || !cid) return null;
  return `nt_tokens_${addr.toLowerCase()}_${cid}`;
}

function readFromStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => {
      const v = res?.[key];
      resolve(Array.isArray(v) ? v : []);
    });
  });
}

function writeToStorage(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

export function installTokenPersistence() {
  if (installed) return;
  installed = true;

  /* ── Load effect: reacts to (smartAddr, chainId) ──────────────── */
  effect(() => {
    const addr = smartAddr.value;
    const cid = chainId.value;
    const key = storageKeyFor(addr, cid);
    if (!key) return;

    (async () => {
      suspendWrites = true;
      try {
        const stored = await readFromStorage(key);
        tokens.value = stored;
        balances.value = {};
      } finally {
        suspendWrites = false;
      }
    })();
  });

  /* ── Write effect: reacts to tokens ───────────────────────────── */
  effect(() => {
    const items = tokens.value;
    const addr = smartAddr.value;
    const cid = chainId.value;
    const key = storageKeyFor(addr, cid);

    if (suspendWrites) return;
    if (!key) return;

    writeToStorage(key, items).catch((e) => {
      console.warn("[NiceTry] token-persistence write failed:", e);
    });
  });
}

async function refreshAll() {
  const addr = smartAddr.value;
  if (!addr) return;
  const list = tokens.value;
  if (list.length === 0) {
    balances.value = {};
    return;
  }

  const next = { ...balances.value };
  await Promise.all(
    list.map(async (t) => {
      try {
        const formatted = await fetchErc20Balance(t.address, addr, t.decimals);
        next[t.address.toLowerCase()] = formatted;
      } catch {
        next[t.address.toLowerCase()] = "0.000000";
      }
    })
  );
  balances.value = next;
}

export function useTokens() {
  return {
    list: tokens,
    balances,
    add(token) {
      const lower = token.address.toLowerCase();
      const exists = tokens.value.some((t) => t.address.toLowerCase() === lower);
      if (exists) return false;
      tokens.value = [...tokens.value, token];
      return true;
    },
    remove(address) {
      const lower = address.toLowerCase();
      tokens.value = tokens.value.filter((t) => t.address.toLowerCase() !== lower);
      const next = { ...balances.value };
      delete next[lower];
      balances.value = next;
    },
    refresh: refreshAll,
  };
}
