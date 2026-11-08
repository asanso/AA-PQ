import { vaultManager } from '../vault/VaultManager.js';
import * as frameClient from '../native-frame/client.js';
import * as aaClient from '../erc4337/client.js';
import { sendCall as sendFrame } from '../native-frame/send.js';
import { sendCall as sendUserOperation } from '../erc4337/send.js';
import { accountAddress as frameAddress } from '../aggregated-frame/address.js';
import { accountAddress as aaAddress, ENTRY_POINT_ABI } from '../erc4337/protocol.js';
import { withSigningLock } from './signing-lock.js';
import { ERC4337_AVAILABLE } from '../config/chain-defaults.js';

const adapters = Object.freeze({
  frame: { ...frameClient, accountAddress: frameAddress, sendCall: sendFrame },
  aa: { ...aaClient, sendCall: sendUserOperation, accountAddress(...args) {
    if (!ERC4337_AVAILABLE) throw Error('ERC-4337 is not deployed on this network. Account creation is unavailable.');
    return aaAddress(...args);
  } },
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
  const key = frameClient.journalKey(entry.smartAddr);
  if ((await chrome.storage.local.get(key))[key]?.hash?.toLowerCase() === entry.txHash?.toLowerCase()) {
    // The send path owns the journal under the signing lock; recover under it too. A busy lock leaves this for a later poll.
    return withSigningLock('native-frame-recover', async () => {
      const journal = (await chrome.storage.local.get(key))[key];
      if (journal?.hash?.toLowerCase() !== entry.txHash?.toLowerCase()) return frameClient.refreshRecord({ ...entry, hash: entry.txHash, status: 'pending' });
      // An unresolved submission blocks further sends. Re-send its identical signed wrapper at most every 30 s:
      // the same bytes can be included at most once.
      const rebroadcast = Date.now() - (journal.rebroadcastAt ?? 0) > 30000;
      if (rebroadcast) await chrome.storage.local.set({ [key]: { ...journal, rebroadcastAt: Date.now() } });
      const outcome = await frameClient.recoverRecord(journal, { rebroadcast });
      if (outcome.status !== 'pending') await chrome.storage.local.remove(key);
      return outcome;
    });
  }
  return frameClient.refreshRecord({ ...entry, hash: entry.txHash, status: 'pending' });
}
