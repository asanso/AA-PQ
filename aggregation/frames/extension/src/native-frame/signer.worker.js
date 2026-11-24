import { getBytes, hexlify } from 'ethers';
import { deriveLeanSphincsSeed, instantiateLeanSphincs } from '../crypto/lean-sphincs-core.mjs';
import wasmUrl from '../crypto/lean-sphincs.wasm?url';

// One request per worker: derive the leanSPHINCS public key, or sign a 32-byte digest and check the signature
// locally before returning it. The HD identity key arrives as a transferred buffer and is zeroed with SK.seed.
self.onmessage = async ({ data }) => {
  const hdKey = new Uint8Array(data.seed);
  let secret;
  try {
    const lean = await instantiateLeanSphincs(await (await fetch(wasmUrl)).arrayBuffer());
    secret = deriveLeanSphincsSeed(hdKey);
    const publicKey = lean.keyGen(secret);
    if (data.action === 'derive') {
      self.postMessage({ publicKey: hexlify(publicKey) });
    } else if (data.action === 'sign') {
      const digest = getBytes(data.digest);
      const signature = lean.sign(secret, digest);
      if (!lean.verify(publicKey, digest, signature)) throw Error('Local signature verification failed.');
      self.postMessage({ signature: hexlify(signature), publicKey: hexlify(publicKey) });
    } else throw Error('Unsupported signer request.');
  } catch (error) { self.postMessage({ error: error.message }); }
  finally { hdKey.fill(0); secret?.fill(0); }
};
