import { vaultManager } from '../vault/VaultManager.js';
import { publicKey } from '../native-frame/keys.js';
import { activeProtocol, accountNonce } from '../transactions/protocol-adapter.js';
export async function getSmartAccountAddress(account=vaultManager.getActiveAccountIndex()) {
  const epoch=vaultManager.sessionEpoch;
  const {config,accountAddress}=activeProtocol();
  const key=await publicKey(account);
  if(epoch!==vaultManager.sessionEpoch || !vaultManager.isUnlocked()) throw Error('Wallet context changed.');
  const address=accountAddress(config,key.backupPkSeed,key.backupPkRoot);
  if(vaultManager.getSmartAccountAddress('0x539',account)?.toLowerCase() !== address.toLowerCase())
    await vaultManager.setSmartAccountAddress(address,'0x539',account);
  return address;
}
export const assertSmartAccountConsistent = () => getSmartAccountAddress();
export async function predictAccountAddress() {
  const epoch=vaultManager.sessionEpoch;
  const {config,accountAddress}=activeProtocol();
  const key=await publicKey();
  if(epoch!==vaultManager.sessionEpoch || !vaultManager.isUnlocked()) throw Error('Wallet context changed.');
  return accountAddress(config,key.backupPkSeed,key.backupPkRoot);
}
export const deploySmartAccount = () => getSmartAccountAddress();
export const getAccountNonce = accountNonce;
