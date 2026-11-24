import {getActiveNetwork,getRpcUrls} from '../config/networks.js';

// JSON-RPC over the build's verified HTTPS endpoint.
export async function rpc(method,params=[]) {
  const endpoint=getRpcUrls(getActiveNetwork())[0];
  if(!endpoint) throw Error('A verified HTTPS RPC endpoint is required.');
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
  // Keep a JSON-RPC error and its HTTP status: the client tells a refused submission from an unknown outcome by them.
  const data=await response.json().catch(()=>null);
  if(data?.error && Number.isInteger(data.error.code)){
    const error=Error(data.error.message);error.rpcCode=data.error.code;error.httpStatus=response.status;throw error;
  }
  if(!response.ok){const error=Error('RPC returned HTTP '+response.status+'.');error.httpStatus=response.status;throw error;}
  if(!data) throw Error('Invalid RPC response.');
  if(!Object.hasOwn(data,'result')) throw Error('Invalid RPC response.');
  return data.result;
}
