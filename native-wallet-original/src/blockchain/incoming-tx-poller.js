import { directTransfers } from '../native-frame/transfers.js';
/* ═══════════════════════════════════════════════════════════════════
   incoming-tx-poller.js — detect inbound native-ETH transfers
   ───────────────────────────────────────────────────────────────────
   Polls a window of new blocks via the public RPC (no third-party
   indexer) and surfaces transactions whose `to` is the user's smart
   account. New entries are pushed to the `txHistory` signal with
   shape compatible with the rotation-module entries — except they
   carry `kind: "receive"` and `from` instead of `keyFrom/keyTo`.

   Storage keys (lower-cased smart address + active chainId — the SA
   address is identical across chains, so chainId MUST be in the key):
     nt_lastSeenBlock_<addr>_<chainId>   → number — last block we scanned
     nt_txhistory_<addr>_<chainId>       → tx-persistence array (read for dedupe)

   The popup-side poller is invoked from refreshBalances() so it
   piggybacks on the existing balance cadence. The same logic also
   runs in the background service worker on a chrome.alarms tick so
   transfers received while the wallet is closed are picked up the
   next time the popup opens (via tx-persistence's load effect).

   Window cap:
     - DEFAULT_LOOKBACK   blocks back when we have no checkpoint
     - MAX_BLOCKS_PER_POLL hard cap per call (avoids storms after a
       long offline period — we accept missing very old transfers)
   ═══════════════════════════════════════════════════════════════════ */

import { formatEther } from "viem";
import { publicClient } from "@/blockchain/client.js";
import { getActiveNetwork } from "@/config/networks.js";
import { scanWindow } from "@/blockchain/scan-window.js";
import { txHistory, smartAddr, chainId } from "@/ui/store.js";

/* The scan window is derived per chain from blockTimeSec — see
   blockchain/scan-window.js for why a fixed block count silently loses
   receives on fast chains. windowFor() resolves it for the ACTIVE network
   at the popup's poll cadence.

   Concurrency is high because the transport batches: viem coalesces the
   eth_getBlockByNumber calls issued in one tick into a single JSON-RPC
   array (see client.js BATCH), so 24 concurrent calls are ~1 HTTP request,
   not 24. The old value of 2 existed only because each call was its own
   round-trip against a rate-limited public node. */
const BLOCK_FETCH_CONCURRENCY = 24;

function windowFor() {
  return scanWindow(getActiveNetwork(), MIN_POLL_INTERVAL_MS / 1000);
}
/* Minimum gap between two scans triggered from the popup (each
   refreshBalances fires one). Prevents the per-component-mount
   storms where opening the dashboard, then Send, then Approval would
   trigger three scans in <500ms.

   Keyed on (chainId, address) — NOT chainId alone. Switching to a
   different multi-account on the same chain has to allow an immediate
   first scan for the new account; otherwise the new account's poller
   would stay silent for up to MIN_POLL_INTERVAL_MS after every switch
   and the first receive after a switch could be missed in the popup
   path (the BG path covers it eventually, but the dashboard would
   look stale). */
const MIN_POLL_INTERVAL_MS = 30_000;
const _lastPollAt = new Map(); // key: "<chainId>:<addr-lower>" → epoch ms

/* Per (address, chainId) checkpoint key. The SA address is identical on
   every supported chain, so chainId MUST be part of the key — otherwise
   one chain's block cursor (e.g. Arbitrum Sepolia's, in the tens of
   millions) pollutes another's, making fromBlock > latest so the scan
   window collapses and incoming txs are silently never detected. */
function lastSeenKey(addr) {
  return (
    "nt_lastSeenBlock_" +
    addr.toLowerCase() +
    "_" +
    String(chainId.value).toLowerCase()
  );
}

/* Backfill cursor: next-block-to-scan when walking DOWNWARD into history.
   Initialized at the first scan to (latest - MAX_BLOCKS_PER_POLL), and
   decremented by MAX_BLOCKS_PER_POLL on each tick until it reaches the
   backfill target. Without this cursor the first scan would cover blocks
   far in the past and miss a receive that just landed at ~latest. */
function backfillCursorKey(addr) {
  return (
    "nt_backfillCursor_" +
    addr.toLowerCase() +
    "_" +
    String(chainId.value).toLowerCase()
  );
}

/* Lower bound of the backfill window — captured at first scan as
   max(0, latest - INITIAL_LOOKBACK) and never updated, so the wallet
   walks back roughly INITIAL_LOOKBACK blocks regardless of how long
   the catch-up takes. */
