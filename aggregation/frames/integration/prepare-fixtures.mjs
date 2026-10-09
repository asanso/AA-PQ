import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const [inputFile, project, output] = process.argv.slice(2);
if (!inputFile || !project || !output) throw Error('Usage: prepare-fixtures.mjs INPUT.json PROJECT OUTPUT');
const require = createRequire(join(resolve(project), 'frontend/package.json'));
const { keccak256, getBytes, concat } = require('ethers');
const original = JSON.parse(readFileSync(inputFile, 'utf8'));
if (!Array.isArray(original.claims)) throw Error('A claims array is required');
const claims = original.claims.slice(0, 2).map(claim => {
  for (const field of ['pkSeed', 'pkRoot']) {
    if (!/^0x[0-9a-fA-F]{32}0{32}$/.test(claim[field])) throw Error('Noncanonical wallet public key');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(claim.message)) throw Error('A 32-byte message is required');
  if (!/^0x[0-9a-fA-F]{12352}$/.test(claim.signature)) throw Error('A 6,176-byte signature is required');
  return {
    publicKey: `0x${claim.pkRoot.slice(2, 34)}${claim.pkSeed.slice(2, 34)}`,
    message: claim.message,
    signature: claim.signature,
  };
});
if (claims.length !== 2) throw Error('Two retained wallet claims are required');
const dependencies = claims.map(claim => ({
  scheme: 16,
  message: claim.message,
  publicKeyHash: keccak256(claim.publicKey),
  triple: concat([`0x${'00'.repeat(31)}10`, claim.message, keccak256(claim.publicKey)]),
}));
const triples = [...new Set(dependencies.map(d => d.triple.toLowerCase()))].sort();
const claimBytes = [...new Set(claims.map(c => `${c.message.slice(2)}${c.publicKey.slice(2)}`.toLowerCase()))].sort();
const oneHopHash = `0x${createHash('blake2s256').update(Buffer.from(claimBytes.join(''), 'hex')).digest('hex')}`;
mkdirSync(output, { recursive: true });
const write = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
write('wallet-input.json', { profile: 'leanvm-f33f31bf-sphincs-block-deps', claims });
write('expected.json', { claims: claims.map(({ signature, ...claim }) => claim), dependencies,
  oneHopHash, nethermindHash: keccak256(concat(triples)),
  inputSha256: createHash('sha256').update(readFileSync(inputFile)).digest('hex'),
  signatureBytes: claims.map(c => getBytes(c.signature).length),
  scope: 'Retained wallet signatures; dependency commitments, not new transaction authorization.' });
console.log(JSON.stringify({ claims: claims.length, oneHopHash, nethermindHash: keccak256(concat(triples)) }));
