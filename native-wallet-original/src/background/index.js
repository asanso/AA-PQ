import { directTransfers } from '../native-frame/transfers.js';
import {
  getNetwork,
  NETWORKS,
  DEFAULT_CHAIN_ID,
  getRpcUrls,
  hydrateCustomRpc,
  CUSTOM_RPC_STORAGE_KEY,
} from "../config/networks.js";
import { scanWindow } from "../blockchain/scan-window.js";


/* SW-wide mutable state. Declared at the very top of the module so
   that any function (including the incoming-tx poller, which kicks
   off synchronously at module init) can reference these vars without
   hitting the `let` temporal dead zone. The hydration from
   chrome.storage happens further down via awaitChainIdHydrated. */
let currentChainId = DEFAULT_CHAIN_ID;
let connectedAccounts = {};
let pendingRequests = {};
let sessionTimer = null;

/* Approval-request IDs are part of the popup URL hash and of the
   GET_PENDING / APPROVAL_RESULT message surface; they must be
   unguessable so no other context can enumerate or race them. */
function newPendingId() {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
let signingLock = null;
let signingLockAcquireQueue = Promise.resolve();

/* ── Incoming-tx poller (background) ──────────────────────────────
   Scans new blocks via the same RPC URL we proxy provider calls to,
   filters transactions whose `to` is the user's smart account, and
   appends them to nt_txhistory_<addr>_<chainId> in storage. The popup-side
   tx-persistence load effect surfaces the entries on next unlock.

   Runs on a chrome.alarms tick (every ~1 min) so transfers that
   arrive while the wallet is closed are still captured. Coordinates
   with the popup-side poller via the same nt_lastSeenBlock_<addr>_<chainId>
   checkpoint and dedupes by txHash. */

/* The scan window is sized per chain from blockTimeSec — see
   blockchain/scan-window.js. A fixed block count kept the SW ~40 blocks
   behind Base's head on every 3-minute tick until the stale-cursor reset
   silently threw the gap away.

   Concurrency is high because rpcBatchGetBlocks() folds the whole chunk
   into ONE JSON-RPC array request, so this is a batch size, not a count
   of simultaneous HTTP connections. */
const INCOMING_BLOCK_CONCURRENCY = 24;
const INCOMING_HISTORY_CAP = 200;
const INCOMING_ALARM_NAME = "nt_incoming_poll";



          // array of watch entries
 // map keyed by `<saAddr>_<chainId>`


/* The popup session stores the DERIVED vault key (see
   src/popup/session.js), never the raw password. The legacy key name
   ("nt_session_pw") is kept only so lock/expiry wipes also clear any
   plaintext password left behind by a pre-upgrade install. */
const SESSION_KEY_KEY = "nt_session_key";
const LEGACY_SESSION_PASSWORD_KEY = "nt_session_pw";
const SESSION_EXPIRY_KEY = "nt_session_expires_at";
const SESSION_ALARM_NAME = "nt_session_lock";
const SIGNING_LOCK_KEY = "nt_signing_lock";
const SIGNING_LOCK_MAX_TTL_MS = 5 * 60 * 1000;
const SIGNING_LOCK_MIN_TTL_MS = 30 * 1000;
/* Was 1 minute. Bumped to 3 because (a) the popup-side poller covers
   the foreground case and (b) at concurrency 2 / 50 blocks max we
   make at most 25 RPC calls per tick — three minutes spaces those
   bursts comfortably under any free-tier RPC budget. */
const INCOMING_ALARM_PERIOD_MIN = 3;

/* Keys include the active chainId: the SA address is identical on every
   supported chain, so per-address-only keys would collide between chains
   (a foreign chain's block cursor would hide incoming txs). */
function lastSeenStorageKey(addr, cid) {
  return "nt_lastSeenBlock_" + addr.toLowerCase() + "_" + String(cid).toLowerCase();
}
function backfillCursorStorageKey(addr, cid) {
  return "nt_backfillCursor_" + addr.toLowerCase() + "_" + String(cid).toLowerCase();
}
function backfillTargetStorageKey(addr, cid) {
  return "nt_backfillTarget_" + addr.toLowerCase() + "_" + String(cid).toLowerCase();
}
function txHistoryStorageKey(addr, cid) {
  return "nt_txhistory_" + addr.toLowerCase() + "_" + String(cid).toLowerCase();
}

function timestampOf(epochMs) {
  return new Date(epochMs).toTimeString().slice(0, 8);
}

function formatEthFromWeiHex(hex) {
  try {
    const wei = BigInt(hex || "0x0");
    const whole = wei / 10n ** 18n;
    const frac = wei % 10n ** 18n;
    return `${whole}.${frac.toString().padStart(18, "0").slice(0, 6)}`;
  } catch {
    return "0.000000";
  }
}

function isBgRateLimitError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  if (msg.includes("429")) return true;
  if (msg.includes("rate") && msg.includes("limit")) return true;
  if (msg.includes("too many")) return true;
  return false;
}

/* Scan blocks [fromBlock, toBlock] for incoming transfers. Returns
   { found, highestScanned, throttled }.

   `highestScanned` is the highest CONTIGUOUS block we successfully
   fetched from `fromBlock`. If any block fails (non-rate-limit error
   or null response) we must NOT advance the checkpoint past it — the
   next tick has to retry, otherwise an incoming tx in that block is
   silently lost. */
