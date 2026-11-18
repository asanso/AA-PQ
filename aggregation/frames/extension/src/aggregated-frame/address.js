import * as ethers from './ethers-primitives.js';
import {createProtocol} from './protocol.mjs';
export function accountAddress(config,seed,root){
  if(!config.active) throw Error('Native aggregation is not active on this network. Account creation is unavailable.');
  // The key layout, and so the address, depends on the network's EIP-8288 format, as in client.mjs.
  return createProtocol(ethers,config.eip8288Format).accountAddress(config,seed,root);
}
