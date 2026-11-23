import * as ethers from '../aggregated-frame/ethers-primitives.js';
import {createNativeClient} from './native-client.mjs';
import {receiptOutcome} from './protocol.js';
import {rpc} from './client.js';
import config from './native-deployment.json';
export {config, rpc};
// chrome.storage key of a native account's journaled submission: written before broadcast, removed once resolved.
export const journalKey=address=>'nt_native_pending_'+address.toLowerCase();
let adapter;
function client(){
  if(!config.active) throw Error('This build has no verified native frame deployment profile. Native setup and submission are disabled.');
  return adapter ||= createNativeClient(ethers,{config,rpc,receiptOutcome});
}
export const verifyNetwork=(...args)=>client().verifyNetwork(...args);
export const accountState=(...args)=>client().accountState(...args);
export const quoteCall=(...args)=>client().quoteCall(...args);
export const prepareCall=(...args)=>client().prepareCall(...args);
export const submitCall=(...args)=>client().submitCall(...args);
export const refreshRecord=(...args)=>client().refreshRecord(...args);
export const recoverRecord=(...args)=>client().recoverRecord(...args);
