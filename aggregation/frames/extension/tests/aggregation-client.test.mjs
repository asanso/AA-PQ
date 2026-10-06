import assert from 'node:assert/strict';
import {test as check} from 'node:test';
import * as e from 'ethers';
import { createProtocol } from '../src/aggregated-frame/protocol.mjs';
import { createClient } from '../src/aggregated-frame/client.mjs';

const p = createProtocol(e);
const key = { backupPkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), backupPkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16) };
const config = { factory: '0x0000000000000000000000000000000000000010', implementation: '0x0000000000000000000000000000000000000020',
  genesisHash: '0x' + '33'.repeat(32), factoryCodeHash: e.keccak256('0x6000'),
  implementationCodeHash: e.keccak256(p.implementationRuntime()), profile: p.domain, maxFeePerGas: '100000000000' };
const recipient = '0x0000000000000000000000000000000000000040';
const options = { config, pkSeed: key.backupPkSeed, pkRoot: key.backupPkRoot, nonce: 0, recipient, value: 1,
  deployed: false, maxFee: 3000000000n, priorityFee: 1000000000n };
const signed = { ...key, signature: '0x' + '55'.repeat(6176) }; // Transport-only fixture, not a valid signature.
function context(overrides = {}) {
  const calls = [], journals = [], delays = [];
  let timestamp = 100000;
  const state = { nonce: '0x0', code: '0x', chainId: '0x539', ...overrides };
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (state.handler) { const result = await state.handler(method, params); if (result !== undefined) return result; }
    if (method === 'eth_blockNumber') return delays.length ? '0x2' : '0x1';
    if (method === 'eth_chainId') return state.chainId;
    if (method === 'eth_getBlockByNumber') return params[0] === '0x0' ? { hash: config.genesisHash } : { baseFeePerGas: '0x1' };
    if (method === 'eth_getCode') return params[0] === config.factory ? '0x6000' : params[0] === config.implementation ? p.implementationRuntime() : state.code;
    if (method === 'eth_call') return p.abi.encodeFunctionResult('ACCOUNT_IMPL', [config.implementation]);
    if (method === 'eth_getProofWrapper') { const error = Error('Proof wrapper is not ready; retry after the next background cycle.'); error.rpcCode = -32000; throw error; }
    if (method === 'eth_getBalance') return '0x8ac7230489e80000';
    if (method === 'eth_getTransactionCount') return state.nonce;
    if (method === 'eth_estimateGas') return '0xc350';
    if (method === 'eth_sendProofWrapper') return [e.keccak256(e.decodeRlp(params[0])[0][0])];
    if (method === 'eth_getTransactionReceipt') return null;
    throw Error('Unexpected method: ' + method);
  };
  const client = createClient(e, { config, rpc, delay: async ms => { delays.push(ms); }, now: () => timestamp, receiptOutcome: () => ({ status: 'pending' }) });
  return { state, calls, journals, delays, client, expire: () => { timestamp += 240001; }, persist: async record => journals.push({ ...record }) };
}

