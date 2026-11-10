import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createProtocol } from './protocol.mjs';
import { createClient } from './client.mjs';

const e = createRequire(resolve(process.argv[2] ?? 'frontend/package.json'))('ethers');
const p = createProtocol(e);
const key = { backupPkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), backupPkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16) };
const config = { factory: '0x0000000000000000000000000000000000000010', implementation: '0x0000000000000000000000000000000000000020',
  chainId: 1337, genesisHash: '0x' + '33'.repeat(32), factoryCodeHash: e.keccak256('0x6000'),
  implementationCodeHash: e.keccak256(p.implementationRuntime()), profile: p.domain, maxFeePerGas: '100000000000' };
const recipient = '0x0000000000000000000000000000000000000040';
const options = { config, pkSeed: key.backupPkSeed, pkRoot: key.backupPkRoot, nonce: 0, recipient, value: 1,
  deployed: false, maxFee: 3000000000n, priorityFee: 1000000000n };
const signed = { ...key, signature: '0x' + '55'.repeat(6176) }; // Transport-only fixture, not a valid signature.
let checked = 0;
async function check(name, run) { await run(); checked++; console.log('PASS ' + name); }
function context(overrides = {}, clientConfig = config) {
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
  const client = createClient(e, { config: clientConfig, rpc, delay: async ms => { delays.push(ms); }, now: () => timestamp, receiptOutcome: () => ({ status: 'pending' }) });
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
const rpcError = (message, rpcCode, httpStatus) => Object.assign(Error(message), { rpcCode, httpStatus });
await check('A JSON-RPC rejection of the submission is definite and journaled', async () => {
  for (const error of [rpcError('a wrapper dependency proof failed verification', -32000),
    rpcError('Native aggregation is not enabled on this endpoint.', -32602, 400),
    rpcError('Frame submission requires the configured Daisugi chain and genesis.', -32000, 503)]) {
    const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw error; } });
    const quote = await c.client.prepareCall(key, recipient, 1);
    const record = await c.client.submitCall(quote, signed, c.persist);
    assert.equal(record.status, 'failed'); assert.equal(record.rejected, true); assert.match(record.message, /rejected this transaction/);
    assert.equal(c.journals.at(-1).rejected, true);
    assert.equal(c.calls.filter(call => call.method === 'eth_sendProofWrapper').length, 1);
  }
});
await check('An ambiguous submission stays pending with its signed wrapper', async () => {
  for (const error of [Error('fetch failed'), rpcError('The upstream RPC is unavailable.', -32000, 502),
    rpcError('already known', -32000), rpcError('AlreadyKnown', -32010), rpcError('keyed nonce sequence not current', -32000),
    rpcError('replacement transaction underpriced', -32000), rpcError('Internal error', -32603),
    rpcError('eth_sendProofWrapper request was canceled due to enabled timeout.', -32016),
    rpcError('Request was canceled due to enabled timeout.', -32016),
    Object.assign(Error('RPC returned HTTP 502.'), { httpStatus: 502 })]) {
    const c = context({ handler(method) { if (method === 'eth_sendProofWrapper') throw error; } });
    const quote = await c.client.prepareCall(key, recipient, 1);
    const record = await c.client.submitCall(quote, signed, c.persist);
    assert.equal(record.status, 'pending'); assert.equal(record.rejected, undefined); assert.match(record.message, /uncertain/);
    assert.equal(e.keccak256(e.decodeRlp(c.journals[0].wrapper)[0][0]), record.hash);
  }
});
async function recovery(handler, outcome = () => ({ status: 'pending' })) {
  const c = context();
  const quote = await c.client.prepareCall(key, recipient, 1);
  const record = await c.client.submitCall(quote, signed, c.persist);
  const calls = [];
  const client = createClient(e, { config, receiptOutcome: outcome, rpc: async (method, params) => {
    calls.push({ method, params });
    const result = await handler(method, params);
    if (result !== undefined) return result;
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_getTransactionReceipt') return null;
    throw Error('Unexpected method: ' + method);
  } });
  return { record, calls, recover: options => client.recoverRecord(record, options) };
}
await check('Recovery reads the nonce before the receipt and finds an included transaction', async () => {
  const r = await recovery(method => method === 'eth_getTransactionReceipt' ? { status: '0x1' } : undefined,
    receipt => receipt ? { status: 'confirmed', receipt } : { status: 'pending' });
  assert.equal((await r.recover({ rebroadcast: true })).status, 'confirmed');
  assert.deepEqual(r.calls.map(call => call.method), ['eth_getTransactionCount', 'eth_getTransactionReceipt']);
  assert.equal(r.calls[0].params[1], 'finalized');
});
await check('Without a finalized nonce only the receipt resolves a record', async () => {
  for (const finalized of [() => { throw rpcError('unknown block: finalized', -32001); }, () => null]) {
    let r = await recovery(method => method === 'eth_getTransactionCount' ? finalized() : method === 'eth_getTransactionReceipt' ? { status: '0x1' } : undefined,
      receipt => receipt ? { status: 'confirmed', receipt } : { status: 'pending' });
    assert.equal((await r.recover()).status, 'confirmed');
    r = await recovery(method => method === 'eth_getTransactionCount' ? finalized() : undefined);
    const outcome = await r.recover({ rebroadcast: true });
    assert.equal(outcome.status, 'pending'); assert.equal(outcome.rejected, undefined);
    assert.deepEqual(r.calls.filter(call => call.method === 'eth_sendProofWrapper').map(call => call.params), [[r.record.wrapper]]);
  }
});
await check('A refused re-send never resolves the record: the first copy may still be admitted', async () => {
  for (const error of [rpcError('Proof admission is busy; retry later.', -32010), rpcError('a wrapper dependency proof failed verification', -32000),
    rpcError('Native aggregation is not enabled on this endpoint.', -32602, 400), rpcError('nonce too low', -32000)]) {
    const r = await recovery(method => { if (method === 'eth_sendProofWrapper') throw error; });
    const outcome = await r.recover({ rebroadcast: true });
    assert.equal(outcome.status, 'pending'); assert.equal(outcome.rejected, undefined);
  }
});
await check('A journal already marked rejected resolves without any request', async () => {
  const r = await recovery(() => undefined);
  const calls = [];
  const client = createClient(e, { config, receiptOutcome: () => ({ status: 'pending' }), rpc: async method => { calls.push(method); } });
  const resolved = await client.recoverRecord({ ...r.record, status: 'failed', rejected: true }, { rebroadcast: true });
  assert.equal(resolved.status, 'failed'); assert.deepEqual(calls, []);
});
await check('A nonce used by another transaction resolves the record as not included', async () => {
  const r = await recovery(method => method === 'eth_getTransactionCount' ? '0x1' : undefined);
  const outcome = await r.recover({ rebroadcast: true });
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.rejected, true);
  assert.equal(r.calls.some(call => call.method === 'eth_sendProofWrapper'), false);
});
await check('Recovery re-sends only the identical signed wrapper, and only when asked', async () => {
  let r = await recovery(() => undefined);
  assert.equal((await r.recover()).status, 'pending');
  assert.equal(r.calls.some(call => call.method === 'eth_sendProofWrapper'), false);
  r = await recovery(method => method === 'eth_sendProofWrapper' ? ['0x'] : undefined);
  assert.equal((await r.recover({ rebroadcast: true })).status, 'pending');
  assert.deepEqual(r.calls.filter(call => call.method === 'eth_sendProofWrapper').map(call => call.params), [[r.record.wrapper]]);
  r = await recovery(method => { if (method === 'eth_sendProofWrapper') throw Error('fetch failed'); });
  assert.equal((await r.recover({ rebroadcast: true })).status, 'pending');
  r = await recovery(method => method === 'eth_sendProofWrapper' ? ['0x'] : undefined);
  r.record.wrapper = e.encodeRlp([['0x06c0'], '0x', [[], []]]);
  assert.equal((await r.recover({ rebroadcast: true })).status, 'pending');
  assert.equal(r.calls.some(call => call.method === 'eth_sendProofWrapper'), false);
});
await check('Chain ID must be pinned as a positive integer', () => {
  for (const chainId of [undefined, '1337', 0, 1.5])
    assert.throws(() => createClient(e, { config: { ...config, chainId }, rpc() {}, receiptOutcome() {} }), /pinned network/);
});
await check('Another chain signs its own chain ID and refuses Daisugi', async () => {
  const other = { ...config, chainId: 7357 };
  const quote = await context({ chainId: '0x1cbd' }, other).client.prepareCall(key, recipient, 1);
  assert.equal(e.decodeRlp('0x' + p.encode(quote.payload.transaction).slice(4))[0], '0x1cbd');
  const { transaction, keyHash } = quote.payload;
  assert.equal(quote.digest, p.digest(transaction, keyHash));
  assert.notEqual(quote.digest, p.digest({ ...transaction, chainId: '1337' }, keyHash));
  await assert.rejects(context({}, other).client.prepareCall(key, recipient, 1), /Unexpected network/);
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

const lean = createProtocol(e, 'eip8288-lean');
await check('eip8288-lean declares the raw key in a dependency list and keeps the account address', () => {
  const legacy = p.prepare(options), prepared = lean.prepare(options), request = lean.signedRequest(prepared, signed.signature);
  const rawKey = lean.publicKey(key.backupPkSeed, key.backupPkRoot);
  assert.equal(rawKey, '0x' + '22'.repeat(16) + '11'.repeat(16));
  assert.equal(prepared.transaction.sender, legacy.transaction.sender);
  assert.equal(prepared.keyHash, e.keccak256(rawKey));
  const dependency = e.concat([p.word(16), prepared.digest, rawKey]);
  assert.equal(prepared.transaction.frames[prepared.dependencyIndex].data, dependency);
  const [[typed], mode, [dependencies, witnesses]] = e.decodeRlp(request.wrapper);
  assert.equal(typed, request.raw); assert.equal(mode, '0x');
  assert.deepEqual(dependencies, [dependency]);
  assert.equal(witnesses.length, 1); assert.equal(e.dataSlice(witnesses[0], 0, 32), rawKey);
});
await check('Each format signs under its own account domain, also on the same chain', () => {
  assert.equal(p.domain, e.keccak256(e.toUtf8Bytes('Daisugi.AggregatedFrameAccount.v2')));
  assert.equal(lean.domain, e.keccak256(e.toUtf8Bytes('Daisugi.AggregatedFrameAccount.eip8288-lean.v2')));
  const legacy = p.prepare(options), prepared = lean.prepare(options);
  assert.equal(prepared.transaction.chainId, legacy.transaction.chainId);
  assert.notEqual(prepared.digest, legacy.digest);
  // Each format refuses the other's envelope, so a transaction signed for one never hashes under the other.
  assert.throws(() => p.digest(prepared.transaction, prepared.keyHash), /Nonce key zero/);
  assert.throws(() => lean.digest(legacy.transaction, legacy.keyHash), /empty nonce keys/);
  // A dependency carrying the other format's digest is refused before signing is accepted.
  const swapped = structuredClone(prepared);
  swapped.digest = legacy.digest;
  swapped.transaction.frames[swapped.dependencyIndex].data = e.concat([lean.word(16), legacy.digest, prepared.dependencyKey]);
  assert.throws(() => lean.signedRequest(swapped, signed.signature), /changed after preparation/);
  // Each account runtime reconstructs the digest with its own domain only.
  const legacyRuntime = p.implementationRuntime().toLowerCase(), leanRuntime = lean.implementationRuntime().toLowerCase();
  assert.ok(legacyRuntime.includes('7f' + p.domain.slice(2)) && !legacyRuntime.includes(lean.domain.slice(2)));
  assert.ok(leanRuntime.includes('7f' + lean.domain.slice(2)) && !leanRuntime.includes(p.domain.slice(2)));
});
await check('eip8288-lean account runtime hashes the declared key and reads only the current TXPARAM fields', () => {
  const legacyRuntime = e.getBytes(p.implementationRuntime()), leanRuntime = e.getBytes(lean.implementationRuntime());
  // The current network's deployed implementation must not change.
  assert.equal(e.keccak256(legacyRuntime), '0xd489c81ebe91f1a94a9b6caf284532fd6aaf14b95f59a1925f28cd2146ef994b');
  assert.equal(e.keccak256(leanRuntime), '0x0b882e19e2b9d99498fec4d6c7df7d308c190b5e73a4ffd2542d0aef1d11b467');
  // TXPARAM 0x05 (max_fee_per_blob_gas) is undefined upstream and halts; empty nonce keys make TXPARAM 0x0E zero.
  const txparam = (runtime, field) => e.hexlify(runtime).includes(e.hexlify(new Uint8Array([0x60, field, 0xb0])).slice(2));
  assert.equal(txparam(leanRuntime, 0x05), false); assert.equal(txparam(legacyRuntime, 0x05), true);
  const nonceKeyCount = value => e.hexlify(new Uint8Array([0x60, 0x0e, 0xb0, 0x60, value, 0x14])).slice(2);
  assert.ok(e.hexlify(leanRuntime).includes(nonceKeyCount(0)) && !e.hexlify(leanRuntime).includes(nonceKeyCount(1)));
  assert.ok(e.hexlify(legacyRuntime).includes(nonceKeyCount(1)));
  // Both frame-count paths load the dependency key, then MSTORE it at 3072 and KECCAK256 those 32 bytes.
  const hashing = e.hexlify(new Uint8Array([0x61, 0x0c, 0x00, 0x52, 0x60, 0x20, 0x61, 0x0c, 0x00, 0x20])).slice(2);
  assert.equal(e.hexlify(leanRuntime).split(hashing).length - 1, 2);
  assert.equal(e.hexlify(legacyRuntime).includes(hashing), false);
  assert.throws(() => createProtocol(e, 'eip8288-unknown'), /Unknown EIP-8288 format/);
});
await check('A client pins the runtime of its configured format', () => {
  const leanConfig = { ...config, eip8288Format: 'eip8288-lean', implementationCodeHash: e.keccak256(lean.implementationRuntime()), profile: lean.domain };
  createClient(e, { config: leanConfig, rpc: async () => {}, receiptOutcome: () => {} });
  assert.throws(() => createClient(e, { config: { ...leanConfig, profile: config.profile }, rpc: async () => {}, receiptOutcome: () => {} }),
    /Unsupported account profile/);
  assert.throws(() => createClient(e, { config: { ...leanConfig, implementationCodeHash: config.implementationCodeHash },
    rpc: async () => {}, receiptOutcome: () => {} }), /Unsupported account profile/);
  assert.throws(() => createClient(e, { config: { ...config, eip8288Format: 'eip8288-lean' }, rpc: async () => {}, receiptOutcome: () => {} }),
    /Unsupported account profile/);
});

await check('eip8288-lean encodes empty nonce keys and fees = [max_fee, max_priority_fee_per_gas]', () => {
  const prepared = lean.prepare(options), payload = e.decodeRlp('0x' + lean.signedRequest(prepared, signed.signature).raw.slice(4));
  assert.deepEqual(prepared.transaction.nonceKeys, []); assert.equal('maxBlobFee' in prepared.transaction, false);
  assert.deepEqual(payload[1], []); assert.deepEqual(payload[6], [e.toBeHex(options.maxFee), e.toBeHex(options.priorityFee)]);
  // daisugi-v1 keeps nonce key zero and [max_priority_fee_per_gas, max_fee_per_gas, max_fee_per_blob_gas].
  const legacy = e.decodeRlp('0x' + p.signedRequest(p.prepare(options), signed.signature).raw.slice(4));
  assert.deepEqual(legacy[1], ['0x']); assert.deepEqual(legacy[6], [e.toBeHex(options.priorityFee), e.toBeHex(options.maxFee), '0x']);
});
await check('eip8288-lean signs the account-nonce key set and refuses the other envelope', () => {
  const prepared = lean.prepare(options), tx = prepared.transaction, digest = t => lean.digest(t, prepared.keyHash);
  // The digest commits to TXPARAM 0x0F, keccak256(bytes32(0)) for the account nonce, and to the total max_fee.
  assert.equal(digest(tx), prepared.digest);
  assert.notEqual(digest({ ...tx, maxFee: String(BigInt(tx.maxFee) + 1n) }), prepared.digest);
  assert.throws(() => digest({ ...tx, nonceKeys: ['0'] }), /empty nonce keys/);
  assert.throws(() => digest({ ...tx, maxBlobFee: '0' }), /Unsupported envelope fields/);
  assert.throws(() => p.digest({ ...tx, maxBlobFee: '0' }, prepared.keyHash), /Nonce key zero/);
});
await check('eip8288-lean signs the reviewed fee reservation as its max_fee budget', async () => {
  const leanConfig = { ...config, eip8288Format: 'eip8288-lean', implementationCodeHash: e.keccak256(lean.implementationRuntime()), profile: lean.domain };
  const c = context({}, leanConfig);
  c.state.handler = (method, params) => method === 'eth_getCode' && params[0] === config.implementation ? lean.implementationRuntime() : undefined;
  const quote = await c.client.prepareCall(key, recipient, 1n);
  assert.equal(quote.payload.transaction.maxFee, quote.feeReserve.toString());
  assert.ok(quote.feeReserve > quote.maxFee * quote.reserveGas - 1n && quote.reserveGas >= 3000000n);
  const legacy = await context().client.prepareCall(key, recipient, 1n);
  assert.equal(legacy.payload.transaction.maxFee, legacy.maxFee.toString());
});

console.log(JSON.stringify({ passed: checked, liveRequests: 0 }));
