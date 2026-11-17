import * as ethers from '../aggregated-frame/ethers-primitives.js';
import {createClient} from '../aggregated-frame/client.mjs';
import {receiptOutcome} from './protocol.js';
import config from '../aggregated-frame/deployment.json';
import {getActiveNetwork,getRpcUrls} from '../config/networks.js';
export {config};
// chrome.storage key of an account's journaled submission: written before broadcast, removed once resolved.
export const journalKey=address=>'nt_frame_pending_'+address.toLowerCase();
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
let adapter;
function client(){
  if(!config.active) throw Error('This build has no verified aggregation deployment profile. Native setup and submission are disabled.');
  return adapter ||= createClient(ethers,{config,rpc,receiptOutcome});
}
export const verifyNetwork=(...args)=>client().verifyNetwork(...args);
export const accountState=(...args)=>client().accountState(...args);
export const quoteCall=(...args)=>client().quoteCall(...args);
export const prepareCall=(...args)=>client().prepareCall(...args);
export const submitCall=(...args)=>client().submitCall(...args);
export const refreshRecord=(...args)=>client().refreshRecord(...args);
export const recoverRecord=(...args)=>client().recoverRecord(...args);
