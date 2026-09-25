import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateRequest, createGateway } from '../dev-rpc.mjs';

test('gateway accepts read requests and native frame submissions only', () => {
  const request = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });
  validateRequest(request('eth_getTransactionCount', ['0x' + '11'.repeat(20), 'pending']));
  validateRequest(request('eth_sendRawTransaction', ['0x06c0']));
  for (const method of ['personal_unlockAccount', 'eth_sendTransaction', 'debug_setHead', 'admin_addPeer', 'anvil_setBalance'])
    assert.throws(() => validateRequest(request(method)));
  for (const raw of ['0x02c0', '0xc0', '0x060', null]) assert.throws(() => validateRequest(request('eth_sendRawTransaction', [raw])));
  assert.throws(() => validateRequest(request('eth_call', [{}, 'latest', {}])));
  assert.throws(() => validateRequest([request('eth_chainId')]));
});
test('gateway rejects web origins and untrusted host headers before forwarding', async () => {
  let forwarded = 0;
  const server = createGateway({ port: 0, fetcher: async () => { forwarded++; return new Response('{"jsonrpc":"2.0","id":1,"result":"0x539"}'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/rpc`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    const request = headers => new Promise((resolve, reject) => {
      const req = http.request(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' } }, response => {
        const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end(body);
    });
    for (const headers of [{ host: 'example.com' }, { origin: 'https://example.com' }])
      assert.equal((await request(headers)).status, 403);
    assert.equal(forwarded, 0);
    const reply = await request({ origin: 'chrome-extension://' + 'a'.repeat(32) });
    assert.equal(reply.status, 200); assert.equal(JSON.parse(reply.body).result, '0x539'); assert.equal(forwarded, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