async function scanIncomingForAddr(target, fromBlock, toBlock) {
  const blockNums = [];
  for (let n = fromBlock; n <= toBlock; n++) blockNums.push(n);

  const found = [];
  const fetched = new Set();
  let earliestFailed = null;
  for (let i = 0; i < blockNums.length; i += INCOMING_BLOCK_CONCURRENCY) {
    const chunk = blockNums.slice(i, i + INCOMING_BLOCK_CONCURRENCY);

    /* One array request for the whole chunk. A total failure (every
       endpoint down, or a 429) is treated like the old per-call rejection:
       stop here and let the caller resume from the last contiguous block. */
    let blocks;
    let throttled = false;
    try {
      blocks = await rpcBatchGetBlocks(chunk);
    } catch (e) {
      throttled = isBgRateLimitError(e);
      blocks = new Array(chunk.length).fill(null);
    }
    const settled = blocks.map((b) =>
      b ? { status: "fulfilled", value: b } : { status: "rejected" },
    );

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const blockNum = chunk[j];
      if (s.status !== "fulfilled" || !s.value) {
        if (earliestFailed == null || blockNum < earliestFailed) {
          earliestFailed = blockNum;
        }
        continue;
      }
      const block = s.value;
      const bn = parseInt(block.number, 16);
      if (Number.isFinite(bn)) fetched.add(bn);
      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      for (const rawTx of txs) {
       if (!rawTx || typeof rawTx !== 'object') continue;
       const potentiallyRelevant = rawTx.to?.toLowerCase()===target || rawTx.frames?.some(frame=>frame.target?.toLowerCase()===target);
       if(!potentiallyRelevant)continue;
       let receipt;
       try { receipt=await rpcCall('eth_getTransactionReceipt',[rawTx.hash]); } catch { continue; }
       for(const tx of directTransfers(rawTx,receipt)) {
        if (!tx || typeof tx !== "object") continue;
        if (!tx.to) continue;
        if (tx.to.toLowerCase() !== target) continue;
        if (tx.from && tx.from.toLowerCase() === target) continue;
        let weiBig;
        try {
          weiBig = BigInt(tx.value || "0x0");
        } catch {
          continue;
        }
        if (weiBig === 0n) continue;
        const ts = parseInt(block.timestamp, 16) * 1000;
        found.push({
          id: ts,
          time: timestampOf(ts),
          txHash: tx.hash,
          frameIndex:tx.frameIndex, status:'confirmed',
          to: tx.to,
          from: tx.from,
          amount: formatEthFromWeiHex(tx.value),
          kind: "receive",
          mode: "SPHINCS",
          blockNumber: bn,
        });
       }
     }
    }

    if (throttled) {
      const highestContiguous = contiguousHighBg(fromBlock, toBlock, fetched, earliestFailed);
      console.warn(
        `[NiceTry bg] 429 from RPC after block ${highestContiguous} — backing off`,
      );
      return { found, highestScanned: highestContiguous, throttled: true };
    }
  }
  const highestScanned = contiguousHighBg(fromBlock, toBlock, fetched, earliestFailed);
  return { found, highestScanned, throttled: false };
}

/* Highest block N in [from, to] such that every block in [from, N] was
   successfully fetched. Returns `from - 1` if `from` itself failed. */
function contiguousHighBg(from, to, fetched, earliestFailed) {
  const ceiling = earliestFailed != null ? earliestFailed - 1 : to;
  let n = from - 1;
  for (let b = from; b <= ceiling; b++) {
    if (!fetched.has(b)) break;
    n = b;
  }
  return n;
}

/* Look up the smart-account address for the active chain. Reads the
   per-chain mirror "nt_sa_<chainId>" populated by the popup whenever
   the vault persists. Falls back to the legacy single-string
   "SmartAccount" key for wallets that haven't been unlocked since the
   per-chain migration ran. */
async function getActiveSmartAccountAddress() {
  const cid = String(currentChainId || DEFAULT_CHAIN_ID).toLowerCase();
  const perChainKey = "nt_sa_" + cid;
  try {
    const stored = await chrome.storage.local.get([perChainKey, "SmartAccount"]);
    if (stored[perChainKey]) return stored[perChainKey].toLowerCase();
    /* Legacy fallback. Don't promote the legacy key into the per-chain
       slot here — that's the popup's job (it owns the encrypted vault
       and knows the home chain). The SW just reads. */
    if (stored.SmartAccount) return stored.SmartAccount.toLowerCase();
  } catch {}
  return null;
}

/* Read every SA the user owns on the active chain — union of all multi-
   accounts. Falls back to the active-only mirror when the all-accounts
   mirror is absent (e.g. vault hasn't been unlocked since this build). */
async function getAllSmartAccountAddressesForActiveChain() {
  const cid = String(currentChainId || DEFAULT_CHAIN_ID).toLowerCase();
  try {
    const allKey = "nt_all_sa_" + cid;
    const stored = await chrome.storage.local.get([allKey]);
    const list = stored[allKey];
    if (Array.isArray(list) && list.length > 0) {
      return Array.from(
        new Set(list.filter((a) => typeof a === "string" && a).map((a) => a.toLowerCase())),
      );
    }
  } catch {}
  const active = await getActiveSmartAccountAddress();
  return active ? [active] : [];
}

/* Poll a single SA on the active chain. Maintains three cursors
   (forward, backfill cursor, backfill target) so the first scan covers
   the MOST RECENT blocks (where a just-landed receive lives) and a
   separate downward walk fills in older history over subsequent ticks.
   Returns nothing — errors are logged. */
