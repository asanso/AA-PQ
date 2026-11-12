// Recovers an account's journaled frame submission for the activity poller.
//
// The send path writes and removes the journal under the shared signing lock and signs only while it holds it. The
// poller takes the same lock only for its two storage steps: it never signs, and its network work concerns one fixed
// hash. Each read is evidence about that hash alone, and a re-send carries the identical signed bytes, so neither can
// create a conflicting transaction. A resolved journal is removed only if it still holds that hash, so a journal that a
// send replaced or removed in the meantime is never touched.
const same = (journal, hash) => typeof hash === 'string' && journal?.hash?.toLowerCase() === hash.toLowerCase();

/**
 * @param {object} o
 * @param {string} o.hash Transaction hash of the activity being polled.
 * @param {{get(): Promise<object|undefined>, set(value: object): Promise<void>, remove(): Promise<void>}} o.storage
 *   The account's journal entry.
 * @param {(fn: () => Promise<any>) => Promise<any>} o.lock Runs fn under the shared signing lock; throws when it is busy.
 * @param {(record: object, options: {rebroadcast: boolean}) => Promise<object>} o.recover The client's recoverRecord.
 * @returns {Promise<object|null>} The recovery outcome, or null when the journal no longer holds this hash.
 */
export async function recoverJournal({ hash, storage, lock, recover, now = Date.now, rebroadcastEveryMs = 30000 }) {
  if (!same(await storage.get(), hash)) return null;
  // Claim the re-send slot (at most one re-send per 30 s across all wallet pages) and take a snapshot.
  const claim = await lock(async () => {
    const journal = await storage.get();
    if (!same(journal, hash)) return null;
    const rebroadcast = now() - (journal.rebroadcastAt ?? 0) > rebroadcastEveryMs;
    if (rebroadcast) await storage.set({ ...journal, rebroadcastAt: now() });
    return { journal, rebroadcast };
  });
  if (!claim) return null;
  const outcome = await recover(claim.journal, { rebroadcast: claim.rebroadcast });
  if (outcome.status !== 'pending') await lock(async () => { if (same(await storage.get(), hash)) await storage.remove(); });
  return outcome;
}
