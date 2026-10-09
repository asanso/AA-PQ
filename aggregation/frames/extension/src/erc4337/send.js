import { formatEther, getAddress } from 'ethers';
import { vaultManager } from '../vault/VaultManager.js';
import { publicKey, signDigest } from './keys.js';
import { prepareCall, submitCall, refreshRecord } from './client.js';
import { withSigningLock } from '../transactions/signing-lock.js';
import { createTransactionActivity } from '../transactions/transaction-activity.js';
import { busy, smartAddr, chainId } from '../ui/store.js';
import { log } from '../ui/logger.js';

export async function sendCall({ to, value = 0n, data = '0x', reviewed, activity, details = {}, expectedNonce, onPhase = () => {} }) {
  if (vaultManager.getTransactionMode() !== 'aa') throw Error('Transaction mode mismatch.');
  const epoch = vaultManager.sessionEpoch;
  if (busy.value) throw Error('Another transaction is already in progress.');
  const account = vaultManager.getActiveAccountIndex();
  const address = smartAddr.value;
  const hd = vaultManager.getHdKeyring();
  if (!hd || !address) throw Error('Unlock the wallet and wait for the account address.');
  const fingerprint = hd.getIdentityAddress(account);
  const assertContext = () => {
    if (!vaultManager.isUnlocked() || vaultManager.sessionEpoch !== epoch || vaultManager.getTransactionMode() !== 'aa' || vaultManager.getActiveAccountIndex() !== account ||
        vaultManager.getHdKeyring()?.getIdentityAddress(account) !== fingerprint ||
        smartAddr.value !== address || BigInt(chainId.value) !== 1337n) {
      throw Error('Wallet account changed or was locked. Review the transaction again.');
    }
  };
  to = getAddress(to);
  const history = activity || createTransactionActivity({ to, amount: formatEther(value), smartAddr: address,
    chainId: '0x539', accountIndex: account, mode: 'SPHINCS', protocol: 'ERC-4337', ...details });
  busy.value = true;
  log('UserOperation started', 'step');
  try {
    return await withSigningLock('sphincs-erc4337-send', async (assertLock = () => {}) => {
      const guard = () => { assertContext(); assertLock(); };
      guard();
      const journalKey = 'nt_sphincs_aa_pending_' + address.toLowerCase();
      const previous = (await chrome.storage.local.get(journalKey))[journalKey];
      if (previous) {
        const resolved = await refreshRecord(previous);
        if (resolved.status === 'pending') throw Error('A previous UserOperation remains unresolved: ' + previous.userOpHash);
        await chrome.storage.local.remove(journalKey);
      }
      onPhase('connecting');
      const key = await publicKey(account);
      guard();
      const quote = await prepareCall(key, to, value, data, reviewed);
      if (expectedNonce != null && BigInt(expectedNonce) !== quote.account.nonce) throw Error('The requested nonce does not match the EntryPoint account nonce.');
      if (quote.account.address.toLowerCase() !== address.toLowerCase()) throw Error('Account derivation mismatch.');
      guard();
      log('Signing with SPHINCS-G', 'step');
      onPhase('signing');
      const start = performance.now();
      const signed = await signDigest(account, quote.digest);
      guard();
      const signingMs = Math.round(performance.now() - start);
      log('Signature complete', 'ok');
      onPhase('signed');
      let published = false;
      let record;
      try {
        record = await submitCall(quote, signed, async next => {
          // This journal is required before broadcast. An interrupted popup must
          // retain the operation hash and must never silently resubmit it.
          await chrome.storage.local.set({ [journalKey]: next });
          if (!published) {
            await history.signed({ userOpHash: next.userOpHash, signingMs, smartAddr: address });
            published = true;
          }
        }, guard);
      } catch (error) {
        if (error.submissionRejected) await chrome.storage.local.remove(journalKey);
        throw error;
      }
      await history.submitted({ userOpHash: record.userOpHash });
      log('UserOperation: ' + record.userOpHash, 'data');
      onPhase('destroying');
      for (let attempt = 0; attempt < 90; attempt++) {
        let result;
        try { result = await refreshRecord(record); }
        catch { result = record; } // A lost response does not establish rejection.
        if (result.status !== 'pending') {
          await history.included({ txHash: result.txHash, success: result.status === 'confirmed' });
          await chrome.storage.local.remove(journalKey);
          if (result.status === 'failed') throw Error(result.message);
          const completed = { txHash: result.txHash, userOpHash: record.userOpHash, smartAddr: address,
            blockNumber: result.receipt.blockNumber, protocol: 'ERC-4337' };
          await history.complete(completed);
          log('Transaction: ' + result.txHash, 'data');
          onPhase('done');
          return completed;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const error = Error('Confirmation is pending. Inspect this UserOperation before sending again: ' + record.userOpHash);
      error.userOpHash = record.userOpHash;
      throw error;
    });
  } catch (error) {
    await history.failed(error);
    log(error.message, 'err');
    onPhase('error');
    throw error;
  } finally { busy.value = false; }
}