async function pollIncomingForOneAddress(smartAccountAddr, latest, cid) {
  try {
    /* Window sized off this chain's block time at the alarm cadence, so the
       forward cursor stays ahead of the head instead of drifting until the
       stale reset throws the gap away. */
    const net = getNetwork(cid) || getNetwork(DEFAULT_CHAIN_ID);
    const {
      maxBlocksPerPoll: INCOMING_MAX_BLOCKS_PER_POLL,
      initialLookback: INCOMING_INITIAL_LOOKBACK,
      keepsUp,
    } = scanWindow(net, INCOMING_ALARM_PERIOD_MIN * 60);
    if (!keepsUp) {
      console.warn(
        `[NiceTry bg] poller cannot keep up with ${net?.name}'s block rate — ` +
          "receives outside the scan window will be missed.",
      );
    }
    const cpKey = lastSeenStorageKey(smartAccountAddr, cid);
    const bcKey = backfillCursorStorageKey(smartAccountAddr, cid);
    const btKey = backfillTargetStorageKey(smartAccountAddr, cid);
    const histKey = txHistoryStorageKey(smartAccountAddr, cid);
    const stored = await chrome.storage.local.get([cpKey, bcKey, btKey, histKey]);
    let forward = typeof stored[cpKey] === "number" ? stored[cpKey] : null;
    let backfillCursor = typeof stored[bcKey] === "number" ? stored[bcKey] : null;
    let backfillTarget = typeof stored[btKey] === "number" ? stored[btKey] : null;
    const existing = Array.isArray(stored[histKey]) ? stored[histKey] : [];
    const writes = {};

    /* Stale-cursor reset (see matching note in incoming-tx-poller.js):
       if forward is way behind latest, treat it as fresh. This SKIPS the
       intervening blocks — never do it silently. */
    if (forward != null && forward < latest - 2 * INCOMING_INITIAL_LOOKBACK) {
      console.warn(
        `[NiceTry bg] cursor ${latest - forward} blocks behind head on ` +
          `${net?.name} — re-anchoring; blocks ${forward + 1}..` +
          `${latest - INCOMING_INITIAL_LOOKBACK} will NOT be scanned.`,
      );
      forward = null;
      backfillCursor = null;
      backfillTarget = null;
    }

    /* First scan ever: anchor the recent window at `latest` so the
       very next phase-1 scan covers [latest - MAX + 1, latest]. The
       backfill cursor then walks downward from there. */
    if (forward == null) {
      forward = Math.max(0, latest - INCOMING_MAX_BLOCKS_PER_POLL);
      backfillCursor = forward;
      backfillTarget = Math.max(0, latest - INCOMING_INITIAL_LOOKBACK);
      writes[cpKey] = forward;
      writes[bcKey] = backfillCursor;
      writes[btKey] = backfillTarget;
    } else if (backfillCursor == null || backfillTarget == null) {
      /* Upgrade path from an older build with no backfill tracking. */
      backfillCursor = forward;
      backfillTarget = Math.max(0, latest - INCOMING_INITIAL_LOOKBACK);
      writes[bcKey] = backfillCursor;
      writes[btKey] = backfillTarget;
    }

    const allFound = [];

    /* ── Phase 1: forward scan ─────────────────────────────────── */
    let phase1Throttled = false;
    if (forward < latest) {
      const fromBlock = forward + 1;
      const toBlock = Math.min(latest, fromBlock + INCOMING_MAX_BLOCKS_PER_POLL - 1);
      const { found, highestScanned, throttled } = await scanIncomingForAddr(
        smartAccountAddr,
        fromBlock,
        toBlock,
      );
      const advance =
        Number.isFinite(highestScanned) && highestScanned >= fromBlock
          ? highestScanned
          : fromBlock - 1;
      if (advance >= fromBlock) writes[cpKey] = advance;
      allFound.push(...found);
      phase1Throttled = throttled;
    }

    /* ── Phase 2: backfill (skip if phase 1 hit 429) ───────────── */
    if (
      !phase1Throttled &&
      backfillCursor != null &&
      backfillTarget != null &&
      backfillCursor > backfillTarget
    ) {
      const toBlock = backfillCursor;
      const fromBlock = Math.max(
        backfillTarget,
        toBlock - INCOMING_MAX_BLOCKS_PER_POLL + 1,
      );
      const { found, highestScanned, throttled } = await scanIncomingForAddr(
        smartAccountAddr,
        fromBlock,
        toBlock,
      );
      allFound.push(...found);

      let nextCursor = fromBlock - 1;
      if (throttled) {
        nextCursor = toBlock; // retry this slice next tick
      } else if (Number.isFinite(highestScanned) && highestScanned < toBlock) {
        // Silent gap inside the slice — resume from there, never skip.
        nextCursor = highestScanned;
      }
      writes[bcKey] = Math.max(backfillTarget - 1, nextCursor);
    }

    /* ── Commit history ─────────────────────────────────────────── */
    const existingHashes = new Set(
      existing
        .map((e) => (e?.txHash ? e.txHash.toLowerCase() : null))
        .filter(Boolean),
    );
    const fresh = allFound.filter(
      (e) => e.txHash && !existingHashes.has(e.txHash.toLowerCase()),
    );
    fresh.sort((a, b) => a.id - b.id);

    if (fresh.length > 0) {
      const merged = [...existing, ...fresh];
      const trimmed =
        merged.length > INCOMING_HISTORY_CAP
          ? merged.slice(merged.length - INCOMING_HISTORY_CAP)
          : merged;
      writes[histKey] = trimmed;
    }

    if (Object.keys(writes).length > 0) await chrome.storage.local.set(writes);
    if (phase1Throttled) {
      console.warn("[NiceTry bg] poll cut short by rate-limit; will resume next tick");
    }
  } catch (e) {
    console.warn("[NiceTry bg] incoming-tx poll failed for", smartAccountAddr, ":", e?.message || e);
  }
}

async function pollIncomingInBackground() {
  /* Scan every multi-account on the active chain — receives to an
     inactive account must still show up next time the user switches
     to it. The all-accounts mirror "nt_all_sa_<chainId>" is populated
     by VaultManager on unlock/persist. Falls back to the active SA
     alone when the mirror is absent. */
  const cid = String(currentChainId || DEFAULT_CHAIN_ID).toLowerCase();
  const addrs = await getAllSmartAccountAddressesForActiveChain();
  if (addrs.length === 0) {
    console.warn("[NiceTry bg] poll aborted: no SA address on active chain");
    return;
  }

  let latest;
  try {
    const latestHex = await rpcCall("eth_blockNumber", []);
    latest = parseInt(latestHex, 16);
  } catch (e) {
    console.warn("[NiceTry bg] eth_blockNumber failed:", e?.message || e);
    return;
  }
  if (!Number.isFinite(latest)) {
    console.warn("[NiceTry bg] eth_blockNumber returned non-numeric:", latest);
    return;
  }
  /* Sequential, not parallel: each SA needs ≤MAX_BLOCKS_PER_POLL block
     reads on the same RPC endpoint. Running N accounts in parallel
     would multiply the per-tick request count by N and trip rate
     limits. Sequential keeps per-tick budget stable regardless of how
     many accounts the user has. */
  for (const addr of addrs) {
    await pollIncomingForOneAddress(addr, latest, cid);
  }
}

/* Schedule the recurring scan. chrome.alarms minimum is 1 minute on
   stable extensions; we use INCOMING_ALARM_PERIOD_MIN to keep RPC
   pressure low (free-tier endpoints throttle aggressively at the
   default 1m cadence). */
try {
  chrome.alarms.create(INCOMING_ALARM_NAME, {
    periodInMinutes: INCOMING_ALARM_PERIOD_MIN,
    delayInMinutes: 0.1,
  });

} catch {}

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm?.name === INCOMING_ALARM_NAME) {
    pollIncomingInBackground();
  }
  if (alarm?.name === SESSION_ALARM_NAME) {
    lockSession();
  }

});

/* Also run once on SW startup so a freshly-woken worker doesn't wait
   a full minute before its first scan. */
pollIncomingInBackground();



// Firefox has sidebarAction instead of Chromium's sidePanel click behavior.
// Register synchronously so the event page can wake for toolbar clicks.
if (chrome.sidebarAction?.open) {
  chrome.action.onClicked.addListener(() => {
    chrome.sidebarAction.open().catch((err) => {
      console.warn("[NiceTry bg] Sidebar open failed:", err);
    });
  });
}

/* On every SW wake-up, re-apply the popup-vs-sidebar mode the user
   chose previously. Chrome usually persists action.setPopup and
   sidePanel.setPanelBehavior across sessions, but they reset on
   extension reload — and we want sidebar mode to keep suppressing
   the default popup even after a manual `Reload extension`. */
