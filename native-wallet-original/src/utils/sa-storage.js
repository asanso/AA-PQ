/* ═══════════════════════════════════════════════════════════════════
   sa-storage.js — per-chain SmartAccount address storage
   ───────────────────────────────────────────────────────────────────
   Why a dedicated module:
     The smart-account address is a CREATE2 derivation of
     (factory, owner, salt, mode). Each chain has its OWN factory
     deployment, so the same seed+mode produces a different SA on
     every chain. A single global "SmartAccount" key in storage —
     which the wallet used previously — silently corrupts as soon as
     the user touches more than one chain (the cached address comes
     from chain A but is being used against chain B's factory →
     EntryPoint AA14, "Smart account mismatch", or worse, signing
     against the wrong account).

     This module persists a per-chain mapping and exposes a tiny API
     so call sites can never leak the chain-id from their context.

   Storage shape:
     - chrome.storage.local["nt_sa_<chainId>"]  — clear-text mirror
       of the SA address for chain <chainId>. Read by the background
       service worker (which runs while the vault is locked) and by
       early popup boot before the vault has been decrypted.
     - vault.meta.smartAccountAddresses        — encrypted map
       { [chainId]: address } owned by VaultManager. The clear mirror
       is rebuilt from this on every persist so the two never diverge.
     - vault.meta.rotationIndices              — encrypted map
       { [chainId]: number } of per-chain HD rotation index. Each
       deployment counts its rotations independently.

   Legacy (pre-multichain) keys still recognised on read:
     - chrome.storage.local["SmartAccount"]    — single string
     - vault.meta.smartAccountAddress          — single string
     - vault.meta.rotationIndex                — single number
     migrateLegacySmartAccount() is called by VaultManager on unlock
     to fold these into the per-chain maps and remove the legacy keys.
   ═══════════════════════════════════════════════════════════════════ */

import { storageGet, storageSet, storageRemove } from "./storage.js";

/* Chrome-storage key prefix. The chainId is appended verbatim
   (e.g. "nt_sa_0xaa36a7"). Lower-case the chainId on read/write to
   stay tolerant of upstream sources (dApps, viem) that capitalise
   hex digits — chrome.storage is case-sensitive. */
const KEY_PREFIX = "nt_sa_";

/* All-accounts mirror prefix: "nt_all_sa_<chainId>" = array of every
   SA address (lower-cased) the user owns on that chain across all
   multi-accounts. Read by the background incoming-tx poller so that
   receives to inactive accounts are picked up too. */
const ALL_KEY_PREFIX = "nt_all_sa_";

function key(chainId) {
  if (!chainId) throw new Error("sa-storage: chainId required");
  return KEY_PREFIX + String(chainId).toLowerCase();
}

function allKey(chainId) {
  if (!chainId) throw new Error("sa-storage: chainId required");
  return ALL_KEY_PREFIX + String(chainId).toLowerCase();
}

/* ── Clear-text mirror (used by background SW + locked-vault paths) ── */

export async function getCachedSmartAccount(chainId) {
  return storageGet(key(chainId));
}

export async function setCachedSmartAccount(chainId, address) {
  if (!address) return removeCachedSmartAccount(chainId);
  return storageSet(key(chainId), address);
}

export async function removeCachedSmartAccount(chainId) {
  return storageRemove([key(chainId)]);
}

/* Snapshot every per-chain mirror in clear storage. Used by migrators
   and by debug tools. Returns { [chainId]: address }. */
export async function getAllCachedSmartAccounts() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const out = {};
      if (all && typeof all === "object") {
        for (const k of Object.keys(all)) {
          if (k.startsWith(KEY_PREFIX)) {
            out[k.slice(KEY_PREFIX.length)] = all[k];
          }
        }
      }
      resolve(out);
    });
  });
}

/* Wipe every per-chain mirror. Called on deleteVault. */
export async function clearAllCachedSmartAccounts() {
  const all = await getAllCachedSmartAccounts();
  const keys = Object.keys(all).map((cid) => KEY_PREFIX + cid);
  if (keys.length === 0) return;
  return storageRemove(keys);
}

/* ── All-accounts mirror ────────────────────────────────────────────
   Persists the union of every multi-account's SA addresses per chain
   in clear storage, so the background SW can iterate every SA the
   user owns (not just the active one) when polling for incoming txs.

   Input shape: { [chainId]: [addr0, addr1, ...] }. Empty arrays /
   missing chains are removed. Addresses are lower-cased and deduped. */
