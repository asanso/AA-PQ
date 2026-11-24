import { vaultManager } from '../vault/VaultManager.js';
import * as nativeClient from '../native-frame/native.js';
import { createSendCall } from '../native-frame/send.js';
import { accountAddress } from '../native-frame/native-address.js';
import { withSigningLock } from './signing-lock.js';
import { recoverJournal } from '../native-frame/journal.mjs';

// The wallet's only transaction mode: native frame transactions signed with leanSPHINCS.
const native = Object.freeze({ ...nativeClient, accountAddress, sendCall: createSendCall('native', nativeClient) });

export function activeProtocol() {
  vaultManager.getTransactionMode();
  return native;
}

export const sendCall = options => activeProtocol().sendCall(options);
export const quoteCall = (...args) => activeProtocol().quoteCall(...args);

export async function accountNonce(address) {
  return BigInt(await activeProtocol().rpc('eth_getTransactionCount', [address, 'pending']));
}

export async function refreshActivity(entry) {
  // Only native frame records can be followed; records of other transaction modes stay unresolved.
  if (entry.protocol !== 'native' || !entry.txHash) return { status: 'pending' };
  const key = nativeClient.journalKey(entry.smartAddr);
  // An unresolved submission blocks further sends; recover it from its journal. A busy lock leaves this for a later poll.
  const outcome = await recoverJournal({ hash: entry.txHash, recover: nativeClient.recoverRecord,
    lock: fn => withSigningLock('native-frame-recover', fn),
    storage: { get: async () => (await chrome.storage.local.get(key))[key], set: value => chrome.storage.local.set({ [key]: value }),
      remove: () => chrome.storage.local.remove(key) } });
  return outcome ?? nativeClient.refreshRecord({ ...entry, hash: entry.txHash, status: 'pending' });
}
