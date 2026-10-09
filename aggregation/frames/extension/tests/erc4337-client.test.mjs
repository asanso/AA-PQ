import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, ZeroAddress } from 'ethers';
import { createClient } from '../src/erc4337/client-core.js';
import { ACCOUNT_ABI, ENTRY_POINT_ABI, accountAddress, accountRuntime, operationHash, receiptOutcome } from '../src/erc4337/protocol.js';

// Transport tests use synthetic signatures. Real SPHINCS authorization is
// exercised separately against the unchanged verifier and EntryPoint in Anvil.
const verifier = new Interface(['function verify(bytes32,bytes32,bytes32,bytes) view returns(bool)']);
const key = { backupPkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), backupPkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16) };
const signed = { ...key, signature: '0x' + 'ab'.repeat(6176) };
const recipient = '0x5555555555555555555555555555555555555555';
const config = { chainId: 1337, genesisHash: '0x' + '01'.repeat(32),
  factory: '0x1111111111111111111111111111111111111111', implementation: '0x2222222222222222222222222222222222222222',
  entryPoint: '0x3333333333333333333333333333333333333333', verifier: '0x4444444444444444444444444444444444444444' };
for (const name of ['factory', 'implementation', 'entryPoint', 'verifier']) config[name + 'CodeHash'] = keccak256('0x6000');
const sender = accountAddress(config, key.backupPkSeed, key.backupPkRoot);
const txHash = '0x' + 'cd'.repeat(32);

function fixture() {
  const state = { nonce: 0n, balance: 10n ** 18n, deposit: 0n, deployed: false, time: 1000, valid: true,
    sends: 0, writes: [], methods: [], receipt: null, operationReceipt: null, chainId: '0x539' };
  const rpc = async (method, params = []) => {
    state.methods.push(method);
    switch (method) {
      case 'eth_chainId': return state.chainId;
      case 'eth_getBlockByNumber': return { hash: config.genesisHash, number: '0x1', baseFeePerGas: '0x7' };
      case 'eth_getCode': return params[0].toLowerCase() === sender.toLowerCase()
        ? (state.deployed ? accountRuntime(config.implementation) : '0x') : '0x6000';
      case 'eth_getBalance': return '0x' + state.balance.toString(16);
      case 'eth_estimateGas': return '0x5208';
      case 'eth_getTransactionReceipt': return state.receipt;
      case 'eth_call': {
        const call = params[0];
        if (call.to === recipient) {
          if (state.callFailure || BigInt(call.gas) < (state.callGasRequired || 0n)) {
            throw Object.assign(Error('Execution reverted'), { rpcCode: -32000 });
          }
          return '0x';
        }
        if (call.to === config.verifier) return verifier.encodeFunctionResult('verify', [state.valid]);
        if (call.to.toLowerCase() === sender.toLowerCase()) {
          const parsed = ACCOUNT_ABI.parseTransaction(call);
          return ACCOUNT_ABI.encodeFunctionResult(parsed.name, [parsed.name === 'pkSeed' ? key.backupPkSeed : key.backupPkRoot]);
        }
        const parsed = ENTRY_POINT_ABI.parseTransaction(call);
        if (parsed.name === 'getNonce') return ENTRY_POINT_ABI.encodeFunctionResult('getNonce', [state.nonce]);
        if (parsed.name === 'balanceOf') return ENTRY_POINT_ABI.encodeFunctionResult('balanceOf', [state.deposit]);
        if (parsed.name === 'getUserOpHash') return ENTRY_POINT_ABI.encodeFunctionResult('getUserOpHash', [state.hash]);
        if (parsed.name === 'handleOps') { if (state.simulationError) throw state.simulationError; return '0x'; }
        throw Error('Unexpected EntryPoint method');
      }
      default: throw Error('Unexpected RPC method ' + method);
    }
  };
  const bundler = async (method, params = []) => {
    if (method === 'eth_supportedEntryPoints') return [config.entryPoint];
    if (method === 'eth_getUserOperationReceipt') return state.operationReceipt;
    assert.equal(method, 'eth_sendUserOperation');
    assert.ok(state.writes.length, 'Journal must be persisted before sending');
    assert.equal(state.writes.at(-1).userOpHash, operationHash(config, params[0]));
    state.sends++;
    if (state.submissionError) throw state.submissionError;
    return state.returnedHash || state.hash;
  };
  // The remote hash is independently exercised with a real EntryPoint in the
  // integration test. Here capture the exact request to test rejection handling.
  const wrappedRpc = async (method, params = []) => {
    if (method === 'eth_call' && params[0].to === config.entryPoint) {
      const parsed = ENTRY_POINT_ABI.parseTransaction(params[0]);
      if (parsed?.name === 'getUserOpHash') {
        const p = parsed.args[0];
        state.hash = operationHash(config, { sender: p.sender, nonce: p.nonce, callData: p.callData,
          verificationGasLimit: BigInt(p.accountGasLimits) >> 128n, callGasLimit: BigInt(p.accountGasLimits) % (1n << 128n),
          preVerificationGas: p.preVerificationGas, maxPriorityFeePerGas: BigInt(p.gasFees) >> 128n,
          maxFeePerGas: BigInt(p.gasFees) % (1n << 128n),
          ...(p.initCode !== '0x' ? { factory: p.initCode.slice(0, 42), factoryData: '0x' + p.initCode.slice(42) } : {}) });
      }
    }
    return rpc(method, params);
  };
  const client = createClient({ config, rpc: wrappedRpc, bundler, now: () => state.time });
  const persist = async record => state.writes.push(structuredClone(record));
  return { state, client, persist, prepare: () => client.prepareCall(key, recipient, 1000n, '0x12345678') };
}

