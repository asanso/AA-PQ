import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverJournal } from '../src/native-frame/journal.mjs';

const H = '0x' + 'ab'.repeat(32), H2 = '0x' + 'cd'.repeat(32);
const journal = (hash = H, extra = {}) => ({ hash, nonce: '2', wrapper: '0xf8aa', status: 'pending', ...extra });

// The shared signing lock: one holder at a time, and a busy lock throws instead of waiting, like withSigningLock.
function fixture(initial = journal()) {
  let value = initial, held = false;
  const locks = [];
  const lock = async fn => {
    if (held) throw Error('Another signing request is already in progress');
    held = true; locks.push('acquire');
    try { return await fn(); } finally { held = false; }
  };
  const storage = { get: async () => value, set: async next => { value = next; }, remove: async () => { value = undefined; } };
  return { storage, lock, locks, isHeld: () => held, current: () => value };
}

test('network recovery runs with the signing lock free, so a send can take it meanwhile', async () => {
  const f = fixture();
  let heldDuringRecovery, sendGotLock = false;
  await recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async record => {
    heldDuringRecovery = f.isHeld();
    await f.lock(async () => { sendGotLock = true; });
    return { ...record, status: 'pending' };
  } });
  assert.equal(heldDuringRecovery, false);
  assert.equal(sendGotLock, true);
});

test('a resolved journal is removed and a pending one is kept', async () => {
  for (const [status, kept] of [['confirmed', false], ['failed', false], ['pending', true]]) {
    const f = fixture();
    const outcome = await recoverJournal({ hash: H.toUpperCase().replace('0X', '0x'), storage: f.storage, lock: f.lock,
      recover: async record => ({ ...record, status }) });
    assert.equal(outcome.status, status);
    assert.equal(f.current() !== undefined, kept, status);
  }
});

test('a journal that a send replaced or removed during recovery is left alone', async () => {
  let f = fixture();
  await recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async record => {
    await f.lock(() => f.storage.set(journal(H2)));
    return { ...record, status: 'confirmed' };
  } });
  assert.equal(f.current().hash, H2);
  f = fixture();
  await recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async record => {
    await f.lock(() => f.storage.remove());
    return { ...record, status: 'pending' };
  } });
  assert.equal(f.current(), undefined);
});

test('only one wallet page re-sends per interval', async () => {
  const f = fixture();
  let clock = 1_000_000;
  const resends = [];
  const poll = () => recoverJournal({ hash: H, storage: f.storage, lock: f.lock, now: () => clock,
    recover: async (record, { rebroadcast }) => { resends.push(rebroadcast); return { ...record, status: 'pending' }; } });
  const results = await Promise.allSettled([poll(), poll(), poll()]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(resends.filter(Boolean).length, 1);
  await poll();
  assert.equal(resends.filter(Boolean).length, 1);
  clock += 30_001;
  await poll();
  assert.equal(resends.filter(Boolean).length, 2);
});

test('a busy lock skips the poll before any network work', async () => {
  const f = fixture();
  let recovered = false;
  await f.lock(async () => {
    await assert.rejects(recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async () => { recovered = true; } }),
      /already in progress/);
  });
  assert.equal(recovered, false);
  assert.equal(f.current().hash, H);
});

test('without a journal for this hash nothing is locked or recovered', async () => {
  for (const initial of [null, journal(H2)]) {
    const f = fixture(initial);
    let recovered = false;
    assert.equal(await recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async () => { recovered = true; } }), null);
    assert.deepEqual(f.locks, []); assert.equal(recovered, false);
  }
});

test('recovery gets the journaled record itself, so a re-send carries the identical signed wrapper', async () => {
  const f = fixture(journal(H, { wrapper: '0xdeadbeef' }));
  let seen;
  await recoverJournal({ hash: H, storage: f.storage, lock: f.lock, recover: async record => { seen = record; return { ...record, status: 'pending' }; } });
  assert.equal(seen.wrapper, '0xdeadbeef');
  assert.equal(seen.hash, H);
});
