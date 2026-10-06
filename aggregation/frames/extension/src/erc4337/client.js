import config from './network.json' with { type: 'json' };
import { createClient } from './client-core.js';
import { getActiveNetwork, getRpcUrls, DAISUGI_BUNDLER_URL } from '../config/networks.js';
export { config };

async function request(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Endpoint returned HTTP ${response.status}.`);
  const body = await response.json();
  if (body.error) { const error = Error(body.error.message); error.rpcCode = body.error.code; error.rpcData = body.error.data; throw error; }
  if (!Object.hasOwn(body, 'result')) throw Error('Invalid JSON-RPC response.');
  return body.result;
}
export const rpc = (method, params) => request(getRpcUrls(getActiveNetwork())[0], method, params);
export const bundler = (method, params) => request(DAISUGI_BUNDLER_URL, method, params);
export const { verifyNetwork, accountState, quoteCall, prepareCall, submitCall, refreshRecord } = createClient({ config, rpc, bundler });
