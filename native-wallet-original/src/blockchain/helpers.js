import { vaultManager } from '../vault/VaultManager.js';
import { publicKey } from '../native-frame/keys.js';
import { accountAddress } from '../native-frame/protocol.js';
import config from '../native-frame/network.json';
import { rpc } from '../native-frame/client.js';
export async function getSmartAccountAddress(account=vaultManager.getActiveAccountIndex()) {
  const key=await publicKey(account);
  const address=accountAddress(config,key.backupPkSeed,key.backupPkRoot);
  if(vaultManager.getSmartAccountAddress('0x539',account)?.toLowerCase() !== address.toLowerCase())
    await vaultManager.setSmartAccountAddress(address,'0x539',account);
  return address;
}
export const assertSmartAccountConsistent = () => getSmartAccountAddress();
export async function predictAccountAddress() {const key=await publicKey();return accountAddress(config,key.backupPkSeed,key.backupPkRoot);}
export const deploySmartAccount = () => getSmartAccountAddress();
export const getAccountNonce = async address => BigInt(await rpc('eth_getTransactionCount',[address,'pending']));
