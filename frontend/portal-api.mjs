import {addTransactionInput} from './transaction-input.mjs';
import {createTransactionDetails} from './transaction-details.mjs';

const EXPECTED_CHAIN = 1337;
const overviewPattern = /^overview$/;
const detailPattern = /^(?:block\/\d{1,12}|(?:tx|op)\/0x[0-9a-fA-F]{64}|address\/0x[0-9a-fA-F]{40})$/;

export function createPortalApi({provider, bundlerUrl, explorerUrl, entryPoint, rpcUrl, fetchImpl = fetch, now = Date.now}) {
  const loadTransactionDetails=createTransactionDetails({provider,rpcUrl,fetchImpl,now});
  let cached, cacheTime = 0, pending;
  async function network() {
    if (cached && now() - cacheTime < 5000) return cached;
    if (pending) return pending;
    pending = (async () => {
      const [chain, block] = await Promise.all([provider.getNetwork(), provider.getBlock('latest')]);
      if (Number(chain.chainId) !== EXPECTED_CHAIN) throw new Error('The RPC is not connected to Daisugi (chain 1337).');
      if (!block) throw new Error('The latest Daisugi block is unavailable.');
      let bundler = 'unavailable';
      try {
        const response = await fetchImpl(bundlerUrl, {
          method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),
          signal:AbortSignal.timeout(3000)
        });
        const data = await response.json();
        bundler = response.ok && typeof data.result === 'string' && BigInt(data.result) === 1337n ? 'available' : 'unavailable';
      } catch {}
      const blockAge = Math.max(0, Math.floor(now()/1000) - block.timestamp);
      cached = {
        chainId:EXPECTED_CHAIN, network:'Daisugi', rpc:'available', bundler,
        status:blockAge > 45 ? 'delayed' : bundler === 'available' ? 'operational' : 'degraded',
        blockNumber:block.number, blockTimestamp:block.timestamp,
        baseFeePerGas:block.baseFeePerGas?.toString() ?? null,
        checkedAt:new Date(now()).toISOString()
      };
      cacheTime = now();
      return cached;
    })().finally(() => {pending = null;});
    return pending;
  }
  async function explorer(path) {
    if (!overviewPattern.test(path) && !detailPattern.test(path)) throw new Error('Invalid explorer request.');
    // Fixed upstream, fixed route allowlist: never forward an arbitrary URL.
    const response = await fetchImpl(new URL('/api/' + path, explorerUrl), {signal:AbortSignal.timeout(10000)});
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'The explorer is unavailable.');
    if (path === 'overview' && Number(data.chainId) !== EXPECTED_CHAIN) throw new Error('The explorer is not connected to Daisugi.');
    const [kind, id] = path.split('/');
    if (kind === 'tx' || kind === 'op') return addTransactionInput({provider,data,kind,id,entryPoint,loadTransactionDetails});
    return data;
  }
  return {network, explorer};
}

export function createFaucetLimiter({now = Date.now, cooldownMs = 60000, maximum = 10000} = {}) {
  const claims = new Map();
  return address => {
    const time = now();
    for (const [key, expires] of claims) if (expires <= time) claims.delete(key);
    const key = address.toLowerCase();
    const expires = claims.get(key);
    if (expires) return Math.ceil((expires - time) / 1000);
    if (claims.size >= maximum) return Math.ceil(cooldownMs / 1000);
    claims.set(key, time + cooldownMs);
    return 0;
  };
}
