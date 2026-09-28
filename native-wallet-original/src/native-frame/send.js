import { formatEther, getAddress } from 'ethers';
import { vaultManager } from '../vault/VaultManager.js';
import { publicKey, signDigest } from './keys.js';
import { prepareCall, submitCall, refreshRecord } from './client.js';
import { withSigningLock } from '../transactions/signing-lock.js';
import { createTransactionActivity } from '../transactions/transaction-activity.js';
import { busy, smartAddr, chainId } from '../ui/store.js';
import { log } from '../ui/logger.js';

export async function sendCall({ to, value = 0n, data = '0x', reviewed, activity, details = {}, expectedNonce, onPhase = () => {} }) {
  if (busy.value) throw Error('Another transaction is already in progress.');
  const account = vaultManager.getActiveAccountIndex();
  const address = smartAddr.value;
  const hd = vaultManager.getHdKeyring();
  if (!hd || !address) throw Error('Unlock the wallet and wait for the account address.');
  const fingerprint = hd.getIdentityAddress(account);
  const assertContext = () => {
    if (!vaultManager.isUnlocked() || vaultManager.getActiveAccountIndex() !== account ||
        vaultManager.getHdKeyring()?.getIdentityAddress(account) !== fingerprint ||
        smartAddr.value !== address || BigInt(chainId.value) !== 1337n)
      throw Error('Wallet account changed or was locked. Review the transaction again.');
  };
  to = getAddress(to);
  const history = activity || createTransactionActivity({ to, amount: formatEther(value), smartAddr: address,
    chainId: '0x539', accountIndex: account, mode: 'SPHINCS', transactionType: 6, ...details });
  busy.value = true;
  log('Transaction started', 'step');
  try {
    return await withSigningLock('native-frame-send', async (assertLock = () => {}) => {
      const guard = () => { assertContext(); assertLock(); };
      guard();
      const journalKey = 'nt_frame_pending_' + address.toLowerCase();
      const previous = (await chrome.storage.local.get(journalKey))[journalKey];
      if (previous) {
        const resolved = await refreshRecord(previous);
        if (resolved.status === 'pending') throw Error('A previous submission remains unresolved: ' + previous.hash);
        await chrome.storage.local.remove(journalKey);
      }
      onPhase('connecting');
      const key = await publicKey(account);
      guard();
      const quote = await prepareCall(key, to, value, data, reviewed);
      if (expectedNonce != null && BigInt(expectedNonce) !== quote.account.nonce) throw Error('The requested nonce does not match the current account nonce.');
      if (quote.account.address.toLowerCase() !== address.toLowerCase()) throw Error('Account derivation mismatch.');
      guard();
      log('Signing with SPHINCS-G', 'step'); onPhase('signing');
      const start = performance.now();
      const signed = await signDigest(account, quote.digest);
      guard();
      const signingMs = Math.round(performance.now() - start);
      log('Signature complete', 'ok'); onPhase('signed');
      let published = false;
      const record = await submitCall(quote, signed, async record => {
        // This write is deliberately not best-effort. A closed popup must not lose
        // the nonce/hash of a request whose submission outcome is uncertain.
        await chrome.storage.local.set({ [journalKey]: record });
        if (!published) {
          await history.signed({ txHash: record.hash, signingMs, smartAddr: address, frameCount: record.frameCount });
          published = true;
        }
      }, guard);
      await history.submitted({ txHash: record.hash });
      log('Tx: ' + record.hash, 'data'); onPhase('destroying');
      for (let attempt = 0; attempt < 90; attempt++) {
        const result = await refreshRecord(record);
        if (result.status !== 'pending') {
          await history.included({ txHash: record.hash, success: result.status === 'confirmed' });
          await chrome.storage.local.remove(journalKey);
          if (result.status === 'failed') throw Error(result.message);
          const completed = { txHash: record.hash, smartAddr: address, frameCount: record.frameCount,
            blockNumber: result.receipt.blockNumber, transactionType: 6 };
          await history.complete(completed);
          log('═══ DONE ═══', 'ok'); onPhase('done');
          return completed;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const error = Error('Confirmation is pending. Inspect this hash before sending again: ' + record.hash);
      error.transactionHash = record.hash;
      throw error;
    });
  } catch (error) {
    await history.failed(error); log(error.message, 'err'); onPhase('error'); throw error;
  } finally { busy.value = false; }
}
