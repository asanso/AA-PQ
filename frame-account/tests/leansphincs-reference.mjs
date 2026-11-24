// leanSPHINCS verification in JavaScript: the test oracle for contracts/LeanSphincsVerifier.sol.
//
// A line-by-line port of `verify` in leanEthereum/leanVM crates/lean_sphincs at
// f7ba4999ae523b94c8d0969b32762c3effea4cbd, the revision Nethermind's lean-bindings pin for the
// EIP-8288 scheme 0x10. It exists to check the Solidity verifier; it is not a wallet signer and has
// not been reviewed for production use. Keccak-256 is injected so the module has no dependency.

export const N = 16;
export const MESSAGE_LEN = 32;
export const PUBLIC_KEY_LEN = 2 * N;
export const W = 2;
export const CHAIN_LEN = 1 << W;
export const V = 64;
export const TARGET_SUM = 128;
export const COUNTER_LEN = 4;
export const LAYER_HEIGHTS = Object.freeze([8, 8, 10]);
export const H = LAYER_HEIGHTS.reduce((a, b) => a + b, 0);
export const FORS_TREES = 24;
export const FORS_HEIGHT = 10;
export const FORS_OPENING_LEN = N + FORS_HEIGHT * N;
export const layerSignatureLength = height => COUNTER_LEN + V * N + height * N;
export const SIGNATURE_LEN = N + FORS_TREES * FORS_OPENING_LEN
  + LAYER_HEIGHTS.reduce((total, height) => total + layerSignatureLength(height), 0);

// FIPS 205 address types, and WOTS+C's encoding (7).
export const WOTS_HASH = 0, WOTS_PK = 1, TREE = 2, FORS_TREE = 3, FORS_ROOTS = 4, WOTS_ENC = 7;

if (H !== 26 || SIGNATURE_LEN !== 7740) throw Error('leanSPHINCS parameters do not match the reference.');

/** FIPS 205's 32-byte address: layer (0..4), tree (8..16), type, key pair, chain or height, hash or index. */
export function adrs(layer, tree, type, keyPair = 0, word2 = 0, word3 = 0) {
  const out = new Uint8Array(32), view = new DataView(out.buffer);
  view.setUint32(0, layer);
  view.setBigUint64(8, BigInt(tree));
  view.setUint32(16, type);
  view.setUint32(20, keyPair);
  view.setUint32(24, word2);
  view.setUint32(28, word3);
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};
const be32 = value => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; };
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Returns `verify(publicKey, message, signature)`: true or false for well-formed inputs, null for inputs of the
 * wrong length, as in EthLib's vectors. Inputs are Uint8Arrays.
 */