await check('First send encodes a keyed nonce and four frames', () => {
  const prepared = p.prepare(options), request = p.signedRequest(prepared, signed.signature);
  const payload = e.decodeRlp('0x' + request.raw.slice(4));
  assert.deepEqual(payload[1], ['0x']); assert.equal(payload[4].length, 4); assert.deepEqual(payload[5], []);
  const wrapper = e.decodeRlp(request.wrapper);
  assert.equal(wrapper[0][0], request.raw); assert.equal(wrapper[1], '0x');
  assert.equal(e.getBytes(wrapper[2][1][0]).length, 6208);
  assert.equal(request.hash, e.keccak256(request.raw));
});
await check('Existing account uses its supplied nonce and three frames', () => {
  const prepared = p.prepare({ ...options, deployed: true, nonce: 2 });
  assert.equal(prepared.transaction.nonce, '2'); assert.equal(prepared.transaction.frames.length, 3);
});
for (const [name, change] of [
  ['recipient', t => { t.frames.at(-1).target = config.factory; }],
  ['value', t => { t.frames.at(-1).value = '2'; }],
  ['calldata', t => { t.frames.at(-1).data = '0xab'; }],
  ['fee', t => { t.maxFee = '4000000000'; }],
  ['nonce key', t => { t.nonceKeys = ['1']; }],
  ['creation arguments', t => { t.frames[0].data = t.frames[0].data.slice(0, -2) + '01'; }],
  ['recent roots', t => { t.recentRootReferences = [{}]; }],
]) await check('Changed ' + name + ' is rejected before submission', () => {
  const prepared = p.prepare(options); change(prepared.transaction);
  assert.throws(() => p.signedRequest(prepared, signed.signature));
});
await check('Wrong signature length is rejected', () => assert.throws(() => p.signedRequest(p.prepare(options), '0x')));
await check('Network identity must be pinned', () => assert.throws(() => createClient(e, { config: {}, rpc() {} })));
await check('Fork-unavailable RPC fails closed', async () => {
  const c = context({ handler(method) { if (method === 'eth_getProofWrapper') { const error = Error('Unavailable'); error.rpcCode = -32601; throw error; } } });
  await assert.rejects(c.client.prepareCall(key, recipient, 1), /Unavailable/);
});
await check('Wrong chain prevents signing preparation', async () => {
  const c = context({ chainId: '0xaa36a7' }); await assert.rejects(c.client.prepareCall(key, recipient, 1), /Unexpected network/);
});
await check('Unexpected account runtime prevents signing', async () => {
  const c = context({ code: '0x6001' }); await assert.rejects(c.client.prepareCall(key, recipient, 1), /account bytecode/);
});
await check('Journal failure prevents broadcast', async () => {
  const c = context(), quote = await c.client.prepareCall(key, recipient, 1);
  await assert.rejects(c.client.submitCall(quote, signed, async () => { throw Error('Storage unavailable'); }), /Storage/);
  assert.equal(c.calls.filter(call => call.method.startsWith('eth_send')).length, 0);
});
await check('Nonce change prevents broadcast', async () => {
  const c = context(), quote = await c.client.prepareCall(key, recipient, 1); c.state.nonce = '0x2';
  await assert.rejects(c.client.submitCall(quote, signed, c.persist), /state changed/);
  assert.equal(c.journals.length, 0);
});
await check('Expired preparation prevents broadcast', async () => {
  const c = context(), quote = await c.client.prepareCall(key, recipient, 1); c.expire();
  await assert.rejects(c.client.submitCall(quote, signed, c.persist), /expired/);
});
await check('Session lock is rechecked after persisting', async () => {
  const c = context(), quote = await c.client.prepareCall(key, recipient, 1); let checks = 0;
  await assert.rejects(c.client.submitCall(quote, signed, c.persist, () => { if (++checks === 2) throw Error('Locked'); }), /Locked/);
  assert.equal(c.calls.filter(call => call.method.startsWith('eth_send')).length, 0);
});
await check('Only proof-wrapper submission is used', async () => {
  const c = context(), quote = await c.client.prepareCall(key, recipient, 1, '0x1234');
  const record = await c.client.submitCall(quote, signed, c.persist);
  assert.equal(record.frameCount, 4); assert.equal(c.journals.length, 1);
  assert.deepEqual(c.calls.filter(call => call.method.startsWith('eth_send')).map(call => call.method), ['eth_sendProofWrapper']);
});
await check('Zero-value estimation uses canonical JSON-RPC quantities', async () => {
  const c = context();
  await c.client.prepareCall(key, recipient, 0);
  assert.equal(c.calls.find(call=>call.method==='eth_estimateGas').params[0].value, '0x0');
});
for (const scenario of ['timeout', 'wrong hash']) await check('Ambiguous ' + scenario + ' retains hash without retry', async () => {
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') { if (scenario === 'timeout') throw Error('Timeout'); return [config.genesisHash]; } } });
  const quote = await c.client.prepareCall(key, recipient, 1), record = await c.client.submitCall(quote, signed, c.persist);
  assert.match(record.message, /uncertain/); assert.equal(record.status, 'pending'); assert.equal(c.journals.length, 2);
  assert.equal(c.calls.filter(call => call.method.startsWith('eth_send')).length, 1);
});

const admissionTimeout = () => Object.assign(Error('frame transaction validation-prefix simulation failed, validation-prefix simulation timed out'), { rpcCode: -32000 });
await check('Definite admission timeout retries the identical wrapper once', async () => {
  let attempts = 0;
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper' && attempts++ === 0) throw admissionTimeout(); } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  const record = await c.client.submitCall(quote, signed, c.persist);
  const sends = c.calls.filter(call => call.method === 'eth_sendProofWrapper');
  assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]);
  assert.equal(record.message, undefined); assert.deepEqual(c.delays, [500]);
});
await check('A stalled chain never triggers a retry', async () => {
  const c = context({ handler(method) {
    if (method === 'eth_sendProofWrapper') throw admissionTimeout();
    if (method === 'eth_blockNumber') return '0x1';
  } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  const record = await c.client.submitCall(quote, signed, c.persist);
  assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 1);
  assert.equal(c.delays.length, 12); assert.match(record.message, /uncertain/);
});
await check('Persistent admission timeout stops after one retry', async () => {
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw admissionTimeout(); } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  const record = await c.client.submitCall(quote, signed, c.persist);
  assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 2);
  assert.match(record.message, /uncertain/);
});
await check('Invalid proof errors are never retried', async () => {
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw Object.assign(Error('Invalid proof'), { rpcCode: -32000 }); } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  await c.client.submitCall(quote, signed, c.persist);
  assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 1);
  assert.deepEqual(c.delays, []);
});
await check('A session locked during admission retry prevents another send', async () => {
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw admissionTimeout(); } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  await c.client.submitCall(quote, signed, c.persist, () => { if (c.delays.length) throw Error('Locked'); });
  assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 1);
});
await check('Expired preparation during admission retry prevents another send', async () => {
  const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw admissionTimeout(); } });
  const quote = await c.client.prepareCall(key, recipient, 1);
  await c.client.submitCall(quote, signed, c.persist, () => { if (c.delays.length) c.expire(); });
  assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 1);
});
