export const isPendingActivity = tx => ['queued', 'preparing', 'signed', 'submitted'].includes(tx?.status);
export const isUnconfirmedActivity = tx => isPendingActivity(tx) || tx?.status === 'unknown';

export function formatSigningMs(ms) {
  return Number.isFinite(ms) && ms >= 0 ? String(Number(ms.toFixed(ms < 1 ? 2 : 1))) + ' ms' : null;
}

// Replace a pending row in place, including any copy discovered by a poller.
// Never turn an observed successful receipt back into pending or failed.
export function upsertActivity(items, update) {
  const same = item => (update.activityId && item.activityId === update.activityId)
    || (update.txHash && item.txHash?.toLowerCase() === update.txHash.toLowerCase())
    || (update.userOpHash && item.userOpHash?.toLowerCase() === update.userOpHash.toLowerCase());
  const matches = items.filter(same);
  const existing = matches.find(item => item.activityId) || matches[0];
  let merged = { ...existing, ...update };
  if (existing) merged.id = existing.id;
  if (matches.some(item => item.status === 'confirmed') && update.status !== 'confirmed') {
    merged = { ...merged, ...matches.find(item => item.status === 'confirmed') };
  }
  const first = items.findIndex(same);
  const remaining = items.filter(item => !same(item));
  remaining.splice(first < 0 ? remaining.length : first, 0, merged);
  return remaining;
}
