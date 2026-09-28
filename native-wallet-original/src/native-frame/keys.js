import { vaultManager } from '../vault/VaultManager.js';
import { getBytes } from 'ethers';
const commitments = new Map();
function context(account) {
  const hd = vaultManager.getHdKeyring();
  if (!hd || !vaultManager.isUnlocked()) throw Error('Unlock the wallet first.');
  return {hd, fingerprint:hd.getIdentityAddress(account).toLowerCase()};
}
async function work(account, action, digest) {
  const {hd,fingerprint} = context(account);
  const seed = getBytes(hd.getKeyAtIndex(0,vaultManager.getHdAccountIndex(account),0).privateKey);
  const worker = new Worker(new URL('./signer.worker.js',import.meta.url),{type:'module'});
  try {
    const result = await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(Error('SPHINCS signing timed out. No transaction was submitted.')),180000);
      worker.onmessage = ({data}) => {clearTimeout(timer);data.error?reject(Error(data.error)):resolve(data);};
      worker.onerror = () => {clearTimeout(timer);reject(Error('SPHINCS worker failed.'));};
      worker.postMessage({action,digest,seed:seed.buffer},[seed.buffer]);
    });
    if (context(account).fingerprint !== fingerprint) throw Error('The unlocked wallet changed.');
    return result;
  } finally { worker.terminate(); if(seed.byteLength) seed.fill(0); }
}
export async function publicKey(account=vaultManager.getActiveAccountIndex()) {
  const {fingerprint}=context(account), id=account+':'+fingerprint;
  if (!commitments.has(id)) commitments.set(id,work(account,'derive').catch(error=>{commitments.delete(id);throw error;}));
  return commitments.get(id);
}
export const signDigest = (account,digest) => work(account,'sign',digest);
