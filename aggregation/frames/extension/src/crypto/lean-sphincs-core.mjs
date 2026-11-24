// leanSPHINCS key generation, signing and verification through lean-sphincs.wasm, built by
// ../../lean-sphincs-wasm from leanEthereum/leanVM `crates/lean_sphincs` at f7ba4999 (EIP-8288 scheme 0x10 on
// Daisugi devnet-1). Experimental and not audited.
//
// The module has no imports. Inputs are copied into its linear memory and every buffer is zeroed when released;
// the WASM exports also zero the seed they read. The caller owns and zeroes its own copies.
import { keccak_256 } from '@noble/hashes/sha3';

export const LEAN_SPHINCS = Object.freeze({ seedBytes: 32, messageBytes: 32, publicKeyBytes: 32, signatureBytes: 7740 });

// Provisional wallet convention, not a standard: no upstream specification defines how SK.seed is derived from a
// mnemonic. As for the SPHINCS-G keys this wallet used before, SK.seed is a tagged Keccak-256 of the account's HD
// identity key (m/44'/60'/{account}'), whose ECDSA signing the keyring disables.
const SEED_TAG = new TextEncoder().encode('daisugi:lean-sphincs:sk-seed:v1');

/** SK.seed of the account whose 32-byte HD identity private key is `hdPrivateKey`. The caller zeroes the result. */
export function deriveLeanSphincsSeed(hdPrivateKey) {
  if (!(hdPrivateKey instanceof Uint8Array) || hdPrivateKey.length !== 32) throw Error('Invalid HD identity key.');
  const input = new Uint8Array(SEED_TAG.length + 32);
  input.set(SEED_TAG); input.set(hdPrivateKey, SEED_TAG.length);
  try { return keccak_256(input); } finally { input.fill(0); }
}

/** Instantiates lean-sphincs.wasm from its bytes or a compiled module. */
export async function instantiateLeanSphincs(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  if (WebAssembly.Module.imports(module).length) throw Error('Unexpected lean-sphincs.wasm imports.');
  const { exports: w } = await WebAssembly.instantiate(module, {});
  const memory = () => new Uint8Array(w.memory.buffer);

  const lengths = w.alloc(16);
  w.lean_sphincs_lengths(lengths);
  const actual = Array.from(new Uint32Array(w.memory.buffer.slice(lengths, lengths + 16)));
  w.dealloc(lengths, 16);
  const expected = [LEAN_SPHINCS.seedBytes, LEAN_SPHINCS.messageBytes, LEAN_SPHINCS.publicKeyBytes, LEAN_SPHINCS.signatureBytes];
  if (actual.join() !== expected.join()) throw Error('lean-sphincs.wasm has unexpected parameters.');

  // Runs `use` with fresh buffers holding `inputs` and empty `outputs` lengths, then zeroes and frees them all.
  function call(inputs, outputs, use) {
    const buffers = [];
    try {
      for (const bytes of inputs) { const p = w.alloc(bytes.length); buffers.push([p, bytes.length]); memory().set(bytes, p); }
      for (const length of outputs) buffers.push([w.alloc(length), length]);
      const pointers = buffers.map(([p]) => p);
      const result = use(...pointers);
      const read = buffers.slice(inputs.length).map(([p, length]) => memory().slice(p, p + length));
      return { result, read };
    } finally {
      for (const [p, length] of buffers) w.dealloc(p, length);
    }
  }
  const check = (bytes, length, name) => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw Error(`Invalid leanSPHINCS ${name} length.`);
  };

  return Object.freeze({
    /** The 32-byte public key PK.seed || PK.root of SK.seed. */
    keyGen(seed) {
      check(seed, LEAN_SPHINCS.seedBytes, 'seed');
      return call([seed], [LEAN_SPHINCS.publicKeyBytes], (s, pk) => w.lean_sphincs_key_gen(s, pk)).read[0];
    },
    /** The deterministic 7,740-byte signature of a 32-byte message. */
    sign(seed, message) {
      check(seed, LEAN_SPHINCS.seedBytes, 'seed'); check(message, LEAN_SPHINCS.messageBytes, 'message');
      return call([seed, message], [LEAN_SPHINCS.signatureBytes], (s, m, sig) => w.lean_sphincs_sign(s, m, sig)).read[0];
    },
    /** Whether `signature` verifies for `message` under `publicKey`. */
    verify(publicKey, message, signature) {
      check(publicKey, LEAN_SPHINCS.publicKeyBytes, 'public key'); check(message, LEAN_SPHINCS.messageBytes, 'message');
      check(signature, LEAN_SPHINCS.signatureBytes, 'signature');
      return call([publicKey, message, signature], [], (pk, m, sig) => w.lean_sphincs_verify(pk, m, sig)).result === 1;
    },
  });
}
