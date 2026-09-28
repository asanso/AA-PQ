import { signal } from '@preact/signals';
import { busy, chainId, smartAddr, txHistory } from '@/ui/store.js';
import { vaultManager } from '@/vault/VaultManager.js';
import { createTransactionActivity } from './transaction-activity.js';
import { isUnconfirmedActivity } from '@/ui/utils/transaction-activity.js';

// Serialize the existing native nonce ordering. Only user-confirmed,
// immutable requests enter this queue; no private keys are persisted here.
export const manualSendCount = signal(0);
let tail = Promise.resolve();
const jobs = new Map();

export function assertSendContext(request) {
  if (!vaultManager.isUnlocked() || vaultManager.getActiveAccountIndex() !== request.accountIndex
      || String(chainId.value) !== String(request.chainId)
      || smartAddr.value?.toLowerCase() !== request.smartAddr?.toLowerCase()) {
    throw new Error('Wallet account changed or was locked. Create a new send to continue.');
  }
}

export async function cancelQueuedSend(activityId) {
  const job = jobs.get(activityId);
  if (!job || job.started || job.cancelled) return;
  job.cancelled = true;
  await job.activity.cancelled('Cancelled before signing.');
}

export async function runQueuedSend(request, execute) {
  assertSendContext(request);
  const queued = manualSendCount.value > 0;
  if (!queued && (busy.value || (txHistory.value || []).some(tx =>
    isUnconfirmedActivity(tx) && tx.txHash))) {
    throw new Error('A previous transaction is still unresolved. Wait for its confirmation before confirming this send.');
  }
  const activity = queued ? createTransactionActivity({
    to: request.recipient, amount: request.amount, smartAddr: request.smartAddr,
    chainId: request.chainId, accountIndex: request.accountIndex, mode: 'SPHINCS',
    kind: request.selectedToken ? 'send-token' : undefined,
    tokenSymbol: request.selectedToken?.symbol, tokenAddress: request.selectedToken?.address,
  }, { notifySigned: false }) : null;
  const previous = tail;
  manualSendCount.value++;
  const ready = activity ? activity.queued() : Promise.resolve();
  const job = { activity, started: false, cancelled: false };
  if (activity) jobs.set(activity.activityId, job);
  const completion = (async () => {
    try {
      await ready;
      await previous;
      if (job.cancelled) return { cancelled: true };
      assertSendContext(request);
      job.started = true;
      if (activity) await activity.preparing();
      const result = await execute(request, { activity, background: queued });
      if (!result?.txHash) throw new Error('Previous send did not complete. Create a new send to continue.');
      return result;
    } catch (error) {
      if (activity && !job.cancelled) {
        if (job.started) await activity.failed(error);
        else await activity.cancelled('Not sent: ' + (error?.message || String(error)));
      }
      throw error;
    } finally {
      if (activity) jobs.delete(activity.activityId);
      manualSendCount.value--;
      if (!manualSendCount.value) tail = Promise.resolve();
    }
  })();
  tail = completion;
  // Queued callers return immediately. Failure remains visible in history and
  // rejects the predecessor awaited by later jobs, preventing further sends.
  completion.catch(() => {});
  if (queued) { await ready; return { queued: true }; }
  return completion;
}
