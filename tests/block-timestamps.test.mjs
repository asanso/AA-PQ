import test from 'node:test';
import assert from 'node:assert/strict';
import {createBlockTimestampReader} from '../explorer/block-timestamps.mjs';

const hash = digit => '0x' + digit.repeat(64);

test('operations in the same inclusion block share one cached RPC read', async () => {
  let calls = 0;
  const attach = createBlockTimestampReader({async getBlock(blockHash) {
    calls++;
    return {hash: blockHash, timestamp: 1700000000};
  }});
  const records = [{blockHash: hash('a'), nonce: 1}, {blockHash: hash('a'), nonce: 2}];
  const [first, second] = await Promise.all([attach(records), attach(records)]);
  assert.equal(calls, 1);
  assert.deepEqual(first.map(record => record.timestamp), [1700000000, 1700000000]);
  assert.deepEqual(first, second);
  assert.equal(records[0].timestamp, undefined);
  await attach(records);
  assert.equal(calls, 1);
});

test('reorganized blocks at the same height keep their own timestamps', async () => {
  const attach = createBlockTimestampReader({async getBlock(blockHash) {
    return {hash: blockHash, timestamp: blockHash === hash('a') ? 100 : 102};
  }});
  const records = await attach([{blockHash: hash('a'), blockNumber: 5}, {blockHash: hash('b'), blockNumber: 5}]);
  assert.deepEqual(records.map(record => record.timestamp), [100, 102]);
});

test('missing, malformed or failed block reads preserve records without fabricated dates', async () => {
  let calls = 0;
  const attach = createBlockTimestampReader({async getBlock(blockHash) {
    calls++;
    if (blockHash === hash('a')) throw new Error('RPC unavailable');
    if (blockHash === hash('b')) return null;
    if (blockHash === hash('c')) return {hash: hash('d'), timestamp: 123};
    return {hash: blockHash, timestamp: null};
  }});
  const records = [{blockHash: hash('a')}, {blockHash: hash('b')}, {blockHash: hash('c')}, {blockHash: hash('d')}, {blockHash: null}, {blockHash: 'invalid'}];
  assert.deepEqual((await attach(records)).map(record => record.timestamp), records.map(() => null));
  assert.equal(calls, 4);
  await attach([{blockHash: hash('a')}]);
  assert.equal(calls, 5, 'failed reads remain retryable');
});

test('cache capacity is bounded and timestamp zero is preserved', async () => {
  let calls = 0;
  const attach = createBlockTimestampReader({async getBlock(blockHash) {
    calls++;
    return {hash: blockHash, timestamp: 0};
  }}, {maximum: 1});
  assert.equal((await attach([{blockHash: hash('a')}]))[0].timestamp, 0);
  await attach([{blockHash: hash('b')}]);
  await attach([{blockHash: hash('a')}]);
  assert.equal(calls, 3);
});

test('large record lists preserve order and limit concurrent block reads', async () => {
  let active = 0, maximum = 0;
  const attach = createBlockTimestampReader({async getBlock(blockHash) {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return {hash: blockHash, timestamp: 100};
  }});
  const records = Array.from({length: 12}, (_, index) => ({blockHash: '0x' + index.toString(16).padStart(64, '0'), index}));
  const result = await attach(records);
  assert.equal(maximum, 4);
  assert.deepEqual(result.map(record => record.index), records.map(record => record.index));
  assert.deepEqual(await attach([]), []);
});
