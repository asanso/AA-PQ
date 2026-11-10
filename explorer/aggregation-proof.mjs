import {createHash} from 'node:crypto';
import {decodeRlp, encodeRlp, keccak256, sha256, concat} from 'ethers';
import {NETWORK} from './network-profile.mjs';
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
export function dependencyClaims(data) {
  if (!hex(data) || data.length === 2 || (data.length-2)%192) return null;
  const result = [];
  for (let offset = 2; offset < data.length; offset += 192) {
    const raw = '0x'+data.slice(offset,offset+192).toLowerCase();
    result.push({scheme:BigInt('0x'+raw.slice(2,66)).toString(),digest:'0x'+raw.slice(66,130),keyHash:'0x'+raw.slice(130),raw});
  }
  return result;
}
export function decodeBlockProof(raw, expectedHash, transactionHash, format = NETWORK.eip8288Format) {
  if (format === 'eip8288-lean') return decodeLeanBlockProof(raw, expectedHash, transactionHash);
  if (!hex(raw) || raw.length > 32*1024*1024) throw Error('Invalid or oversized encoded block.');
  const block = decodeRlp(raw), header = block?.[0];
  if (!Array.isArray(header) || !Array.isArray(block[1]) || keccak256(encodeRlp(header)) !== expectedHash.toLowerCase())
    throw Error('Encoded block does not match the inclusion block.');
  if (transactionHash && !block[1].some(tx=>keccak256(Array.isArray(tx)?encodeRlp(tx):tx) === transactionHash.toLowerCase()))
    throw Error('Transaction is absent from the encoded block.');
  // Pinned PoS header: 15 base fields, eight optional fields, then the proof tuple.
  if (header.length < 24) return {status:'missing',message:'The inclusion block contains no aggregate proof.'};
  if (header.length !== 24 || !Array.isArray(header[23]) || header[23].length !== 2) throw Error('Unsupported aggregate header encoding.');
  const [proof, commitment] = header[23];
  if (!hex(proof) || proof === '0x' || proof.length > 16*1024*1024+2 || !/^0x[0-9a-f]{64}$/i.test(commitment)) throw Error('Invalid aggregate proof fields.');
  const declarations = [], transactions = [];
  for (const typed of block[1]) {
    if (typeof typed !== 'string' || !typed.startsWith('0x06')) continue;
    const tx = decodeRlp('0x'+typed.slice(4)), frames = Array.isArray(tx[1]) ? tx[4] : tx[3];
    if (!Array.isArray(frames)) throw Error('Malformed frame envelope.');
    const transactionClaims = [];
    for (const frame of frames) if (frame[0] === '0x04') {
      const claims = dependencyClaims(frame[5]);
      if (!claims) throw Error('Malformed dependency frame.');
      transactionClaims.push(...claims.map(claim=>claim.raw));
    }
    if (transactionClaims.length) {
      declarations.push(...transactionClaims);
      transactions.push({hash:keccak256(typed),claimCount:new Set(transactionClaims).size});
    }
  }
  const unique = [...new Set(declarations)].sort(), computed = keccak256(concat(unique));
  if (computed !== commitment.toLowerCase()) throw Error('Block dependency commitment does not match its transactions.');
  const current = transactions.find(tx=>tx.hash === transactionHash?.toLowerCase());
  return {status:unique.length ? 'available' : 'empty-set',proof,proofBytes:(proof.length-2)/2,proofSha256:sha256(proof),blockHash:expectedHash,
    commitment,claimCount:unique.length,declarationCount:declarations.length,commitmentMatches:true,
    transactionCount:transactions.length,transactions,transactionClaimCount:transactionHash ? current?.claimCount ?? 0 : null,
    transactionCovered:transactionHash ? Boolean(current) : null,
    format:proof.startsWith('0x4e4c5233') ? 'NLR3 (experimental)' : 'Unrecognized envelope',
    cryptographicVerification:'not-performed-by-explorer',
    message:unique.length ? 'Proof bytes are committed in this block header. The dependency commitment matches the block’s declarations. Cryptographic proof validation belongs to the execution client; it is not repeated by this explorer.' : 'This block declares no signature dependencies. Its empty-set envelope is not an aggregated signature proof.'};
}
// Upstream Nethermind feature/eip8288-lean (EIP-8141 signature hash, FrameDependency.cs ComputeDepsHash).
const LEAN_SPHINCS = 0x10, LEAN_STARK = 0x11;
const blake2s = (...parts) => '0x'+parts.reduce((h, part) => h.update(Buffer.from(part.slice(2), 'hex')), createHash('blake2s256')).digest('hex');
const LEAN_STARK_DOMAIN = '0x'+Buffer.from('eip8288/leanstark-deps').toString('hex').padEnd(64, '0');
const frameTransaction = typed => {
  const tx = decodeRlp('0x'+typed.slice(4));
  if (!Array.isArray(tx) || ![7, 8].includes(tx.length)) throw Error('Malformed frame envelope.');
  return tx;
};
/** EIP-8141 signature hash: keccak256(0x06 || rlp(tx)) with the signature bytes of empty-msg entries replaced by
 * their length (ethereum/EIPs#12502). */