(async () => {
  try {
    const { nt_ui_mode } = await chrome.storage.local.get("nt_ui_mode");
    const isSidebar = nt_ui_mode === "sidebar";
    await chrome.action?.setPopup?.({ popup: isSidebar ? "" : "popup.html" });
    await chrome.sidePanel?.setPanelBehavior?.({
      openPanelOnActionClick: isSidebar,
    });
  } catch (e) {
    console.warn("[NiceTry bg] UI mode sync failed:", e);
  }
})();

/* Promise that resolves once we've hydrated currentChainId from
   chrome.storage at SW startup. Service workers can be killed and
   re-spawned at any time; the storage read at the bottom of this
   file is async, so the SW briefly holds the DEFAULT_CHAIN_ID before
   the real value lands. dApp requests that arrive in that window
   would otherwise see a stale chainId. We await this promise inside
   handleProviderRequest so eth_chainId / wallet_switchEthereumChain
   etc. always observe the correct chain. */
let _chainIdHydrated = null;
function awaitChainIdHydrated() {
  if (_chainIdHydrated) return _chainIdHydrated;
  _chainIdHydrated = new Promise((resolve) => {
    try {
      chrome.storage.local.get(["nt_chainId"], (d) => {
        if (d?.nt_chainId) currentChainId = d.nt_chainId;
        resolve();
      });
    } catch {
      resolve();
    }
  });
  return _chainIdHydrated;
}
awaitChainIdHydrated();

/* Seed the custom-RPC mirror so getRpcUrls() (used by rpcCall / the owner
   tracker) honors user overrides as soon as the SW boots. Kept fresh by
   the storage.onChanged listener below when the popup changes it. */
hydrateCustomRpc();

/* Auto-lock timeout — user-configurable in SettingsMenu, persisted as
   `nt_autolock_min` (minutes). Default lowered from 30→10 min in line
   with mainstream wallet defaults (MetaMask 5, Phantom 15, Trust 5).
   Resolved at every startSession() call so changes apply on the next
   activity tick without restarting the SW. The SETTINGS_AUTOLOCK_CHANGED
   message restarts the timer immediately when the user moves the
   slider while a session is active. */
const DEFAULT_AUTOLOCK_MIN = 10;
const MIN_AUTOLOCK_MIN = 1;
const MAX_AUTOLOCK_MIN = 60;

async function getAutolockMs() {
  try {
    const { nt_autolock_min } = await chrome.storage.local.get(["nt_autolock_min"]);
    const n = Number(nt_autolock_min);
    if (Number.isFinite(n) && n >= MIN_AUTOLOCK_MIN && n <= MAX_AUTOLOCK_MIN) {
      return n * 60 * 1000;
    }
  } catch {}
  return DEFAULT_AUTOLOCK_MIN * 60 * 1000;
}


let openUiPortCount = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "nicetry-ui") return;
  openUiPortCount++;

  port.onDisconnect.addListener(() => {
    openUiPortCount = Math.max(0, openUiPortCount - 1);
  });
});



/* ── Helpers ── */

function broadcastEvent(event, data) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs
        .sendMessage(tab.id, { type: "PROVIDER_EVENT", event, data })
        .catch(() => {});
    });
  });
  chrome.runtime.sendMessage({ type: "PROVIDER_EVENT", event, data }).catch(() => {});
}

function getRpcUrl() {
  const net = getNetwork(currentChainId) || getNetwork(DEFAULT_CHAIN_ID);
  return net.rpcUrl;
}

function getRpcUrlList() {
  const net = getNetwork(currentChainId) || getNetwork(DEFAULT_CHAIN_ID);
  const urls = getRpcUrls(net);
  return urls.length ? urls : [net.rpcUrl];
}

/* Probe a candidate RPC URL with a single eth_chainId call (8s timeout).
   Returns { ok:true, chainId:"0x.." } on a valid JSON-RPC reply, or
   { ok:false, error } on a bad URL / HTTP error / RPC error / timeout.
   The popup compares chainId against the active network to confirm the
   endpoint serves the right chain. */
async function testRpcUrl(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    return { ok: false, error: "URL must start with http:// or https://" };
  }
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json?.error) return { ok: false, error: json.error.message || "RPC error" };
    const chainId =
      typeof json?.result === "string" ? json.result.toLowerCase() : null;
    if (!chainId) return { ok: false, error: "no chainId in response" };
    return { ok: true, chainId };
  } catch (e) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      error: e?.name === "AbortError" ? "timed out" : e?.message || "network error",
    };
  }
}




function normalizeAddress(addr) {
  return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr)
    ? addr.toLowerCase()
    : null;
}

function connectedAccountForOrigin(origin) {
  const accounts = connectedAccounts[origin] || [];
  return normalizeAddress(accounts[0]);
}

function getRequestedSigningAccount(method, params) {
  if (method === "eth_sendTransaction") {
    return normalizeAddress(params?.[0]?.from);
  }
  return null;
}

function authorizePrivilegedRequest(method, params, origin) {
  const account = connectedAccountForOrigin(origin);
  if (!account) {
    return {
      error: {
        code: 4100,
        message: "Unauthorized: connect this origin before signing",
      },
    };
  }
  const requested = getRequestedSigningAccount(method, params);
  if (requested && requested !== account) {
    return {
      error: {
        code: 4100,
        message: "Unauthorized: requested account is not connected",
      },
    };
  }
  return { account };
}

/* Walk the network's RPC list (primary then fallbacks) until one
   responds successfully. Treats network errors and 5xx as retryable
   and skips to the next URL; a JSON-RPC `error` reply (4xx-style at
   the application layer) is returned as-is — that's the chain saying
   "your request is invalid" and another endpoint won't help. CORS
   doesn't apply in the SW context (chrome.* fetches are exempt) but
   transient timeouts on flaky public endpoints are common, hence the
   per-leg AbortController. */
