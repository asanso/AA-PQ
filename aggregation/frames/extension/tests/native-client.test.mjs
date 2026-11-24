import { test as check } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as e from 'ethers';
import { createNativeProtocol, SIGNATURE_BYTES } from '../src/native-frame/native-protocol.mjs';
import { createNativeClient } from '../src/native-frame/native-client.mjs';
import { transportErrors } from './rpc-transport.mjs';

// The native client's network checks, submission outcomes, journal and recovery, against a scripted RPC.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-lean-sphincs.json', import.meta.url), 'utf8'));
const p = createNativeProtocol(e);
const code = { factory: '0x6000', implementation: '0x6001', verifier: '0x6002' };
const config = { ...fixture.config, factoryCodeHash: e.keccak256(code.factory), implementationCodeHash: e.keccak256(code.implementation),
  verifierCodeHash: e.keccak256(code.verifier) };
const key = { publicKey: fixture.publicKey };
const recipient = fixture.recipient;
const signed = { ...key, signature: '0x' + '55'.repeat(SIGNATURE_BYTES) }; // Transport-only, not a valid signature.
const rpcError = (message, rpcCode, httpStatus) => Object.assign(Error(message), { rpcCode, httpStatus });

function context(overrides = {}) {
  const calls = [], journals = [];
  let timestamp = 100000;
  const state = { nonce: '0x0', code: '0x', chainId: '0x' + config.chainId.toString(16), balance: '0x8ac7230489e80000', ...overrides };
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (state.handler) { const result = await state.handler(method, params); if (result !== undefined) return result; }
    if (method === 'eth_chainId') return state.chainId;
    if (method === 'eth_getBlockByNumber') return params[0] === '0x0' ? { hash: config.genesisHash } : { baseFeePerGas: '0x1' };
    if (method === 'eth_getCode') return { [config.factory]: code.factory, [config.implementation]: code.implementation,
      [config.verifier]: code.verifier }[params[0]] ?? state.code;
    if (method === 'eth_call') return e.AbiCoder.defaultAbiCoder().encode(['address'],
      [params[0].data === p.abi.encodeFunctionData('ACCOUNT_IMPL') ? config.implementation : config.verifier]);
    if (method === 'eth_getBalance') return state.balance;
    if (method === 'eth_getTransactionCount') return state.nonce;
    if (method === 'eth_estimateGas') return '0xc350';
    if (method === 'eth_sendRawTransaction') return e.keccak256(params[0]);
    if (method === 'eth_getTransactionReceipt') return null;
    throw Error('Unexpected method: ' + method);
  };
  const client = createNativeClient(e, { config, rpc, now: () => timestamp, receiptOutcome: state.receiptOutcome ?? (() => ({ status: 'pending' })) });
  return { state, calls, journals, client, expire: () => { timestamp += 240001; }, persist: async record => journals.push({ ...record }) };
}
const sends = calls => calls.filter(call => call.method === 'eth_sendRawTransaction');

check('a prepared call creates the account first and journals the signed bytes before submission', async () => {
  const c = context();
  const quote = await c.client.prepareCall(key, recipient, 1n);
  assert.equal(quote.account.address, e.getAddress(fixture.account));
  assert.equal(quote.payload.frameCount, 3);
  let journaledFirst = false;
  const record = await c.client.submitCall(quote, signed, async r => { journaledFirst ||= sends(c.calls).length === 0; await c.persist(r); });
  assert.equal(journaledFirst, true);
  assert.equal(record.status, 'pending');
  assert.equal(record.protocol, 'native');
  assert.equal(e.keccak256(c.journals[0].raw), record.hash);
  assert.equal(e.decodeRlp('0x' + record.raw.slice(4))[5][0][3], signed.signature);
});

