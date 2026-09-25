/* ═══════════════════════════════════════════════════════════════════
   scan-window.js — size the incoming-tx scan window in TIME, not blocks
   ───────────────────────────────────────────────────────────────────
   Native ETH transfers emit no events, so the only vendor-neutral way to
   spot a receive is to fetch every block and match `to`. The cost of that
   scan is per BLOCK, but the thing we actually care about — "did anything
   land in the last N minutes?" — is measured in TIME. On a 12s chain the
   two are interchangeable; on a 0.25s chain they differ by 48×.

   The old constants (300-block lookback, 50 blocks per poll) were tuned on
   Sepolia and silently broke everywhere else. With a 3-minute background
   alarm advancing at most 50 blocks:

     Sepolia   12s   → chain makes  15 blk/tick, we scan 50  → catches up
     Base       2s   → chain makes  90 blk/tick, we scan 50  → falls behind
     OP         2s   → chain makes  90 blk/tick, we scan 50  → falls behind
     Arbitrum   0.25s→ chain makes 720 blk/tick, we scan 50  → hopeless

   Once the forward cursor drifts past 2×lookback, the poller's stale-cursor
   reset re-anchors it at `latest` and the skipped range is never scanned —
   the receive is lost with no error. Sizing both knobs off blockTimeSec
   keeps the forward scan ahead of the chain on every network.

   Both the popup poller (blockchain/incoming-tx-poller.js) and the service
   worker (background/index.js) derive their windows here so the two can
   never disagree about how far back history goes.
   ═══════════════════════════════════════════════════════════════════ */

/* How much history the very first scan walks back to. One hour on a 12s
   chain reproduces the old 300-block Sepolia behaviour exactly. */
const LOOKBACK_SEC = 3600;

/* Headroom on the forward scan: we cover SAFETY× as many blocks as the
   chain can produce between two polls, so a late/slow tick still catches
   up instead of compounding the drift. */
const SAFETY = 2;

/* Absolute ceilings. Every block costs one eth_getBlockByNumber (batched
   into few HTTP round-trips, but still bytes on the wire), so an
   unbounded window would hammer the free public RPCs after a long
   offline stretch. Past the cap we accept a gap — and say so out loud,
   see scanWindow().droppingHistory. */
const MAX_BLOCKS_PER_POLL = 1000;
const MAX_LOOKBACK_BLOCKS = 2000;

/* Floor: never scan fewer than this per poll, even on slow chains where
   the arithmetic would suggest 5. Keeps the Sepolia behaviour unchanged. */
const MIN_BLOCKS_PER_POLL = 50;

/**
 * Window sizes for one network at a given poll cadence.
 *
 * @param {object} net           entry from config/networks.js NETWORKS
 * @param {number} pollIntervalSec seconds between two consecutive polls
 * @returns {{
 *   maxBlocksPerPoll: number,   // forward scan cap for a single tick
 *   initialLookback: number,    // how far back the first scan reaches
 *   blocksPerPoll: number,      // blocks the chain produces per interval
 *   keepsUp: boolean,           // false → forward scan drifts, gaps happen
 * }}
 */
export function scanWindow(net, pollIntervalSec) {
  const bt = net?.blockTimeSec > 0 ? net.blockTimeSec : 12;

  const produced = Math.ceil(pollIntervalSec / bt);
  const maxBlocksPerPoll = Math.min(
    MAX_BLOCKS_PER_POLL,
    Math.max(MIN_BLOCKS_PER_POLL, produced * SAFETY),
  );
  const initialLookback = Math.min(
    MAX_LOOKBACK_BLOCKS,
    Math.ceil(LOOKBACK_SEC / bt),
  );

  return {
    maxBlocksPerPoll,
    initialLookback,
    blocksPerPoll: produced,
    keepsUp: maxBlocksPerPoll >= produced,
  };
}