async function rpcCall(method, params) {
  const urls = getRpcUrlList();
  const body = { jsonrpc: "2.0", id: Date.now(), method, params: params || [] };
  const payload = JSON.stringify(body);

  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        // Transport-level failure (5xx, 429): try the next URL.
        lastErr = new Error(`RPC ${url} HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();
      if (json.error) {
        // Application-level error from the chain — propagate, don't
        // bounce. A different endpoint won't fix "invalid args".
        const err = new Error(json.error.message || "RPC error");
        err.code = json.error.code;
        throw err;
      }
      return json.result;
    } catch (e) {
      clearTimeout(timeoutId);
      // Re-throw application errors (have a numeric `code` from the
      // chain). Bounce on AbortError / TypeError (network failure).
      if (e && typeof e.code === "number") throw e;
      lastErr = e;
    }
  }

  throw lastErr || new Error("All RPC endpoints failed");
}

/* Fetch several full blocks in ONE JSON-RPC array request. The incoming
   poller needs every block in its window; issuing them as N separate POSTs
   is what forced the window down to 50 blocks. Batching keeps the byte cost
   the same but collapses the round-trips.

   Returns an array positionally aligned with `blockNums`, holding the block
   object or null where that specific sub-call failed. Throws (so the caller
   can fall back / retry the whole chunk) when the transport or every
   endpoint fails. An endpoint that rejects array bodies fails its leg and
   the next URL is tried, exactly like rpcCall. */
async function rpcBatchGetBlocks(numbers) { return Promise.all(numbers.map(n=>rpcCall('eth_getBlockByNumber',['0x'+n.toString(16),true]).catch(()=>null))); }

/* Like rpcCall but pinned to a specific chain — used by the owner
   tracker which may be watching SAs on chains other than the currently
   active one. */
async function rpcCallForChain(chainIdHex, method, params) {
  const net = getNetwork(chainIdHex);
  if (!net) throw new Error(`rpcCallForChain: unknown chain ${chainIdHex}`);
  const urls = (() => {
    try {
      const list = getRpcUrls(net);
      return list?.length ? list : [net.rpcUrl];
    } catch {
      return [net.rpcUrl];
    }
  })();
  const body = { jsonrpc: "2.0", id: Date.now(), method, params: params || [] };
  const payload = JSON.stringify(body);

  let lastErr = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        lastErr = new Error(`RPC ${url} HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json.error) {
        const err = new Error(json.error.message || "RPC error");
        err.code = json.error.code;
        throw err;
      }
      return json.result;
    } catch (e) {
      clearTimeout(timeoutId);
      if (e && typeof e.code === "number") throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("All RPC endpoints failed");
}




function handoverSignalKey(saAddr, chainId) {
  return `${saAddr.toLowerCase()}_${String(chainId).toLowerCase()}`;
}



async function notifyHandover(entry, title, message) {
  try {
    chrome.notifications?.create?.(`nt_handover_${handoverSignalKey(entry.saAddr, entry.chainId)}`, {
      type: "basic",
      iconUrl: "/nicetry_logo_.png",
      title,
      message,
      priority: 1,
    });
  } catch {}
}





/* Cache of (txHash → { saAddress, target }) for fast rewrite lookups.
   Populated lazily on first miss; invalidated when a new tx history
   entry is written (chrome.storage onChanged listener below). */
let _ourTxIndex = null;

async function buildOurTxIndex() {
  const idx = new Map();
  try {
    const all = await chrome.storage.local.get(null);
    for (const key of Object.keys(all)) {
      if (!key.startsWith("nt_txhistory_")) continue;
      // key = nt_txhistory_<addr>_<chainId>; addr itself has no underscore.
      const saAddress = key.slice("nt_txhistory_".length).split("_")[0];
      const list = all[key];
      if (!Array.isArray(list)) continue;
      for (const tx of list) {
        if (!tx?.txHash) continue;
        idx.set(tx.txHash.toLowerCase(), {
          saAddress,
          target: tx.to || null,
        });
      }
    }
  } catch (e) {
    console.warn("[NiceTry bg] buildOurTxIndex failed:", e);
  }
  return idx;
}

async function findOurTx(hash) {
  if (!hash) return null;
  if (!_ourTxIndex) _ourTxIndex = await buildOurTxIndex();
  return _ourTxIndex.get(hash.toLowerCase()) || null;
}

/* Invalidate the cache when txHistory is written (rotation modules
   update nt_txhistory_<addr> after every successful send). */
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== "local") return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith("nt_txhistory_")) {
      _ourTxIndex = null;
      break;
    }
  }
  /* Custom RPC changed in the popup → refresh the SW's own
     __NT_CUSTOM_RPC mirror (separate globalThis from the popup) so
     rpcCall/getRpcUrls pick up the new endpoint without a SW restart. */
  if (CUSTOM_RPC_STORAGE_KEY in changes) {
    const map = changes[CUSTOM_RPC_STORAGE_KEY].newValue;
    globalThis.__NT_CUSTOM_RPC = map && typeof map === "object" ? map : {};
  }
});

function rewriteReceipt(receipt) { return receipt; }

function rewriteTx(tx) { return tx; }

/* ── Session ── */

function clearSessionTimer() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  try {
    chrome.alarms.clear(SESSION_ALARM_NAME);
  } catch {}
}

function armSessionExpiry(expiresAt) {
  clearSessionTimer();
  const delay = Math.max(0, Number(expiresAt) - Date.now());
  sessionTimer = setTimeout(lockSession, delay);
  try {
    chrome.alarms.create(SESSION_ALARM_NAME, { when: Number(expiresAt) });
  } catch {}
}

async function startSession() {
  const ms = await getAutolockMs();
  const expiresAt = Date.now() + ms;
  armSessionExpiry(expiresAt);
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [SESSION_EXPIRY_KEY]: expiresAt });
    }
  } catch {}
  chrome.action.setBadgeText({ text: "" });
}

function lockSession() {
  clearSessionTimer();
  connectedAccounts = {};
  signingLock = null;
  for (const pending of Object.values(pendingRequests)) {
    try {
      pending?.resolve?.({
        error: { code: 4001, message: "Wallet locked" },
      });
    } catch {}
  }
  pendingRequests = {};
  if (chrome.storage.session) {
    chrome.storage.session.remove([
      SESSION_KEY_KEY,
      LEGACY_SESSION_PASSWORD_KEY,
      SESSION_EXPIRY_KEY,
      SIGNING_LOCK_KEY,
    ]);
  }
  broadcastEvent("accountsChanged", []);
  broadcastEvent("disconnect", { code: 4900, message: "Wallet locked" });
  chrome.action.setBadgeText({ text: "" });
}

async function restoreSessionExpiry() {
  try {
    if (!chrome.storage.session) return;
    const data = await chrome.storage.session.get([
      SESSION_KEY_KEY,
      SESSION_EXPIRY_KEY,
    ]);
    const expiresAt = Number(data?.[SESSION_EXPIRY_KEY] || 0);
    if (!data?.[SESSION_KEY_KEY] || !expiresAt || expiresAt <= Date.now()) {
      await chrome.storage.session.remove([
        SESSION_KEY_KEY,
        LEGACY_SESSION_PASSWORD_KEY,
        SESSION_EXPIRY_KEY,
      ]);
      return;
    }
    armSessionExpiry(expiresAt);
  } catch {}
}