export function createLeanSphincs(keccak256) {
  const hash = bytes => keccak256(bytes);
  // F, H and T_l: Trunc_n(Keccak-256(PK.seed | ADRS | M)).
  const th = (pkSeed, address, ...values) => hash(concat(pkSeed, address, ...values)).slice(0, N);

  // H_msg in counter mode, and the index and FORS leaves its first 34 bytes spell (FIPS 205 Algorithm 19).
  function digestFields(randomizer, pkSeed, pkRoot, message) {
    const digest = concat(...[0, 1].map(i => hash(concat(randomizer, pkSeed, pkRoot, message, be32(i)))));
    const bit = p => (digest[p >> 3] >> (7 - (p & 7))) & 1;
    const leaves = Array.from({ length: FORS_TREES }, (_, c) => {
      let value = 0;
      for (let j = 0; j < FORS_HEIGHT; j++) value = value << 1 | bit(FORS_HEIGHT * c + j);
      return value;
    });
    const mdBytes = Math.ceil(FORS_TREES * FORS_HEIGHT / 8), treeBytes = Math.ceil((H - LAYER_HEIGHTS[0]) / 8);
    const int = (bytes, bits) => Number(bytes.reduce((v, b) => v << 8n | BigInt(b), 0n) & ((1n << BigInt(bits)) - 1n));
    const tree = int(digest.slice(mdBytes, mdBytes + treeBytes), H - LAYER_HEIGHTS[0]);
    const leaf = int(digest.slice(mdBytes + treeBytes, mdBytes + treeBytes + 1), LAYER_HEIGHTS[0]);
    return { idx: tree * 2 ** LAYER_HEIGHTS[0] + leaf, leaves };
  }

  // The root a leaf at index `e` and its path reach; node `j` at height `z` is hashed by `node(z, j, children)`.
  function pathFold(leaf, e, path, node) {
    return path.reduce((current, sibling, z) => {
      const children = Math.floor(e / 2 ** z) % 2 === 0 ? [current, sibling] : [sibling, current];
      return node(z + 1, Math.floor(e / 2 ** (z + 1)), children);
    }, leaf);
  }

  // The key of `layer` on the way from bottom leaf `idx` up.
  function otsKey(layer, idx) {
    const height = LAYER_HEIGHTS[layer], below = LAYER_HEIGHTS.slice(0, layer).reduce((a, b) => a + b, 0);
    const e = Math.floor(idx / 2 ** below);
    return { layer, tree: Math.floor(e / 2 ** height), leaf: e % 2 ** height };
  }

  return function verify(publicKey, message, signature) {
    if (publicKey.length !== PUBLIC_KEY_LEN || message.length !== MESSAGE_LEN || signature.length !== SIGNATURE_LEN) return null;
    const pkSeed = publicKey.slice(0, N), pkRoot = publicKey.slice(N);
    let at = 0;
    const take = length => signature.slice(at, at += length);
    const randomizer = take(N);
    const fors = Array.from({ length: FORS_TREES }, () => ({
      secret: take(N), path: Array.from({ length: FORS_HEIGHT }, () => take(N)) }));
    const layers = LAYER_HEIGHTS.map(height => ({
      counter: new DataView(take(COUNTER_LEN).buffer).getUint32(0),
      wots: Array.from({ length: V }, () => take(N)),
      path: Array.from({ length: height }, () => take(N)) }));

    const { idx, leaves } = digestFields(randomizer, pkSeed, pkRoot, message);

    // fors_pkFromSig: each tree's root from its opening, then T_k over the roots.
    const forsKey = otsKey(0, idx);
    const forsAdrs = (type, height, index) => adrs(0, forsKey.tree, type, forsKey.leaf, height, index);
    const roots = fors.map(({ secret, path }, c) => {
      const s = leaves[c];
      const leaf = th(pkSeed, forsAdrs(FORS_TREE, 0, c * 2 ** FORS_HEIGHT + s), secret);
      return pathFold(leaf, s, path, (z, j, children) =>
        th(pkSeed, forsAdrs(FORS_TREE, z, c * 2 ** (FORS_HEIGHT - z) + j), ...children));
    });
    let signed = th(pkSeed, forsAdrs(FORS_ROOTS), ...roots);

    // Each layer's WOTS+C key signs what the layer below gives; its tree's root goes up.
    for (const [layer, { counter, wots, path }] of layers.entries()) {
      const key = otsKey(layer, idx);
      const encoding = th(pkSeed, adrs(layer, key.tree, WOTS_ENC, key.leaf), signed, be32(counter));
      const digits = Array.from({ length: V }, (_, i) => (encoding[i >> 2] >> (6 - 2 * (i & 3))) & 3);
      if (digits.reduce((a, b) => a + b, 0) !== TARGET_SUM) return false;
      const ends = wots.map((value, i) => {
        for (let from = digits[i]; from < CHAIN_LEN - 1; from++)
          value = th(pkSeed, adrs(layer, key.tree, WOTS_HASH, key.leaf, i, from), value);
        return value;
      });
      const leaf = th(pkSeed, adrs(layer, key.tree, WOTS_PK, key.leaf), ...ends);
      signed = pathFold(leaf, key.leaf, path, (z, j, children) =>
        th(pkSeed, adrs(layer, key.tree, TREE, 0, z, j), ...children));
    }
    return equal(signed, pkRoot);
  };
}

/** Reads EthLib's `data.yaml` vector format: an `input` map of hex strings and an `output`. */
export function parseVector(text) {
  const input = {};
  let output;
  for (const line of text.split('\n')) {
    let match;
    if ((match = /^ {2}([a-z_]+): '?(0x[0-9a-f]*)'?$/.exec(line))) input[match[1]] = match[2];
    else if ((match = /^output: '?([^']*)'?$/.exec(line))) output = match[1];
    else if (line.trim() && line !== 'input:') throw Error(`Unexpected vector line: ${line.slice(0, 40)}`);
  }
  if (output === undefined) throw Error('Vector has no output.');
  return { input, output: output === 'true' ? true : output === 'false' ? false : output === 'null' ? null : output };
}