function backfillTargetKey(addr) {
  return (
    "nt_backfillTarget_" +
    addr.toLowerCase() +
    "_" +
    String(chainId.value).toLowerCase()
  );
}

function timestampOf(epochMs) {
  return new Date(epochMs).toTimeString().slice(0, 8);
}

function formatAmount(weiBigInt) {
  try {
    return Number(formatEther(weiBigInt)).toFixed(6);
  } catch {
    return "0.000000";
  }
}

async function readCursors(addr) {
  return new Promise((resolve) => {
    const keys = [lastSeenKey(addr), backfillCursorKey(addr), backfillTargetKey(addr)];
    chrome.storage.local.get(keys, (res) => {
      resolve({
        forward: typeof res?.[keys[0]] === "number" ? res[keys[0]] : null,
        backfillCursor: typeof res?.[keys[1]] === "number" ? res[keys[1]] : null,
        backfillTarget: typeof res?.[keys[2]] === "number" ? res[keys[2]] : null,
      });
    });
  });
}

async function writeCursors(addr, { forward, backfillCursor, backfillTarget }) {
  const updates = {};
  if (forward != null) updates[lastSeenKey(addr)] = forward;
  if (backfillCursor != null) updates[backfillCursorKey(addr)] = backfillCursor;
  if (backfillTarget != null) updates[backfillTargetKey(addr)] = backfillTarget;
  if (Object.keys(updates).length === 0) return;
  return new Promise((resolve) => {
    chrome.storage.local.set(updates, resolve);
  });
}

/* Detects a 429 (or generic rate-limit) error from a viem getBlock
   call. Different RPCs return different shapes; the union below
   covers what publicnode + tenderly + alchemy report. */
function isRateLimitError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  if (err.status === 429) return true;
  if (msg.includes("429")) return true;
  if (msg.includes("rate") && msg.includes("limit")) return true;
  if (msg.includes("too many requests")) return true;
  return false;
}

/* Scan blocks [from, to] for txs whose `to` matches `target`. Returns
   an array of normalized entries (newest last — call site can sort).
   Aborts the chunked fetch as soon as one chunk hits a 429: pushing
   more requests at a throttled endpoint just deepens the cooldown,
   and the next poll cycle (≥30s later) will pick up where this one
   stopped via the checkpoint update.

   `highestScanned` tracks the highest CONTIGUOUS block we actually
   fetched: if any block in the range failed (non-rate-limit error
   or returned null) we MUST NOT advance past it, otherwise the
   checkpoint silently skips over a block and any receive in it is
   lost forever. We resume the next poll from the first gap. */
async function scanBlockRange(target, from, to) {
  const blocks = [];
  for (let n = from; n <= to; n++) blocks.push(n);

  const results = [];
  const fetched = new Set();
  let earliestFailed = null;
  for (let i = 0; i < blocks.length; i += BLOCK_FETCH_CONCURRENCY) {
    const chunk = blocks.slice(i, i + BLOCK_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((n) =>
        publicClient.request({method:'eth_getBlockByNumber',params:['0x'+BigInt(BigInt(n)).toString(16),true]}),
      ),
    );

    /* Bail out on rate-limit. Return what's been scanned so far so the
       caller can advance the checkpoint to the last contiguous block. */
    const throttled = settled.some(
      (s) => s.status === "rejected" && isRateLimitError(s.reason),
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
      fetched.add(Number(block.number));
      const txs = Array.isArray(block.transactions) ? block.transactions : [];
      for (const rawTx of txs) {
       if (!rawTx || typeof rawTx !== 'object') continue;
       const potentiallyRelevant = rawTx.to?.toLowerCase()===target || rawTx.frames?.some(frame=>frame.target?.toLowerCase()===target);
       if(!potentiallyRelevant)continue;
       let receipt;
       try { receipt=await publicClient.request({method:'eth_getTransactionReceipt',params:[rawTx.hash]}); } catch { continue; }
       for(const tx of directTransfers(rawTx,receipt)) {
        // Only full transaction objects carry `to`/`from`/`value`.
        if (typeof tx === "string" || !tx) continue;
        if (!tx.to) continue; // contract creation
        if (tx.to.toLowerCase() !== target) continue;
        // Self-transfer (rotation logs as "send", we skip the dup).
        if (tx.from && tx.from.toLowerCase() === target) continue;
        // Ignore zero-value (could be a contract call to us — surfaced
        // elsewhere; we only want pure receives here).
        const wei = typeof tx.value === "bigint" ? tx.value : BigInt(tx.value || 0);
        if (wei === 0n) continue;

        const ts = Number(block.timestamp) * 1000;
        results.push({
          id: ts,
          time: timestampOf(ts),
          txHash: tx.hash,
          frameIndex:tx.frameIndex, status:'confirmed',
          to: tx.to,
          from: tx.from,
          amount: formatAmount(wei),
          kind: "receive",
          mode: null,
          blockNumber: Number(block.number),
        });
       }
     }
    }
    if (throttled) {
      const highestContiguous = contiguousHigh(from, to, fetched, earliestFailed);
      console.warn(
        `[NiceTry poller] 429 from RPC after block ${highestContiguous} — backing off (resuming next poll)`,
      );
      return { results, highestScanned: highestContiguous, throttled: true };
    }
  }
  const highestScanned = contiguousHigh(from, to, fetched, earliestFailed);
  return { results, highestScanned, throttled: false };
}