restoreSessionExpiry();

async function refreshSessionIfActive() {
  try {
    if (!chrome.storage.session) return false;
    if (sessionTimer) {
      await startSession();
      return true;
    }
    const data = await chrome.storage.session.get([
      SESSION_KEY_KEY,
      SESSION_EXPIRY_KEY,
    ]);
    const expiresAt = Number(data?.[SESSION_EXPIRY_KEY] || 0);
    if (data?.[SESSION_KEY_KEY] && expiresAt > Date.now()) {
      await startSession();
      return true;
    }
    if (expiresAt && expiresAt <= Date.now()) {
      await chrome.storage.session.remove([
        SESSION_KEY_KEY,
        LEGACY_SESSION_PASSWORD_KEY,
        SESSION_EXPIRY_KEY,
      ]);
    }
  } catch {}
  return false;
}

function lockExpired(lock) {
  return !lock?.expiresAt || Number(lock.expiresAt) <= Date.now();
}

function signingLockTtl(ttlMs) {
  const requested = Number(ttlMs);
  if (!Number.isFinite(requested) || requested <= 0) return SIGNING_LOCK_MAX_TTL_MS;
  return Math.min(
    Math.max(requested, SIGNING_LOCK_MIN_TTL_MS),
    SIGNING_LOCK_MAX_TTL_MS,
  );
}

async function getSigningLock() {
  if (signingLock && !lockExpired(signingLock)) return signingLock;
  signingLock = null;
  try {
    if (!chrome.storage.session) return null;
    const data = await chrome.storage.session.get([SIGNING_LOCK_KEY]);
    const stored = data?.[SIGNING_LOCK_KEY] || null;
    if (!stored || lockExpired(stored)) {
      await chrome.storage.session.remove([SIGNING_LOCK_KEY]);
      return null;
    }
    signingLock = stored;
    return signingLock;
  } catch {
    return signingLock;
  }
}

async function acquireSigningLock({ owner, label, ttlMs }) {
  const active = await getSigningLock();
  if (active) {
    return {
      ok: false,
      error: "Another signing request is already in progress",
    };
  }
  const ttl = signingLockTtl(ttlMs);
  signingLock = {
    owner,
    label: label || "signing",
    expiresAt: Date.now() + ttl,
  };
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [SIGNING_LOCK_KEY]: signingLock });
    }
  } catch {}
  return { ok: true };
}

function queueSigningLockAcquire(req) {
  const next = signingLockAcquireQueue.then(
    () => acquireSigningLock(req),
    () => acquireSigningLock(req),
  );
  signingLockAcquireQueue = next.catch(() => {});
  return next;
}

async function renewSigningLock({ owner, ttlMs }) {
  const active = await getSigningLock();
  if (!active || active.owner !== owner) {
    return {
      ok: false,
      error: "Signing lock is no longer held by this request",
    };
  }
  const ttl = signingLockTtl(ttlMs);
  signingLock = {
    ...active,
    expiresAt: Date.now() + ttl,
  };
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [SIGNING_LOCK_KEY]: signingLock });
    }
  } catch {}
  return { ok: true };
}

async function releaseSigningLock(owner) {
  const active = await getSigningLock();
  if (!active || active.owner !== owner) return { ok: false };
  signingLock = null;
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.remove([SIGNING_LOCK_KEY]);
    }
  } catch {}
  return { ok: true };
}

/* ── Open approval popup window (like MetaMask) ── */

async function openApprovalPopup(pendingId) {
  const url = chrome.runtime.getURL(`popup.html#approve/${pendingId}`);

  // Position popup near top-right of screen
  const win = await chrome.windows.getCurrent();
  const left = (win.left || 0) + (win.width || 1280) - 420;
  const top = (win.top || 0) + 80;

  return chrome.windows.create({
    url,
    type: "popup",
    width: 400,
    height: 620,
    left,
    top,
    focused: true,
  });
}
async function deliverApproval(pendingId) {
  const pending = pendingRequests[pendingId];
  if (!pending) return;

  /* Always try the runtime message bridge first, regardless of
     openUiPortCount. The count lives in SW memory and is reset to 0
     whenever Chrome kills and respawns the service worker (MV3 idle
     timeout, ~30s) — the existing popup/sidebar surface stays alive
     but its port is gone, so the count under-reports. Sending a
     message is cheap: chrome.runtime.sendMessage rejects fast with
     "Could not establish connection" when no extension surface is
     listening, and only then we spawn a detached popup window. This
     prevents the bug where, with the sidebar open, a dApp request
     after a SW restart spawned a redundant popup. */
  try {
    await chrome.runtime.sendMessage({
      type: "APPROVE_REQUEST",
      pendingId,
      method: pending.method,
      params: pending.params,
      origin: pending.origin,
      account: pending.account,
    });
    return;
  } catch {
    // No extension surface listening — fall through to spawn a popup.
  }

  openApprovalPopup(pendingId);
}
/* ── Provider request handler ── */