test('a persistent journal precedes submission; complete contract calldata is retained', async () => {
  const { state, client, persist, prepare } = fixture();
  const quote = await prepare();
  const record = await client.submitCall(quote, signed, persist);
  assert.equal(state.sends, 1);
  assert.equal(record.userOpHash, state.hash);
  const decoded = ACCOUNT_ABI.parseTransaction({ data: quote.operation.callData });
  assert.equal(decoded.args[2], '0x12345678');
  assert.equal(quote.operation.callData, ACCOUNT_ABI.encodeFunctionData('execute', [...decoded.args]));
  assert.ok(!state.methods.includes('eth_sendRawTransaction'));
  assert.ok(!state.methods.includes('eth_getTransactionCount'));
  assert.ok(!state.methods.includes('eth_estimateGas'));
});

test('read-only call budgets support expensive contracts and reject execution failure', async () => {
  const { state, client } = fixture();
  state.callGasRequired = 600000n;
  assert.equal((await client.quoteCall(sender, recipient)).callGas, 1500000n);
  state.callFailure = true;
  await assert.rejects(client.quoteCall(sender, recipient), /failed simulation/);
  assert.equal(state.sends, 0);
});

test('a failed journal write prevents submission', async () => {
  const { state, client, prepare } = fixture();
  await assert.rejects(client.submitCall(await prepare(), signed, async () => { throw Error('Storage unavailable'); }), /Storage unavailable/);
  assert.equal(state.sends, 0);
});

test('locking after journal persistence records that the operation was not submitted', async () => {
  const { state, client, persist, prepare } = fixture();
  let guards = 0;
  await assert.rejects(client.submitCall(await prepare(), signed, persist, () => {
    if (++guards === 2) throw Error('Wallet locked');
  }), error => error.submissionRejected === true);
  assert.equal(state.sends, 0);
  assert.equal(state.writes.at(-1).status, 'rejected');
  assert.match(state.writes.at(-1).message, /Not submitted/);
});

