import { rpc } from '../native-frame/client.js';
import { receiptOutcome } from '../native-frame/protocol.js';
import { signal } from '@preact/signals';
import { txHistory, smartAddr, chainId, busy } from '@/ui/store.js';
import { upsertActivity, isUnconfirmedActivity } from '@/ui/utils/transaction-activity.js';

export const signedActivity = signal(null);
export const activitySessionId = crypto.randomUUID();
const writes = new Map();
const keyFor = (address, chain) => 'nt_txhistory_' + address.toLowerCase() + '_' + String(chain).toLowerCase();
const isCurrent = entry => smartAddr.value?.toLowerCase() === entry.smartAddr?.toLowerCase()
  && String(chainId.value).toLowerCase() === String(entry.chainId).toLowerCase();

function publish(entry) {
  if (isCurrent(entry)) txHistory.value = upsertActivity(txHistory.value || [], entry);
  const key = keyFor(entry.smartAddr, entry.chainId);
  const queued = (writes.get(key) || Promise.resolve()).then(async () => {
    const stored = await chrome.storage.local.get([key]);
    // Include foreground changes made while the storage read was in flight.
    const base = isCurrent(entry) ? txHistory.value : (stored[key] || []);
    const merged = upsertActivity(base, entry);
    await chrome.storage.local.set({ [key]: merged.slice(-200) });
  }).catch(error => console.warn('[NiceTry] activity persistence:', error?.message));
  writes.set(key, queued);
  return queued;
}

export function createTransactionActivity(details, { notifySigned = true } = {}) {
  let entry = null;
  return {
    get activityId() { return entry?.activityId; },
    async queued() {
      const now = Date.now();
      entry = { ...details, activityId: crypto.randomUUID(), id: now,
        time: new Date(now).toTimeString().slice(0, 8), sessionId: activitySessionId, status: 'queued' };
      try {
        const context = await chrome.runtime.sendMessage({ type: 'GET_WALLET_DOCUMENT' });
        entry = { ...entry, documentId: context?.documentId || null };
      } catch { /* Browser dev preview may not have an extension context. */ }
      await publish(entry);
    },
    async preparing() {
      if (!entry) return;
      entry = { ...entry, status: 'preparing' };
      await publish(entry);
    },
    async cancelled(reason) {
      if (!entry || entry.txHash) return;
      entry = { ...entry, status: 'cancelled', error: reason };
      await publish(entry);
    },
    async signed({ txHash, signingMs, smartAddr: address, frameCount }) {
      const now = Date.now();
      entry = { ...details, activityId: crypto.randomUUID(), id: now,
        time: new Date(now).toTimeString().slice(0, 8), ...entry, signedAt: now,
        smartAddr: address, txHash, frameCount, signingMs, status: 'signed' };
      if (notifySigned) signedActivity.value = entry;
      await publish(entry);
    },
    async submitted({ txHash }) {
      if (!entry) return;
      entry = { ...entry, txHash, status: 'submitted' };
      await publish(entry);
    },
    async included({ txHash, success }) {
      if (!entry) return;
      entry = { ...entry, txHash,
        status: success ? 'confirmed' : 'failed',
        error: success ? undefined : 'Transaction reverted' };
      await publish(entry);
    },
    async complete(result) {
      if (!entry) return;
      entry = { ...entry, ...result, status: 'confirmed' };
      await publish(entry);
    },
    async failed(error) {
      if (!entry || entry.status === 'confirmed' || entry.status === 'failed') return;
      // A transport error or timeout cannot establish rejection. Keep the
      // local transaction hash so reopening the wallet can resolve its receipt.
      const rejected = !entry.txHash;
      entry = { ...entry, status: rejected ? 'failed' : 'unknown',
        error: error?.message || String(error) };
      await publish(entry);
    },
  };
}

let polling = false;
export async function pollPendingActivities() {
  if (polling || busy.value) return;
  // Unsigned requests live only in the window that the user confirmed in.
  // On reopening, make an interrupted queue explicit; never silently resend.
  const abandoned = (txHistory.value || []).filter(tx =>
    ['queued', 'preparing'].includes(tx.status) && tx.sessionId !== activitySessionId);
  for (const entry of abandoned) {
    if (!entry.documentId || !chrome.runtime?.getContexts) continue;
    try {
      const contexts = await chrome.runtime.getContexts({ documentIds: [entry.documentId] });
      if (contexts.length === 0) await publish({ ...entry, status: 'cancelled',
        error: 'Not sent: wallet window was closed. Create a new send to continue.' });
    } catch { /* Another open wallet may still own this queue. */ }
  }
  const entries = (txHistory.value || []).filter(tx => isUnconfirmedActivity(tx) && tx.txHash && tx.smartAddr);
  if (!entries.length) return;
  polling = true;
  try {
    for(const entry of entries) {
      try {
        const outcome=receiptOutcome(await rpc('eth_getTransactionReceipt',[entry.txHash]),entry.txHash,entry.frameCount);
        if(outcome.status!=='pending') await publish({...entry,status:outcome.status,error:outcome.message});
      } catch { /* Missing RPC evidence leaves the submission unresolved. */ }
    }
  } finally {polling=false;}
}
