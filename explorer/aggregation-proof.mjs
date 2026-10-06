import {decodeRlp, encodeRlp, keccak256, sha256, concat} from 'ethers';
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
export function decodeBlockProof(raw, expectedHash, transactionHash) {
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
export async function loadBlockProof(provider, tx) {
  if (!tx.blockHash) return {status:'pending',message:'The transaction has not been included in a block.'};
  try { return decodeBlockProof(await provider.send('debug_getRawBlock',[tx.blockHash]),tx.blockHash,tx.hash); }
  catch (error) { return {status:'unavailable',message:'The inclusion proof could not be retrieved or validated: '+error.message}; }
}