check('a deployed account uses its nonce and omits the creation frame', async () => {
  const c = context({ nonce: '0x2', code: p.accountRuntime(config.implementation, key.publicKey) });
  const quote = await c.client.prepareCall(key, recipient, 1n);
  assert.equal(quote.payload.frameCount, 2);
  assert.equal(quote.account.nonce, 2n);
});

check('wrong chain, genesis, contract code, verifier or account code prevents preparation', async () => {
  for (const overrides of [{ chainId: '0x1' },
    { handler: (method, params) => method === 'eth_getBlockByNumber' && params[0] === '0x0' ? { hash: '0x' + '00'.repeat(32) } : undefined },
    { handler: (method, params) => method === 'eth_getCode' && params[0] === config.verifier ? '0x6003' : undefined },
    { handler: (method, params) => method === 'eth_call' && params[0].data === p.abi.encodeFunctionData('LEAN_SPHINCS_VERIFIER')
      ? e.AbiCoder.defaultAbiCoder().encode(['address'], [recipient]) : undefined },
    { code: '0x6000' }]) {
    await assert.rejects(context(overrides).client.prepareCall(key, recipient, 1n), /Unexpected|identity|bytecode/);
  }
});

check('a JSON-RPC refusal of the submission is definite and journaled', async () => {
  for (const error of [rpcError('invalid frame transaction', -32000), rpcError('Invalid params', -32602, 400),
    rpcError('Frame submission requires the configured Daisugi chain and genesis.', -32000, 503)]) {
    const c = context({ handler(method) { if (method === 'eth_sendRawTransaction') throw error; } });
    const record = await c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist);
    assert.equal(record.status, 'failed'); assert.equal(record.rejected, true); assert.match(record.message, /rejected this transaction/);
    assert.equal(c.journals.at(-1).rejected, true);
    assert.equal(sends(c.calls).length, 1);
  }
});

check('an ambiguous submission stays pending with its signed bytes', async () => {
  for (const error of [Error('fetch failed'), rpcError('The upstream RPC is unavailable.', -32000, 502),
    rpcError('already known', -32000), rpcError('nonce too low', -32000), rpcError('replacement transaction underpriced', -32000),
    rpcError('Internal error', -32603), rpcError('Request was canceled due to enabled timeout.', -32016),
    Object.assign(Error('RPC returned HTTP 502.'), { httpStatus: 502 })]) {
    const c = context({ handler(method) { if (method === 'eth_sendRawTransaction') throw error; } });
    const record = await c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist);
    assert.equal(record.status, 'pending'); assert.equal(record.rejected, undefined); assert.match(record.message, /uncertain/);
    assert.equal(e.keccak256(c.journals[0].raw), record.hash);
  }
});

check('the extension transport keeps refusals definite and every unknown outcome open', async () => {
  const reply = (status, code, message) => ({ status, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } }) });
  const cases = [
    [reply(200, -32000, 'invalid frame transaction'), 'failed'],
    [reply(400, -32602, 'Invalid params'), 'failed'],
    [reply(503, -32000, 'Frame submission requires the configured Daisugi chain and genesis.'), 'failed'],
    [reply(200, -32016, 'Request was canceled due to enabled timeout.'), 'pending'],
    [reply(200, -32603, 'Internal error'), 'pending'],
    [reply(502, -32000, 'The upstream RPC is unavailable.'), 'pending'],
    [{ status: 504, body: '<html>Gateway Timeout</html>' }, 'pending'],
    [{ status: 200, body: 'not json' }, 'pending'],
    [{ fetchError: 'TimeoutError' }, 'pending'],
    [{ fetchError: 'NetworkError' }, 'pending']];
  const errors = transportErrors(cases.map(([fetched]) => fetched));
  assert.deepEqual([errors[0].rpcCode, errors[0].httpStatus, errors[6].rpcCode, errors[6].httpStatus], [-32000, 200, undefined, 504]);
  for (const [index, [, status]] of cases.entries()) {
    const c = context({ handler(method) { if (method === 'eth_sendRawTransaction') throw errors[index]; } });
    const record = await c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist);
    assert.equal(record.status, status, JSON.stringify(cases[index][0]));
  }
});