async function handleProviderRequest(msg, sender) {
  const { method, params } = msg;
  /* The dApp origin comes from Chrome's sender info, which the page
     cannot forge. msg.origin (window.location.origin as seen by the
     content script) is only a fallback for Chrome versions that don't
     populate sender.origin. */
  const origin = sender?.origin || msg.origin;

  /* Block until the chainId is hydrated from storage. The SW can be
     killed and respawned at any moment; without this gate, the very
     first dApp request after a respawn could observe DEFAULT_CHAIN_ID
     instead of the user's actual chain. */
  await awaitChainIdHydrated();

  refreshSessionIfActive();

  // Get our smart account address (for the active chain) to intercept
  // queries about it. Per-chain "nt_sa_<chainId>" with a legacy
  // fallback to the old single-string "SmartAccount" key.
  const smartAccountAddr = await getActiveSmartAccountAddress();

  switch (method) {
    case "eth_chainId":
      return { result: currentChainId };

    case "net_version":
      return { result: String(parseInt(currentChainId, 16)) };

    // Hide smart account code from dApps — they see it as EOA,
    // we handle UserOp wrapping internally
    case "eth_getCode": {
      const addr = params?.[0]?.toLowerCase();
      if (addr && smartAccountAddr && addr === smartAccountAddr) {
        return { result: "0x" };
      }
      try {
        return { result: await rpcCall(method, params) };
      } catch (err) {
        return { error: { code: err.code || -32603, message: err.message } };
      }
    }

    case "eth_accounts":
      return { result: connectedAccounts[origin] || [] };

    case "eth_requestAccounts": {
      if (connectedAccounts[origin]?.length > 0)
        return { result: connectedAccounts[origin] };

      const pendingId = newPendingId();
      return new Promise((resolve) => {
        pendingRequests[pendingId] = {
          method,
          params,
          origin,
          account: normalizeAddress(smartAccountAddr),
          resolve,
        };
      deliverApproval(pendingId)
      });
    }

    // Wallet-specific methods — handle locally, don't proxy to RPC
    case "wallet_requestPermissions":
      return { result: [{ parentCapability: "eth_accounts" }] };

    case "wallet_getPermissions":
      return { result: connectedAccounts[origin]?.length
        ? [{ parentCapability: "eth_accounts" }]
        : [] };

    case "wallet_getCapabilities":
      return { result: {} };

    case "wallet_revokePermissions":
      if (origin) delete connectedAccounts[origin];
      broadcastEvent("accountsChanged", []);
      return { result: null };

    case "personal_sign":
    case "eth_sign":
    case "eth_signTypedData":
    case "eth_signTypedData_v4":
      return {
        error: {
          code: 4200,
          message: "Message signing is not supported by this native-frame wallet",
        },
      };

    case "eth_sendTransaction": {
      const auth = authorizePrivilegedRequest(method, params, origin);
      if (auth.error) return { error: auth.error };
      const pendingId = newPendingId();
      return new Promise((resolve) => {
        pendingRequests[pendingId] = {
          method,
          params,
          origin,
          account: auth.account,
          resolve,
        };
       deliverApproval(pendingId)
      });
    }
    /* The wallet is locked to ONE chain for its entire lifetime —
       chosen at onboarding and persisted there. Each chain has its
       own factory deployment, so the smart-account address is a
       CREATE2 derivation that's only valid on that chain; switching
       chain post-onboarding would orphan the user's funds on the
       original chain. We therefore reject these requests instead of
       letting a dApp silently corrupt the wallet's chain binding.

       Returning EIP-3326 error code 4902 (-32602 also acceptable per
       MetaMask's reference) tells the dApp the chain isn't supported
       so it can prompt the user to use a different wallet. */
    case "wallet_switchEthereumChain": {
      const requested = params?.[0]?.chainId;
      if (
        requested &&
        String(requested).toLowerCase() === String(currentChainId).toLowerCase()
      ) {
        /* dApp asked for the chain we're already on. Per EIP-3326 we
           return null — but several popular dApps (wagmi-based, incl.
           Safe) hold the request promise open until a `chainChanged`
           event lands on the provider. We emit one here with the
           current chainId so the dApp's "switch complete" path
           resolves immediately even though nothing actually changed
           on our side. Without this the dApp hangs in "waiting".  */
        broadcastEvent("chainChanged", currentChainId);
        return { result: null };
      }
      return {
        error: {
          code: 4902,
          message:
            `This wallet is bound to chainId ${currentChainId} for its entire lifetime. Switching to ${requested} would orphan funds on the original chain. Use a different wallet for that chain.`,
        },
      };
    }

    case "wallet_addEthereumChain": {
      const info = params?.[0];
      if (
        info?.chainId &&
        String(info.chainId).toLowerCase() === String(currentChainId).toLowerCase()
      ) {
        // dApp wants to add the same chain we're already on — that's
        // fine, treat as a no-op. Same chainChanged-emit reasoning
        // as wallet_switchEthereumChain above.
        broadcastEvent("chainChanged", currentChainId);
        return { result: null };
      }
      return {
        error: {
          code: 4902,
          message:
            `This wallet is bound to chainId ${currentChainId}. Adding/switching to ${info?.chainId} is not supported.`,
        },
      };
    }


    case "eth_getTransactionReceipt": {
      try {
        const real = await rpcCall(method, params);
        const ourTx = await findOurTx(params?.[0]);
        return { result: ourTx ? rewriteReceipt(real, ourTx) : real };
      } catch (err) {
        return { error: { code: err.code || -32603, message: err.message } };
      }
    }
    case "eth_getTransactionByHash": {
      try {
        const real = await rpcCall(method, params);
        const ourTx = await findOurTx(params?.[0]);
        return { result: ourTx ? rewriteTx(real, ourTx) : real };
      } catch (err) {
        return { error: { code: err.code || -32603, message: err.message } };
      }
    }

    // Batch JSON-RPC (some dApps send arrays)
    case "eth_call":
    case "eth_estimateGas":
    case "eth_getBalance":
    case "eth_getCode":
    case "eth_getTransactionCount":
    case "eth_blockNumber":
    case "eth_getBlockByNumber":
    case "eth_getBlockByHash":
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
    case "eth_feeHistory":
    case "eth_getLogs":
    case "eth_getStorageAt":
    case "eth_getProof":
    case "net_listening":
    case "web3_clientVersion":
    default: {
      try {
        return { result: await rpcCall(method, params) };
      } catch (err) {
        return { error: { code: err.code || -32603, message: err.message } };
      }
    }
  }
}