test('explicit bundler rejection is persisted and distinguished from an uncertain response', async () => {
  const { state, client, persist, prepare } = fixture();
  state.submissionError = Object.assign(Error('AA21 prefund'), { rpcCode: -32500 });
  await assert.rejects(client.submitCall(await prepare(), signed, persist), error => error.submissionRejected === true);
  assert.equal(state.sends, 1);
  assert.equal(state.writes.at(-1).status, 'rejected');
});

for (const failure of ['timeout', 'unexpected hash']) {
  test(`${failure} keeps the operation pending without retrying submission`, async () => {
    const { state, client, persist, prepare } = fixture();
    if (failure === 'timeout') state.submissionError = Error('Timeout');
    else state.returnedHash = txHash;
    const result = await client.submitCall(await prepare(), signed, persist);
    assert.equal(result.status, 'pending');
    assert.match(result.message, /uncertain/);
    assert.equal(state.sends, 1);
    assert.equal(state.writes.at(-1).userOpHash, state.hash);
  });
}

for (const change of ['nonce', 'deployment', 'network', 'key', 'signature', 'expiry', 'simulation', 'verifier', 'balance']) {
  test(`a changed ${change} prevents submission`, async () => {
    const { state, client, persist, prepare } = fixture();
    const quote = await prepare();
    let signature = signed;
    if (change === 'nonce') state.nonce++;
    if (change === 'deployment') state.deployed = true;
    if (change === 'network') state.chainId = '0x1';
    if (change === 'key') signature = { ...signed, backupPkRoot: key.backupPkSeed };
    if (change === 'signature') signature = { ...signed, signature: '0x' + 'ab'.repeat(1568) };
    if (change === 'expiry') state.time += 240001;
    if (change === 'simulation') state.simulationError = Error('Simulation reverted');
    if (change === 'verifier') state.valid = false;
    if (change === 'balance') state.balance = 0n;
    await assert.rejects(client.submitCall(quote, signature, persist));
    assert.equal(state.sends, 0);
    assert.equal(state.writes.length, 0);
  });
}

test('EntryPoint deposit contributes to prefund, but cannot fund the transferred value', async () => {
  const { state, client } = fixture();
  state.deposit = 10n ** 18n;
  state.balance = 1000n;
  assert.equal((await client.quoteCall(sender, recipient, 1000n)).requiredBalance, 1000n);
  await client.prepareCall(key, recipient, 1000n);
  await assert.rejects(client.prepareCall(key, recipient, 1001n), /Insufficient/);
});

test('receipt identity must match the operation, sender, EntryPoint and transaction', async () => {
  const { state, client, prepare } = fixture();
  await prepare();
  const record = { userOpHash: state.hash, sender, status: 'pending' };
  state.operationReceipt = { userOpHash: state.hash, sender: recipient, entryPoint: config.entryPoint, receipt: { transactionHash: txHash } };
  await assert.rejects(client.refreshRecord(record), /identity/);
  state.operationReceipt.sender = sender;
  state.receipt = { transactionHash: '0x' + 'ef'.repeat(32) };
  await assert.rejects(client.refreshRecord(record), /receipt hash/);
});

test('outer transaction success does not hide an operation execution failure', () => {
  const hash = '0x' + '12'.repeat(32);
  const event = ENTRY_POINT_ABI.encodeEventLog(ENTRY_POINT_ABI.getEvent('UserOperationEvent'), [hash, sender, ZeroAddress, 0n, false, 1n, 1n]);
  const receipt = { transactionHash: txHash, status: '0x1', logs: [{ address: config.entryPoint, ...event }] };
  assert.equal(receiptOutcome(receipt, hash, sender, config.entryPoint).status, 'failed');
  assert.throws(() => receiptOutcome({ ...receipt, logs: [] }, hash, sender, config.entryPoint), /matching/);
  assert.throws(() => receiptOutcome(receipt, hash, recipient, config.entryPoint), /matching/);
});