export async function syncAllAccountsMirror(perChainAddrs) {
  const cur = await getAllAccountsMirror();
  const next = perChainAddrs || {};
  const toSet = {};
  const toRemove = [];

  for (const [cidRaw, list] of Object.entries(next)) {
    const cid = String(cidRaw).toLowerCase();
    const uniq = Array.from(
      new Set(
        (Array.isArray(list) ? list : [])
          .filter((a) => typeof a === "string" && a)
          .map((a) => a.toLowerCase()),
      ),
    );
    if (uniq.length > 0) toSet[ALL_KEY_PREFIX + cid] = uniq;
  }
  /* Remove mirrors for chains that no longer appear in the input. */
  for (const cid of Object.keys(cur)) {
    if (!toSet[ALL_KEY_PREFIX + cid]) toRemove.push(ALL_KEY_PREFIX + cid);
  }

  const writes = [];
  if (Object.keys(toSet).length > 0) {
    writes.push(new Promise((r) => chrome.storage.local.set(toSet, r)));
  }
  if (toRemove.length > 0) writes.push(storageRemove(toRemove));
  return Promise.all(writes);
}

/* Read every "nt_all_sa_<chainId>" mirror. Returns { [chainId]: [addr] }. */
export async function getAllAccountsMirror() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (all) => {
      const out = {};
      if (all && typeof all === "object") {
        for (const k of Object.keys(all)) {
          if (k.startsWith(ALL_KEY_PREFIX) && Array.isArray(all[k])) {
            out[k.slice(ALL_KEY_PREFIX.length)] = all[k];
          }
        }
      }
      resolve(out);
    });
  });
}

/* Wipe every all-accounts mirror. Called on deleteVault. */
export async function clearAllAccountsMirror() {
  const all = await getAllAccountsMirror();
  const keys = Object.keys(all).map((cid) => ALL_KEY_PREFIX + cid);
  if (keys.length === 0) return;
  return storageRemove(keys);
}

/* ── Reconcile cached mirrors with the encrypted vault map ──────────
   Source-of-truth is the vault. After a vault persist (or a chain
   switch that re-derives the SA), call this to overwrite the clear
   mirrors so the background SW sees the same map.

   The function is additive: it sets the keys present in `map` and
   removes mirror keys that are no longer in `map`. */
export async function syncCachedFromVault(map) {
  const cur = await getAllCachedSmartAccounts();
  const next = map || {};
  const toSet = {};
  const toRemove = [];

  for (const [cid, addr] of Object.entries(next)) {
    if (addr) toSet[KEY_PREFIX + String(cid).toLowerCase()] = addr;
  }
  for (const cid of Object.keys(cur)) {
    if (!next[cid]) toRemove.push(KEY_PREFIX + cid);
  }

  const writes = [];
  if (Object.keys(toSet).length > 0) {
    writes.push(
      new Promise((r) => chrome.storage.local.set(toSet, r)),
    );
  }
  if (toRemove.length > 0) writes.push(storageRemove(toRemove));
  return Promise.all(writes);
}

/* ── Legacy-key migration ────────────────────────────────────────────
   Pre-multichain wallets stored a single SmartAccount in clear and a
   single smartAccountAddress + rotationIndex inside the vault. We can
   recover the "home chain" of the legacy address by querying every
   known factory (predictAccountAddress) and picking the chain whose
   counterfactual matches.

   Inputs:
     - legacy: { smartAccountAddress, rotationIndex }
     - networks: array of network records with `accountFactory`
     - probe(network, ownerForMode): async (net, owner, mode) → 0x...
       Returns the predicted address for that network. Caller passes
       a closure bound to the unlocked owner so this module stays
       free of crypto deps.

   Output: { migratedMap, migratedIndices, homeChainId? }
     - migratedMap: { [chainId]: address } — at most one entry
     - migratedIndices: { [chainId]: number }
     - homeChainId: chainId where the legacy address was matched, or
       undefined if no match was found (caller decides what to do).

   The function is best-effort: any RPC failure on a candidate chain
   is swallowed and that chain is skipped. */
export async function detectLegacyHomeChain({
  legacyAddress,
  networks,
  probe,
}) {
  if (!legacyAddress) return { homeChainId: null };
  const target = legacyAddress.toLowerCase();

  for (const net of networks) {
    if (!net?.accountFactory) continue;
    /* Try every (mode 0/1/2) on each chain. The legacy field doesn't
       record which mode the wallet was using, so we brute-force. The
       cost is at most 3 reads per chain — cheap, runs once. */
    for (const mode of [0, 1, 2]) {
      try {
        const predicted = await probe(net, mode);
        if (
          predicted &&
          predicted.toLowerCase() === target
        ) {
          return { homeChainId: net.chainId, mode };
        }
      } catch {
        /* swallow — RPC down or factory not reachable on that chain */
      }
    }
  }
  return { homeChainId: null };
}
