import * as ethers from '../aggregated-frame/ethers-primitives.js';
import { createNativeProtocol } from './native-protocol.mjs';
const protocol = createNativeProtocol(ethers);
export function accountAddress(config, seed, root) {
  if (!config.active) throw Error('Native frame accounts are not available on this network. Account creation is unavailable.');
  return protocol.accountAddress(config, seed, root);
}
