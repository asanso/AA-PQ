import { pollPendingActivities } from "@/transactions/transaction-activity.js";
/* ═══════════════════════════════════════════════════════════════════
   useBalance — native-token balance for EOA + smart account
   ───────────────────────────────────────────────────────────────────
   Pulls balances from the public RPC client. Not stored in the main
   store because balances are ephemeral display data and refetching
   is cheap; keeping them local avoids polluting the global store.

   Returns reactive signals you can read directly in JSX:

     const { sa, eoa, loading, refresh } = useBalance();
     return <div>{sa.value} ETH</div>;  // 6-decimal string
   ═══════════════════════════════════════════════════════════════════ */

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { formatEther } from "viem";
import { publicClient } from "@/blockchain/client.js";
import { vaultManager } from "@/vault/VaultManager.js";
import { getNetwork } from "@/config/networks.js";
import { chainId, smartAddr } from "@/ui/store.js";
import { pollIncomingForActive } from "@/blockchain/incoming-tx-poller.js";

const saBalance = signal("0.000000");
const eoaBalance = signal("0.000000");
const loading = signal(false);
const error = signal(null);

export async function refreshBalances({ silent = false } = {}) {
  // `silent` = background auto-refresh: don't toggle the spinner or surface
  // transient RPC blips as errors, so the polling tick is invisible until it
  // actually changes a balance value.
  if (!silent) loading.value = true;
  if (!silent) error.value = null;
  try {
    const net = getNetwork(chainId.value);
    // fallback matches the legacy behavior in Dashboard.refreshBalance
    const _rpc = net?.rpcUrl;
    void _rpc; // reserved: if we ever move off publicClient for chain-overrides

    const eoaAddr = vaultManager.activeAddress;
    if (eoaAddr) {
      const b = await publicClient.getBalance({ address: eoaAddr });
      eoaBalance.value = Number(formatEther(b)).toFixed(6);
    } else {
      eoaBalance.value = "0.000000";
    }

    const sa = smartAddr.value || vaultManager.smartAccountAddress;
    if (sa) {
      const b = await publicClient.getBalance({ address: sa });
      saBalance.value = Number(formatEther(b)).toFixed(6);
    } else {
      saBalance.value = "0.000000";
    }
  } catch (e) {
    if (!silent) error.value = e;
  } finally {
    if (!silent) loading.value = false;
  }

  // Piggyback tx scans on every balance refresh — same cadence, no extra
  // polling loop. Fire-and-forget: balance is the primary product of this
  // call, history is a nice-to-have. Incoming = receives; outgoing =
  // OwnerRotated logs so a second device sees the first device's sends
  // (multi-device history alignment), both internally throttled.
  pollPendingActivities().catch(() => {});
  pollIncomingForActive().catch(() => {});
}

/* ── Auto-refresh polling ──────────────────────────────────────────────
   While any balance consumer is mounted (dashboard, Send, Approval…), a
   single shared timer re-fetches balances so incoming assets appear with
   no manual reload. It's SILENT (no spinner) and self-throttling:

     - one timer for all useBalance() consumers, tracked by a mount
       refcount, so it never multiplies across screens;
     - stops when the last consumer unmounts (popup closed) — the
       background chrome.alarms poller then covers receives-while-closed;
     - each tick piggybacks the incoming-tx scan via refreshBalances(),
       itself throttled to MIN_POLL_INTERVAL_MS in the poller.

   4s keeps detection within ~one tick of block inclusion — the real floor
   is block time (a receive is only visible once mined: ~12s on ETH Sepolia
   L1, sub-2s on L2 testnets), so a shorter interval can't beat that. Cheap:
   two getBalance calls per tick; the heavier incoming-tx scan stays
   throttled to MIN_POLL_INTERVAL_MS regardless of this interval. */
const AUTO_REFRESH_MS = 4_000;
let _subscribers = 0;
let _timer = null;

function startAutoRefresh() {
  if (_timer != null) return;
  _timer = setInterval(() => {
    refreshBalances({ silent: true }).catch(() => {});
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (_timer == null) return;
  clearInterval(_timer);
  _timer = null;
}

export function useBalance() {
  // Mount = subscribe to the shared poll loop; unmount = unsubscribe and
  // stop the loop once nobody is watching.
  useEffect(() => {
    _subscribers += 1;
    startAutoRefresh();
    return () => {
      _subscribers -= 1;
      if (_subscribers <= 0) stopAutoRefresh();
    };
  }, []);

  return {
    /** 6-decimal string (e.g. "0.012345") of the smart-account balance. */
    sa: saBalance,
    /** 6-decimal string of the EOA/signer balance. */
    eoa: eoaBalance,
    /** True while refreshBalances() is in flight. */
    loading,
    /** Last fetch error if any. */
    error,
    /** Fire-and-forget refresh. Caller can `await` it for post-hoc UI. */
    refresh: refreshBalances,
  };
}
