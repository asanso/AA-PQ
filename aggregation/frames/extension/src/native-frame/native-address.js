import * as ethers from './ethers-primitives.js';
import { createNativeProtocol } from './native-protocol.mjs';
const protocol = createNativeProtocol(ethers);
export function accountAddress(config, publicKey) {
  if (!config.active) throw Error('Native frame accounts are not available on this network. Account creation is unavailable.');
  return protocol.accountAddress(config, publicKey);
}