export function frameSignatureHash(typed) {
  const tx = frameTransaction(typed), signatures = tx.length === 8 ? 5 : 4;
  const length = bytes => { const n = ((bytes.length - 2) / 2).toString(16); return n === '0' ? '0x' : '0x'+(n.length % 2 ? '0' : '')+n; };
  tx[signatures] = tx[signatures].map(([scheme, signer, msg, signature]) => [scheme, signer, msg, msg === '0x' ? length(signature) : signature]);
  return keccak256('0x06'+encodeRlp(tx).slice(2));
}
/** Sorted, deduplicated dependencies of 96-byte triples, as upstream canonicalizes them. */
const canonical = triples => [...new Set(triples.map(t => t.toLowerCase()))].sort();
/** BLAKE2s-256 over data_hash || key entries; a list holding leanSTARK hashes each scheme's list with a domain. */
export function depsHash(triples) {
  const list = canonical(triples), entries = items => blake2s(...items.map(t => '0x'+t.slice(66)));
  const sphincs = list.filter(t => parseInt(t.slice(64, 66), 16) === LEAN_SPHINCS), stark = list.filter(t => parseInt(t.slice(64, 66), 16) === LEAN_STARK);
  return stark.length ? blake2s(entries(sphincs), entries(stark), LEAN_STARK_DOMAIN) : entries(sphincs);
}
function decodeLeanBlockProof(raw, expectedHash, transactionHash) {
  if (!hex(raw) || raw.length > 32*1024*1024) throw Error('Invalid or oversized encoded block.');
  const block = decodeRlp(raw), header = block?.[0];
  if (!Array.isArray(header) || !Array.isArray(block[1]) || keccak256(encodeRlp(header)) !== expectedHash.toLowerCase())
    throw Error('Encoded block does not match the inclusion block.');
  if (transactionHash && !block[1].some(tx=>keccak256(Array.isArray(tx)?encodeRlp(tx):tx) === transactionHash.toLowerCase()))
    throw Error('Transaction is absent from the encoded block.');
  // Prague header (21 fields), then two reserved slots, keccak256(stark_proof) and block_deps_hash; the proof ends the body.
  if (header.length <= 21) return {status:'missing',message:'The inclusion block precedes EIP-8288 and contains no aggregate proof.'};
  if (header.length !== 25 || header[21] !== '0x' || header[22] !== '0x' || block.length !== 5 || !hex(block[4])
      || ![header[23], header[24]].every(v => /^0x[0-9a-f]{64}$/i.test(v))) throw Error('Unsupported aggregate header encoding.');
  const proof = block[4], commitment = header[24].toLowerCase();
  if (keccak256(proof) !== header[23].toLowerCase()) throw Error('Block proof does not match its header commitment.');
  const declarations = [], transactions = [];
  for (const typed of block[1]) {
    if (typeof typed !== 'string' || !typed.startsWith('0x06')) continue;
    const tx = frameTransaction(typed), frames = tx.length === 8 ? tx[4] : tx[3];
    if (!Array.isArray(frames)) throw Error('Malformed frame envelope.');
    let signatureHash;
    const transactionClaims = [];
    for (const frame of frames) if (frame[0] === '0x04') {
      const claims = dependencyClaims(frame[5]);
      if (!claims) throw Error('Malformed dependency frame.');
      // A zero data hash binds the dependency to the transaction's own signature hash.
      transactionClaims.push(...claims.map(c => /^0x0{64}$/.test(c.digest) ? c.raw.slice(0, 66)+(signatureHash ??= frameSignatureHash(typed)).slice(2)+c.raw.slice(130) : c.raw));
    }
    if (transactionClaims.length) {
      declarations.push(...transactionClaims);
      transactions.push({hash:keccak256(typed),claimCount:canonical(transactionClaims).length});
    }
  }
  if (depsHash(declarations) !== commitment) throw Error('Block dependency commitment does not match its transactions.');
  const claimCount = canonical(declarations).length, current = transactions.find(tx=>tx.hash === transactionHash?.toLowerCase());
  return {status:claimCount ? 'available' : 'empty-set',proof,proofBytes:(proof.length-2)/2,proofSha256:sha256(proof),blockHash:expectedHash,
    commitment,claimCount,declarationCount:declarations.length,commitmentMatches:true,
    transactionCount:transactions.length,transactions,transactionClaimCount:transactionHash ? current?.claimCount ?? 0 : null,
    transactionCovered:transactionHash ? Boolean(current) : null,
    format:'EIP-8288 recursive STARK',
    cryptographicVerification:'not-performed-by-explorer',
    message:claimCount ? 'The block body carries the recursive STARK; the header commits to its hash and to the block’s dependencies. Cryptographic proof validation belongs to the execution client; it is not repeated by this explorer.' : 'This block declares no signature dependencies, so it carries an empty proof.'};
}
export async function loadBlockProof(provider, tx) {
  if (!tx.blockHash) return {status:'pending',message:'The transaction has not been included in a block.'};
  try { return decodeBlockProof(await provider.send('debug_getRawBlock',[tx.blockHash]),tx.blockHash,tx.hash); }
  catch (error) { return {status:'unavailable',message:'The inclusion proof could not be retrieved or validated: '+error.message}; }
}
