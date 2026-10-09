import * as ethers from './ethers-primitives.js';
import {createProtocol} from './protocol.mjs';
const protocol=createProtocol(ethers);
export function accountAddress(config,seed,root){
  if(!config.active) throw Error('Native aggregation is not active on this network. Account creation is unavailable.');
  return protocol.accountAddress(config,seed,root);
}