check('journal failure, a changed key, nonce or balance, expiry or a lock prevents broadcast', async () => {
  const attempts = [
    async c => c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, async () => { throw Error('storage full'); }),
    async c => c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), { ...signed, publicKey: '0x' + '22'.repeat(32) }, c.persist),
    async c => { const q = await c.client.prepareCall(key, recipient, 1n); c.state.nonce = '0x1'; return c.client.submitCall(q, signed, c.persist); },
    async c => { const q = await c.client.prepareCall(key, recipient, 1n); c.state.balance = '0x1'; return c.client.submitCall(q, signed, c.persist); },
    async c => { const q = await c.client.prepareCall(key, recipient, 1n); c.expire(); return c.client.submitCall(q, signed, c.persist); },
    async c => c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist, () => { throw Error('locked'); }),
  ];
  for (const attempt of attempts) {
    const c = context();
    await assert.rejects(attempt(c));
    assert.equal(sends(c.calls).length, 0);
  }
});

check('a lock detected after journaling stops before broadcast', async () => {
  const c = context();
  let checks = 0;
  await assert.rejects(c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist,
    () => { if (++checks > 1) throw Error('locked'); }), /locked/);
  assert.equal(c.journals.length, 1);
  assert.equal(sends(c.calls).length, 0);
});

async function recovery(handler, receiptOutcome = () => ({ status: 'pending' })) {
  const c = context();
  const record = await c.client.submitCall(await c.client.prepareCall(key, recipient, 1n), signed, c.persist);
  const calls = [];
  const client = createNativeClient(e, { config, receiptOutcome, rpc: async (method, params) => {
    calls.push({ method, params });
    const result = await handler(method, params);
    if (result !== undefined) return result;
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_sendRawTransaction') return record.hash;
    throw Error('Unexpected method: ' + method);
  } });
  return { record, calls, recover: options => client.recoverRecord(record, options) };
}

check('recovery reads the finalized nonce, then the receipt', async () => {
  const r = await recovery(method => method === 'eth_getTransactionReceipt' ? { status: '0x1' } : undefined, () => ({ status: 'confirmed' }));
  assert.equal((await r.recover()).status, 'confirmed');
  assert.deepEqual(r.calls.map(call => call.method), ['eth_getTransactionCount', 'eth_getTransactionReceipt']);
  assert.equal(r.calls[0].params[1], 'finalized');
});

check('a nonce used by another transaction resolves the record as not included', async () => {
  const r = await recovery(method => method === 'eth_getTransactionCount' ? '0x5' : undefined);
  const result = await r.recover();
  assert.equal(result.status, 'failed'); assert.equal(result.rejected, true); assert.match(result.message, /another transaction/);
});

check('recovery re-sends only the identical signed bytes, and only when asked', async () => {
  const quiet = await recovery(() => undefined);
  assert.equal((await quiet.recover()).status, 'pending');
  assert.equal(sends(quiet.calls).length, 0);
  const loud = await recovery(() => undefined);
  await loud.recover({ rebroadcast: true });
  assert.deepEqual(sends(loud.calls).map(call => call.params[0]), [loud.record.raw]);
});

check('a refused re-send never resolves the record: the first copy may still be admitted', async () => {
  const r = await recovery(method => { if (method === 'eth_sendRawTransaction') throw rpcError('invalid frame transaction', -32000); });
  assert.equal((await r.recover({ rebroadcast: true })).status, 'pending');
});

check('a journal already marked rejected resolves without any request', async () => {
  const r = await recovery(() => undefined);
  const client = createNativeClient(e, { config, receiptOutcome: () => ({ status: 'pending' }), rpc: async () => { throw Error('no request expected'); } });
  assert.equal((await client.recoverRecord({ ...r.record, rejected: true })).status, 'failed');
});
