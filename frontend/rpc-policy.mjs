import {decodeRlp} from 'ethers';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';

export const RPC_BODY_LIMIT = 128 * 1024;
const reads = new Set(['web3_clientVersion','eth_chainId','eth_blockNumber','eth_getBalance','eth_getCode',
  'eth_getTransactionReceipt','eth_getTransactionByHash','eth_getTransactionCount','eth_getBlockByNumber',
  'eth_getBlockByHash','eth_getLogs','eth_call','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory']);
const bytes = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const quantity = value => bytes(value) && value.length <= 66 && (value === '0x' || !value.slice(2).startsWith('00'));
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const bigint = value => value === '0x' ? 0n : BigInt(value);
export function validateFrameEnvelope(raw) {
  if (typeof raw !== 'string' || raw.length > RPC_BODY_LIMIT || !/^0x06(?:[0-9a-f]{2})+$/i.test(raw)) throw new Error('Only bounded native frame transactions (type 0x06) are accepted.');
  let tx;
  try { tx = decodeRlp('0x'+raw.slice(4)); } catch { throw new Error('Invalid frame transaction RLP.'); }
  if (!Array.isArray(tx) || tx.length !== 7 || !quantity(tx[0]) || bigint(tx[0]) !== 1337n || !quantity(tx[1]) || !address(tx[2])) throw new Error('Expected a Daisugi frame transaction with chain ID 1337.');
  const [, , ,frames,witnesses,fees,blobs] = tx;
  if (!Array.isArray(frames) || !frames.length || frames.length > 1024 || !frames.every(f=>
    Array.isArray(f) && f.length === 6 && quantity(f[0]) && bigint(f[0]) <= 3n && quantity(f[1]) && bigint(f[1]) <= 255n && (f[2] === '0x' || address(f[2])) &&
    Array.isArray(f[3]) && f[3].length === 2 && f[3].every(quantity) && quantity(f[4]) && bytes(f[5]))) throw new Error('Invalid frame fields.');
  if (!Array.isArray(witnesses) || !witnesses.length || witnesses.length > 1024 || !witnesses.every(w=>
    Array.isArray(w) && w.length === 4 && quantity(w[0]) && bigint(w[0]) <= 1n && (w[1] === '0x' || address(w[1])) && bytes(w[2]) && bytes(w[3]))) throw new Error('Invalid signature witness fields.');
  if (!Array.isArray(fees) || fees.length !== 3 || !fees.every(quantity) || bigint(fees[0]) > bigint(fees[1]) || !Array.isArray(blobs) || !blobs.every(b=>bytes(b)&&b.length===66)) throw new Error('Invalid transaction fees or blob hashes.');
  // Structural gateway checks are not signature verification. The node validates
  // the complete envelope, witnesses, account authorization and execution rules.
}
export function validateRpcRequest(payload,{nativeFramesEnabled = false} = {}) {
  if (!payload || Array.isArray(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string' || !Array.isArray(payload.params)
    || !(payload.id == null || typeof payload.id === 'string' || typeof payload.id === 'number')) throw new Error('Expected a single JSON-RPC 2.0 request with positional parameters.');
  if (['eth_call','eth_estimateGas'].includes(payload.method) && payload.params.length > 2) throw new Error('State and block overrides are not enabled on the public RPC.');
  if (payload.method === 'eth_sendRawTransaction') {
    if (!nativeFramesEnabled) throw new Error('Native frame submission is not enabled on this endpoint.');
    if (payload.params.length !== 1) throw new Error('Expected one signed transaction.');
    validateFrameEnvelope(payload.params[0]);
    return;
  }
  if (!reads.has(payload.method)) throw new Error('Method is not enabled on this endpoint.');
}

export function createRpcProxy({url,nativeFramesEnabled = false,fetchImpl = fetch}) {
  let identity, expires = 0;
  async function upstream(payload) {
    const response = await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    const data = await response.json();
    if (!response.ok) throw new Error('The upstream RPC is unavailable.');
    return data;
  }
  async function verifyIdentity() {
    if (identity && expires > Date.now()) return identity;
    identity = (async()=>{
      const [chain,genesis] = await Promise.all([
        upstream({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),
        upstream({jsonrpc:'2.0',id:2,method:'eth_getBlockByNumber',params:['0x0',false]})
      ]);
      if (Number(chain.result) !== 1337 || genesis.result?.hash !== DAISUGI_GENESIS) throw new Error('Frame submission requires the configured Daisugi chain and genesis.');
      expires = Date.now()+60000;
    })().catch(error=>{identity=null;expires=0;throw error;});
    return identity;
  }
  return async payload => {
    try {validateRpcRequest(payload,{nativeFramesEnabled});}
    catch(error) {error.status=400;error.rpcCode=-32602;throw error;}
    if (payload.method === 'eth_sendRawTransaction') await verifyIdentity();
    return upstream(payload);
  };
}
