import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const READ_METHODS = new Set(['web3_clientVersion', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_call', 'eth_estimateGas', 'eth_getLogs', 'eth_getBlockByHash', 'eth_feeHistory']);
const MAX_BODY = 128 * 1024;
export function validateRequest(body) {
  if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || !Array.isArray(body.params) || typeof body.method !== 'string')
    throw Error('A single JSON-RPC 2.0 request is required.');
  if (!READ_METHODS.has(body.method) && body.method !== 'eth_sendRawTransaction') throw Error('Method not enabled on the development gateway.');
  if (['eth_call', 'eth_estimateGas'].includes(body.method) && body.params.length > 2) throw Error('State overrides are not enabled.');
  if (body.method === 'eth_sendRawTransaction' &&
      (body.params.length !== 1 || typeof body.params[0] !== 'string' || !/^0x06(?:[0-9a-f]{2})+$/i.test(body.params[0])))
    throw Error('Only signed native frame transactions are accepted.');
}
export function createGateway({ upstream = 'http://127.0.0.1:32773', fetcher = fetch, port = 3007 } = {}) {
  const server = http.createServer(async (req, res) => {
    const listenPort = port || server.address().port;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (![`127.0.0.1:${listenPort}`, `localhost:${listenPort}`].includes(req.headers.host)) { res.writeHead(403).end(); return; }
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && origin !== `http://127.0.0.1:${listenPort}`) {
      res.writeHead(403).end(); return;
    }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.url === '/health' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'daisugi-frame-dev-rpc', chainId: 1337, scope: 'development' })); return;
    }
    if (req.url !== '/rpc' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    let body;
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) throw Error('Content-Type must be application/json.');
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; } chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks)); validateRequest(body);
    } catch (error) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400).end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: error.message } })); return;
    }
    try {
      const upstreamResponse = await fetcher(upstream, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (!upstreamResponse.ok) throw Error('Upstream unavailable.');
      const reply = await upstreamResponse.text();
      res.setHeader('Content-Type', 'application/json'); res.end(reply);
    } catch {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(502).end(JSON.stringify({ error: 'Development RPC unavailable. Submission may be ambiguous; inspect the transaction hash before retrying.' }));
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL('dev-network.json', import.meta.url)));
  const response = await fetch('http://127.0.0.1:32773', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x0', false] }) });
  if ((await response.json()).result?.hash !== config.genesisHash) throw Error('Unexpected development chain genesis.');
  createGateway().listen(3007, '127.0.0.1', () => console.log('Daisugi frame development RPC listening on 127.0.0.1:3007'));
}
