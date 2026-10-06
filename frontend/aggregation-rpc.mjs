import {decodeRlp, encodeRlp, keccak256} from 'ethers';
const bytes = v => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(v);
const quantity = v => bytes(v) && v.length <= 66 && (v === '0x' || !v.slice(2).startsWith('00'));
const address = v => /^0x[0-9a-f]{40}$/i.test(v || '');
const integer = v => v === '0x' ? 0n : BigInt(v);

// The gateway accepts the wallet's bounded direct-witness profile. The node
// performs cryptographic verification, account authorization and pool admission.
export function validateProofWrapper(raw) {
  if (!bytes(raw) || raw.length > 96 * 1024) throw Error('Invalid or oversized proof wrapper.');
  const wrapper = decodeRlp(raw);
  if (!Array.isArray(wrapper) || wrapper.length !== 3 || encodeRlp(wrapper).toLowerCase() !== raw.toLowerCase()
      || !Array.isArray(wrapper[0]) || wrapper[0].length !== 1 || wrapper[1] !== '0x'
      || !Array.isArray(wrapper[2]) || wrapper[2].length !== 2) throw Error('Expected one direct-witness transaction.');
  const [dependency, witnesses] = wrapper[2], typed = wrapper[0][0];
  if (!bytes(typed) || !typed.startsWith('0x06') || !bytes(dependency) || dependency.length !== 194
      || !Array.isArray(witnesses) || witnesses.length !== 1 || !bytes(witnesses[0]) || witnesses[0].length !== 12418)
    throw Error('Invalid dependency or signature witness encoding.');
  const tx = decodeRlp('0x'+typed.slice(4));
  if (!Array.isArray(tx) || tx.length !== 8 || tx[0] !== '0x0539' || !Array.isArray(tx[1]) || tx[1].length !== 1
      || tx[1][0] !== '0x' || !quantity(tx[2]) || integer(tx[2]) >= 1n << 64n || !address(tx[3]))
    throw Error('Expected a chain 1337 frame transaction with nonce key zero.');
  const frames = tx[4];
  if (!Array.isArray(frames) || ![3,4].includes(frames.length) || !Array.isArray(tx[5]) || tx[5].length
      || !Array.isArray(tx[6]) || tx[6].length !== 3 || !tx[6].every(quantity) || integer(tx[6][0]) > integer(tx[6][1])
      || tx[6][2] !== '0x' || !Array.isArray(tx[7]) || tx[7].length) throw Error('Unsupported aggregate transaction envelope.');
  for (const f of frames) {
    if (!Array.isArray(f) || f.length !== 6 || !quantity(f[0]) || !quantity(f[1]) || integer(f[1]) > 3n
        || !(f[2] === '0x' || address(f[2])) || !Array.isArray(f[3]) || f[3].length !== 2
        || !f[3].every(v => quantity(v) && integer(v) <= 5000000n) || !quantity(f[4]) || !bytes(f[5]) || f[5].length > 8194)
      throw Error('Invalid aggregate frame fields.');
  }
  const dep = frames[frames.length-3];
  if (frames.length === 4 && (frames[0][0] !== '0x' || frames[0][1] !== '0x' || frames[0][4] !== '0x')) throw Error('Invalid creation frame.');
  if (dep[0] !== '0x04' || dep[1] !== '0x' || dep[4] !== '0x' || dep[5].toLowerCase() !== dependency.toLowerCase()
      || integer('0x'+dependency.slice(2,66)) !== 16n || keccak256('0x'+witnesses[0].slice(2,66)) !== '0x'+dependency.slice(130).toLowerCase()
      || frames.at(-2)[0] !== '0x01' || frames.at(-2)[1] !== '0x03' || frames.at(-1)[0] !== '0x02')
    throw Error('The declared dependency does not match this wallet profile.');
  return keccak256(typed);
}