/* ── Message listener ── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  /* ── Sender gating ──
     onMessage only fires for this extension's own contexts, but those
     include the content script, which runs inside every https page.
     Partition the surface: PROVIDER_REQUEST is the only type the
     content script may send (it always has sender.tab and a web
     sender.url); every other message is internal and must come from
     one of our own extension pages — popup / side panel / onboarding —
     whose sender.url Chrome pins to chrome-extension://<our-id>/ and
     the page cannot forge. */
  const fromOwnPage =
    typeof sender?.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""));

  if (msg.type === "PROVIDER_REQUEST") {
    if (fromOwnPage || !sender?.tab) {
      sendResponse({ error: { code: -32600, message: "Invalid request source" } });
      return;
    }
    handleProviderRequest(msg, sender).then(sendResponse).catch((err) => {
      sendResponse({ error: { code: -32603, message: err.message } });
    });
    return true;
  }

  if (!fromOwnPage) {
    /* Internal surface (approvals, session, signing lock, chain config):
       refuse anything that doesn't come from our own pages. */
    sendResponse({ error: { code: -32600, message: "Unauthorized sender" } });
    return;
  }

  // Approval result from popup window
  if (msg.type === "APPROVAL_RESULT") {
    const pending = pendingRequests[msg.pendingId];
    if (pending?.resolve) {
      if (msg.approved) {
        // For eth_requestAccounts: store connected accounts
        if (pending.method === "eth_requestAccounts" && msg.accounts) {
          const approvedAccounts = Array.isArray(msg.accounts)
            ? msg.accounts.map(normalizeAddress).filter(Boolean)
            : [];
          const account = pending.account || approvedAccounts[0] || null;
          if (!account || (pending.account && !approvedAccounts.includes(pending.account))) {
            pending.resolve({
              error: { code: 4100, message: "Unauthorized account approval" },
            });
            delete pendingRequests[msg.pendingId];
            sendResponse({ ok: true });
            return;
          }
          connectedAccounts[pending.origin] = [account];
          broadcastEvent("accountsChanged", [account]);
          pending.resolve({ result: [account] });
          delete pendingRequests[msg.pendingId];
          sendResponse({ ok: true });
          return;
        }
        pending.resolve({ result: msg.result || msg.accounts });
      } else {
        pending.resolve({ error: { code: 4001, message: "User rejected" } });
      }
      delete pendingRequests[msg.pendingId];
    }
    sendResponse({ ok: true });
    return;
  }

  // Get pending request details (called by approval popup)
  if (msg.type === "GET_PENDING") {
    const p = pendingRequests[msg.pendingId];
    sendResponse(p ? {
      method: p.method,
      params: p.params,
      origin: p.origin,
      account: p.account,
    } : null);
    return;
  }

  if (msg.type === "GET_WALLET_DOCUMENT") {
    sendResponse({ documentId: sender.documentId || null });
    return;
  }

  if (msg.type === "SIGNING_LOCK_ACQUIRE") {
    queueSigningLockAcquire(msg).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }

  if (msg.type === "SIGNING_LOCK_RENEW") {
    renewSigningLock(msg).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });
    return true;
  }

  if (msg.type === "SIGNING_LOCK_RELEASE") {
    releaseSigningLock(msg.owner).then(sendResponse);
    return true;
  }

  if (msg.type === "SESSION_START") { startSession(); sendResponse({ ok: true }); return; }
  if (msg.type === "SESSION_ACTIVITY") {
    refreshSessionIfActive().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "SESSION_LOCK") { lockSession(); sendResponse({ ok: true }); return; }

  // User changed the auto-lock setting in SettingsMenu. Re-arm the
  // running timer so the new value takes effect immediately rather
  // than waiting for the next activity tick.
  if (msg.type === "SETTINGS_AUTOLOCK_CHANGED") {
    refreshSessionIfActive().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "DISCONNECT_ORIGIN") {
    if (msg.origin) delete connectedAccounts[msg.origin];
    else connectedAccounts = {};
    broadcastEvent("accountsChanged", []);
    broadcastEvent("disconnect", { code: 4900, message: "Disconnected" });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "GET_CHAIN_ID") { sendResponse({ chainId: currentChainId }); return; }

  if (msg.type === "SET_CHAIN_ID") {
    /* SET_CHAIN_ID is an INTERNAL message — only our own popup /
       onboarding / migration can send it via chrome.runtime, dApps
       can't reach this message channel. We trust it unconditionally.
       The user can switch the live chain at runtime from the dashboard
       (useNetwork.switchChain); we mirror it and notify dApps via
       chainChanged. dApp-initiated chain controls
       (wallet_switchEthereumChain / wallet_addEthereumChain) are
       handled separately. */
    currentChainId = msg.chainId;
    chrome.storage.local.set({ nt_chainId: msg.chainId });
    broadcastEvent("chainChanged", msg.chainId);
    sendResponse({ ok: true });
    return;
  }

  /* Live-test a candidate custom RPC URL (Settings → Network). Run from
     the SW because its fetch is CORS-exempt — a user's node may not send
     CORS headers, which would block a popup-side fetch. Returns the URL's
     eth_chainId so the popup can confirm it matches the active network. */
  if (msg.type === "TEST_RPC_URL") {
    testRpcUrl(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e?.message || "test failed" }));
    return true;
  }




  if (msg.type === "ACCOUNTS_CHANGED") {
    broadcastEvent("accountsChanged", msg.accounts);
    sendResponse({ ok: true });
    return;
  }

  /* Internal: the popup switched the active multi-account. Re-point every
     connected origin at the new account's smart address and notify dApps.
     The popup passes msg.account when known (cached SA); otherwise we
     read the clear-text mirror the vault just rewrote. */
  if (msg.type === "ACTIVE_ACCOUNT_CHANGED") {
    const apply = (sa) => {
      const acct = sa ? normalizeAddress(sa) : null;
      const next = acct ? [acct] : [];
      for (const origin of Object.keys(connectedAccounts)) {
        if (connectedAccounts[origin]?.length) connectedAccounts[origin] = next;
      }
      broadcastEvent("accountsChanged", next);
      sendResponse({ ok: true });
    };
    if (msg.account) {
      apply(msg.account);
    } else {
      getActiveSmartAccountAddress()
        .then(apply)
        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }
    return;
  }

  if (msg.type === "GET_CONNECTED") {
    sendResponse({ accounts: connectedAccounts });
    return;
  }





  if (msg.type === "OPEN_ONBOARDING") {
    // Open the setup flow tab on demand (used by SetupNotComplete in
    // the popup when the user aborted onboarding and wants to resume).
    chrome.tabs.create({
      url: chrome.runtime.getURL("onboarding.html"),
      active: true,
    }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
});

/* ── Install ── */

chrome.runtime.onInstalled.addListener((details) => {
  chrome.action.setBadgeBackgroundColor({ color: "#00D1A0" });
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
  chrome.storage.local.get(["nt_chainId"], (d) => { if (d.nt_chainId) currentChainId = d.nt_chainId; });

  // First install → open onboarding in a full tab (Rabby-style setup).
  // Skip on "update" / "chrome_update" so existing users don't get the
  // setup flow again on every version bump.
  if (details.reason === "install") {
    const url = chrome.runtime.getURL("onboarding.html");
    chrome.tabs.create({ url, active: true }).catch((e) => {
      console.warn("[NiceTry] Failed to open onboarding tab:", e);
    });
  }
});

chrome.storage.local.get(["nt_chainId", "nt_custom_chains"], (d) => {
  if (d.nt_chainId) currentChainId = d.nt_chainId;
  if (d.nt_custom_chains)
    for (const [id, net] of Object.entries(d.nt_custom_chains))
      if (!NETWORKS[id]) NETWORKS[id] = net;
});
