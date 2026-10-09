import { getBytes } from 'ethers';
import { sphincsDerive, sphincsSign, sphincsVerify } from '../crypto/sphincs.js';
import { ensureWasmKeccak } from '../crypto/keccak.js';
import { keccakBatchInit } from '../crypto/keccak-batch.js';
self.onmessage = async ({data}) => {
  const seed = new Uint8Array(data.seed);
  let secret;
  try {
    await ensureWasmKeccak(); await keccakBatchInit();
    if (data.action === 'derive') {
      const key = sphincsDerive(seed, 'sphincs-g'); secret = key.skSeed;
      self.postMessage({backupPkSeed:key.backupPkSeed,backupPkRoot:key.backupPkRoot});
    } else if (data.action === 'sign') {
      const result = sphincsSign(seed, getBytes(data.digest), 'sphincs-g');
      if (!sphincsVerify(result.backupPkSeed,result.backupPkRoot,data.digest,result.sigHex,'sphincs-g').valid) throw Error('Local signature verification failed.');
      self.postMessage({signature:result.sigHex,backupPkSeed:result.backupPkSeed,backupPkRoot:result.backupPkRoot});
    } else throw Error('Unsupported signer request.');
  } catch(error) { self.postMessage({error:error.message}); }
  finally { seed.fill(0); secret?.fill?.(0); }
};