/* Highest block N in [from, to] such that every block in [from, N] was
   successfully fetched. Returns `from - 1` if even `from` failed, so the
   checkpoint never advances past a gap. */
function contiguousHigh(from, to, fetched, earliestFailed) {
  const ceiling = earliestFailed != null ? earliestFailed - 1 : to;
  let n = from - 1;
  for (let b = from; b <= ceiling; b++) {
    if (!fetched.has(b)) break;
    n = b;
  }
  return n;
}

/**
 * Poll the public RPC for new incoming ETH transfers to `address` and
 * append them to the `txHistory` signal (deduplicated by hash). Uses
 * `nt_lastSeenBlock_<addr>_<chainId>` as the resume checkpoint.
 *
 * Safe to call concurrently with other history mutations — we only
 * append entries whose hash isn't already in the signal.
 *
 * Returns the number of new entries found (0 on error / no-op).
 */
export async function pollIncomingForSignal(address) {
  if (!address) return 0;
  const target = address.toLowerCase();

  /* Skip if we polled this (chain, address) pair in the last
     MIN_POLL_INTERVAL_MS. Prevents per-component-mount storms while
     still letting chain switches and account switches kick off an
     immediate fresh scan for the newly active target. */
  const now = Date.now();
  const cid = chainId.value;
  const throttleKey = String(cid).toLowerCase() + ":" + target;
  const lastAt = _lastPollAt.get(throttleKey) || 0;
  if (now - lastAt < MIN_POLL_INTERVAL_MS) return 0;
  _lastPollAt.set(throttleKey, now);
  /* Bound the map: at most a few accounts × a few chains. The bound
     keeps a long-lived popup from leaking entries if anyone ever
     loops over arbitrary addresses. */
  if (_lastPollAt.size > 64) {
    const oldestKey = _lastPollAt.keys().next().value;
    if (oldestKey) _lastPollAt.delete(oldestKey);
  }

  try {
    const { maxBlocksPerPoll: MAX_BLOCKS_PER_POLL, initialLookback: INITIAL_LOOKBACK, keepsUp } =
      windowFor();
    if (!keepsUp) {
      console.warn(
        "[NiceTry] incoming poller cannot keep up with this chain's block " +
          "rate — receives older than the scan window will be missed.",
      );
    }

    const latest = Number(await publicClient.getBlockNumber());
    const cursors = await readCursors(address);
    let { forward, backfillCursor, backfillTarget } = cursors;
    /* Stale-cursor reset: if the forward checkpoint is more than
       2 × INITIAL_LOOKBACK blocks behind latest, the wallet was
       offline for a long stretch or the cursor comes from a previous
       buggy build that anchored at the wrong end of the window.
       Crawling forward one window at a time would take ages — drop the
       cursor and re-bootstrap at the recent window instead.

       This SKIPS the intervening blocks: any receive in them is lost.
       Say so, loudly — a silent gap here is exactly how receives went
       missing on Base before the window was sized off blockTimeSec. */
    if (forward != null && forward < latest - 2 * INITIAL_LOOKBACK) {
      console.warn(
        `[NiceTry] incoming poller: cursor ${latest - forward} blocks behind ` +
          `head — re-anchoring at head, blocks ${forward + 1}..${latest - INITIAL_LOOKBACK} ` +
          `will NOT be scanned.`,
      );
      forward = null;
      backfillCursor = null;
      backfillTarget = null;
    }

    /* ── Bootstrap on first scan ───────────────────────────────────
       No forward checkpoint yet → scan the MOST RECENT window first.
       A receive that just landed is at ~latest; if we instead walked
       back INITIAL_LOOKBACK blocks and scanned that oldest slice
       first, the user would wait several ticks (= minutes) before
       the new tx surfaced. */
    if (forward == null) {
      forward = Math.max(0, latest - MAX_BLOCKS_PER_POLL); // so next scan = [latest-MAX+1, latest]
      backfillCursor = forward; // start walking backward from below the recent window
      backfillTarget = Math.max(0, latest - INITIAL_LOOKBACK);
      await writeCursors(address, { forward, backfillCursor, backfillTarget });
    } else if (backfillCursor == null || backfillTarget == null) {
      /* Upgrade path: forward exists from an older build that didn't
         track backfill cursors. Start backfill at the current forward
         and walk down to latest - INITIAL_LOOKBACK. */
      backfillCursor = forward;
      backfillTarget = Math.max(0, latest - INITIAL_LOOKBACK);
      await writeCursors(address, { backfillCursor, backfillTarget });
    }

    let allFound = [];
    let cursorUpdates = {};

    /* ── Phase 1: forward scan (recent blocks first) ─────────────── */
    if (forward < latest) {
      const fromBlock = forward + 1;
      const toBlock = Math.min(latest, fromBlock + MAX_BLOCKS_PER_POLL - 1);
      const { results: found, highestScanned, throttled } =
        await scanBlockRange(target, fromBlock, toBlock);

      const advance =
        Number.isFinite(highestScanned) && highestScanned >= fromBlock
          ? highestScanned
          : fromBlock - 1;
      if (advance >= fromBlock) cursorUpdates.forward = advance;
      allFound.push(...found);

      /* On 429: skip the backfill phase — doubling the call count
         only deepens the cooldown. Both phases resume next tick. */
      if (throttled) {
        if (Object.keys(cursorUpdates).length > 0) {
          await writeCursors(address, cursorUpdates);
        }
        return await commitFound(target, allFound, true);
      }
    }

    /* ── Phase 2: backfill (oldest blocks behind the recent window) ─ */
    if (
      backfillCursor != null &&
      backfillTarget != null &&
      backfillCursor > backfillTarget
    ) {
      const toBlock = backfillCursor;
      const fromBlock = Math.max(backfillTarget, toBlock - MAX_BLOCKS_PER_POLL + 1);
      const { results: found, highestScanned, throttled } =
        await scanBlockRange(target, fromBlock, toBlock);
      allFound.push(...found);

      /* Backfill walks DOWNWARD. The next tick should pick up where
         this one left off; that means setting the cursor to the
         block just below the slice we managed to fully scan. Use
         the contiguous-from-the-top heuristic: any gap caused by a
         failed fetch leaves the cursor at the gap so we'll retry. */
      let nextCursor = fromBlock - 1;
      if (throttled) {
        // Couldn't finish [fromBlock, toBlock] — leave cursor at toBlock
        // and retry next tick. Don't advance below the failed point.
        nextCursor = toBlock;
      } else if (Number.isFinite(highestScanned) && highestScanned < toBlock) {
        // Some block in [fromBlock, toBlock] failed silently. Resume
        // from there — DO NOT skip the failed range.
        nextCursor = highestScanned;
      }
      cursorUpdates.backfillCursor = Math.max(backfillTarget - 1, nextCursor);
    }

    if (Object.keys(cursorUpdates).length > 0) {
      await writeCursors(address, cursorUpdates);
    }
    return await commitFound(target, allFound, false);
  } catch (e) {
    console.warn("[NiceTry] incoming-tx poll failed:", e);
    return 0;
  }
}

/* Merge newly-found receives into the txHistory signal, deduplicated
   by hash. Returns the count of fresh entries actually appended. */
async function commitFound(_target, allFound, _throttledFlag) {
  if (!allFound || allFound.length === 0) return 0;
  const existingHashes = new Set(
    (txHistory.value || [])
      .map((e) => (e?.txHash ? e.txHash.toLowerCase() : null))
      .filter(Boolean),
  );
  const fresh = allFound.filter(
    (e) => e.txHash && !existingHashes.has(e.txHash.toLowerCase()),
  );
  if (fresh.length === 0) return 0;
  // Insert in chronological order (oldest first) so the relative-time
  // sort in the panel still shows newest at top after reverse().
  fresh.sort((a, b) => a.id - b.id);
  txHistory.value = [...(txHistory.value || []), ...fresh];
  return fresh.length;
}

/**
 * Convenience wrapper: reads the active smart-address from the signal
 * and runs the poll. Used as a fire-and-forget side effect of
 * refreshBalances().
 */
export function pollIncomingForActive() {
  const addr = smartAddr.value;
  if (!addr) return Promise.resolve(0);
  return pollIncomingForSignal(addr);
}
