import { vaultManager } from '../vault/VaultManager.js';
import * as frameClient from '../native-frame/client.js';
import * as aaClient from '../erc4337/client.js';
import { sendCall as sendFrame } from '../native-frame/send.js';
import { sendCall as sendUserOperation } from '../erc4337/send.js';
import { accountAddress as frameAddress } from '../aggregated-frame/address.js';
import { accountAddress as aaAddress, ENTRY_POINT_ABI } from '../erc4337/protocol.js';

const adapters = Object.freeze({
  frame: { ...frameClient, accountAddress: frameAddress, sendCall: sendFrame },
  aa: { ...aaClient, accountAddress: aaAddress, sendCall: sendUserOperation },
});

export function activeProtocol() {
  return adapters[vaultManager.getTransactionMode()];
}

export const sendCall = options => activeProtocol().sendCall(options);
export const quoteCall = (...args) => activeProtocol().quoteCall(...args);

export async function accountNonce(address) {
  const adapter = activeProtocol();
  if (vaultManager.getTransactionMode() === 'frame') {
    return BigInt(await adapter.rpc('eth_getTransactionCount', [address, 'pending']));
  }
  return ENTRY_POINT_ABI.decodeFunctionResult('getNonce', await adapter.rpc('eth_call', [{
    to: adapter.config.entryPoint,
    data: ENTRY_POINT_ABI.encodeFunctionData('getNonce', [address, 0]),
  }, 'latest']))[0];
}

export async function refreshActivity(entry) {
  // The record determines its receipt format, never a mutable UI selection.
  if (entry.userOpHash) {
    return aaClient.refreshRecord({ ...entry, sender: entry.smartAddr, status: 'pending' });
  }
  return frameClient.refreshRecord({ ...entry, hash: entry.txHash, status: 'pending' });
}
