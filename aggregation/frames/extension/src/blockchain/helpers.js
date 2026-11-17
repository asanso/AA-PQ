import { vaultManager } from '../vault/VaultManager.js';
import { DEFAULT_CHAIN_ID } from '../config/chain-defaults.js';
import { publicKey } from '../native-frame/keys.js';
import { activeProtocol, accountNonce } from '../transactions/protocol-adapter.js';
export async function getSmartAccountAddress(account=vaultManager.getActiveAccountIndex()) {
  const epoch=vaultManager.sessionEpoch;
  const {config,accountAddress}=activeProtocol();
  const key=await publicKey(account);
  if(epoch!==vaultManager.sessionEpoch || !vaultManager.isUnlocked()) throw Error('Wallet context changed.');
  const address=accountAddress(config,key.backupPkSeed,key.backupPkRoot);
  if(vaultManager.getSmartAccountAddress(DEFAULT_CHAIN_ID,account)?.toLowerCase() !== address.toLowerCase())
    await vaultManager.setSmartAccountAddress(address,DEFAULT_CHAIN_ID,account);
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
