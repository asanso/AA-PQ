import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const {Transaction} = createRequire(new URL('../frontend/package.json', import.meta.url))('ethers');
const recipient = digit => '0x' + digit.repeat(40);

async function fixture(t, {chainId = '0x539', rejectFirstBroadcast = false} = {}) {
  const accepted = [], methods = [];
  let nonce = 0, broadcasts = 0;
  const block = {
    hash: '0x' + '2'.repeat(64), parentHash: '0x' + '2'.repeat(64),
    number: '0x1', timestamp: '0x6553f100', nonce: '0x0000000000000000',
    difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
    miner: recipient('1'), extraData: '0x', transactions: [], baseFeePerGas: '0x1'
  };
  const rpc = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    function answer(call) {
      methods.push(call.method);
      let result;
      switch (call.method) {
        case 'eth_chainId': result = chainId; break;
        case 'eth_blockNumber': result = '0x1'; break;
        case 'eth_getTransactionCount': result = '0x' + nonce.toString(16); break;
        case 'eth_estimateGas': result = '0x5208'; break;
        case 'eth_gasPrice':
        case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
        case 'eth_getBlockByNumber': result = block; break;
        case 'eth_sendRawTransaction': {
          broadcasts++;
          const tx = Transaction.from(call.params[0]);
          if (rejectFirstBroadcast && broadcasts === 1) {
            return {jsonrpc: '2.0', id: call.id, error: {code: -32000, message: 'Mock broadcast rejected'}};
          }
          if (tx.nonce < nonce) {
            return {jsonrpc: '2.0', id: call.id, error: {code: -32000, message: 'nonce too low'}};
          }
          accepted.push({nonce: tx.nonce, value: tx.value, to: tx.to});
          nonce = tx.nonce + 1;
          result = tx.hash;
          break;
        }
        default:
          return {jsonrpc: '2.0', id: call.id, error: {code: -32601, message: 'Unexpected mock RPC method'}};
      }
      return {jsonrpc: '2.0', id: call.id, result};
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    rpc.closeAllConnections();
    await new Promise(resolve => rpc.close(resolve));
  });
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const endpoint = 'http://127.0.0.1:' + rpc.address().port;
  // Every backend points to this loopback fixture. No live RPC or funding key is used.
  const child = spawn(process.execPath, ['frontend/server.mjs'], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port),
      RPC_URL: endpoint, FAUCET_RPC_URL: endpoint, BUNDLER_URL: endpoint,
      EXPLORER_URL: endpoint, ENTRY_POINT: recipient('3'),
      FAUCET_PRIVATE_KEY: '0x' + '0'.repeat(63) + '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock frontend startup timed out')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Mock frontend exited: ' + output)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('listening')) { clearTimeout(timer); resolve(); }
    });
  });
  return {
    accepted, methods,
    async request(payload) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/faucet', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
      });
      return {status: response.status, retryAfter: response.headers.get('retry-after'), data: await response.json()};
    }
  };
}

test('concurrent faucet recipients receive distinct nonces', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['4', '5', '6'].map(digit => f.request({address: recipient(digit), amount: '1'})));
  assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  assert.deepEqual(f.accepted.map(tx => tx.nonce), [0, 1, 2]);
  assert(f.accepted.every(tx => tx.value === 10n ** 18n));
});

test('faucet validates amount boundaries in wei before broadcasting', async t => {
  const f = await fixture(t);
  for (const amount of [0, '0', '', null, false, {}, [], [1], {toString: '1'}, '-1', '1e1', '10.000000000000000001', '0.0000000000000000001']) {
    const response = await f.request({address: recipient('4'), amount});
    assert.equal(response.status, 400, 'Unexpected acceptance: ' + JSON.stringify(amount));
  }
  assert.equal(f.accepted.length, 0);
  assert.equal(f.methods.includes('eth_sendRawTransaction'), false);
});

test('faucet accepts exact limits and defaults only an omitted amount', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({address: recipient('4'), amount: '0.000000000000000001'})).status, 200);
  assert.equal((await f.request({address: recipient('5'), amount: '10'})).status, 200);
  assert.equal((await f.request({address: recipient('6')})).status, 200);
  assert.deepEqual(f.accepted.map(tx => tx.value), [1n, 10n ** 19n, 10n ** 18n]);
  assert.deepEqual(f.accepted.map(tx => tx.nonce), [0, 1, 2]);
});

test('invalid payloads and the zero address are rejected without submission', async t => {
  const f = await fixture(t);
  for (const payload of [null, [], {}, {address: 'invalid'}, {address: recipient('0')}]) {
    assert.equal((await f.request(payload)).status, 400);
  }
  assert.equal(f.accepted.length, 0);
});

test('same-address requests retain the cooldown while a submission is pending', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request({address: recipient('4')}), f.request({address: recipient('4')})]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 429]);
  assert.equal(results.find(r => r.status === 429).retryAfter, '60');
  assert.equal(f.accepted.length, 1);
});

test('a rejected broadcast retains its cooldown and does not block the next recipient', async t => {
  const f = await fixture(t, {rejectFirstBroadcast: true});
  assert.equal((await f.request({address: recipient('4')})).status, 500);
  assert.equal((await f.request({address: recipient('4')})).status, 429);
  assert.equal((await f.request({address: recipient('5')})).status, 200);
  assert.equal(f.accepted.length, 1);
  assert.equal(f.accepted[0].nonce, 0);
});

test('a wrong-chain faucet never signs or broadcasts a transaction', async t => {
  const f = await fixture(t, {chainId: '0xaa36a7'});
  assert.equal((await f.request({address: recipient('4')})).status, 503);
  assert.equal(f.accepted.length, 0);
  assert.equal(f.methods.includes('eth_sendRawTransaction'), false);
});
