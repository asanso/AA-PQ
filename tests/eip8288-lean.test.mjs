import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {decodeBlockProof, depsHash, frameSignatureHash} from '../explorer/aggregation-proof.mjs';
import {validateProofWrapper} from '../frontend/aggregation-rpc.mjs';

const {encodeRlp, decodeRlp, keccak256, hexlify} = createRequire(new URL('../explorer/package.json', import.meta.url))('ethers');
// Captured from upstream Nethermind feature/eip8288-lean; see fixtures/eip8288-lean/manifest.json.
const dir = new URL('./fixtures/eip8288-lean/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)));
const vector = JSON.parse(readFileSync(new URL('block-hash-vector.json', dir)));
const raw = file => hexlify(readFileSync(new URL(file, dir)));
const lean = 'eip8288-lean';
const decode = (block, hash, tx) => decodeBlockProof(block, hash, tx, lean);
const reencode = block => encodeRlp(block);
const blockHash = block => keccak256(encodeRlp(block[0]));

test('E1: the proof-bearing upstream block commits to its body proof and BLAKE2s dependency hash', () => {
  const {file, hash, transaction} = manifest.blocks.proof;
  const result = decode(raw(file), hash, transaction);
  assert.equal(result.status, 'available');
  assert.equal(result.proofBytes, 325792);
  assert.equal(result.commitment, manifest.wrapper.depsHash);
  assert.equal(result.commitmentMatches, true);
  assert.equal(result.claimCount, 2);
  assert.equal(result.transactionCovered, true);
  assert.equal(result.transactionClaimCount, 2);
  assert.equal(result.cryptographicVerification, 'not-performed-by-explorer');
});

test('E2: fork blocks without dependencies carry an empty proof', () => {
  for (const {file, hash} of [manifest.blocks.firstFork, manifest.blocks.laterEmpty]) {
    const result = decode(raw(file), hash);
    assert.equal(result.status, 'empty-set');
    assert.equal(result.proofBytes, 0);
    assert.equal(result.claimCount, 0);
    assert.equal(result.commitment, vector.emptyDepsHash);
  }
});

test('E3: a pre-fork block has no proof', () => {
  const {file, hash} = manifest.blocks.preFork;
  assert.equal(decode(raw(file), hash).status, 'missing');
});

test('E4: tampered proofs, dependencies and legacy headers are refused', () => {
  const block = decodeRlp(raw(manifest.blocks.proof.file)), hash = manifest.blocks.proof.hash;
  const flipped = structuredClone(block);
  flipped[4] = flipped[4].slice(0, -2) + (flipped[4].endsWith('00') ? '01' : '00');
  assert.throws(() => decode(reencode(flipped), hash), /proof does not match/);

  const changed = structuredClone(block), tx = decodeRlp('0x' + changed[1][0].slice(4));
  const dependencyFrame = tx[4].find(frame => frame[0] === '0x04');
  dependencyFrame[5] = dependencyFrame[5].slice(0, -2) + (dependencyFrame[5].endsWith('00') ? '01' : '00');
  changed[1][0] = '0x06' + encodeRlp(tx).slice(2);
  assert.throws(() => decode(reencode(changed), hash), /dependency commitment/);

  const legacy = structuredClone(block);
  legacy[0] = [...legacy[0].slice(0, 23), ['0xabcdef', '0x' + '11'.repeat(32)]];
  assert.throws(() => decode(reencode(legacy), blockHash(legacy)), /Unsupported/);
});

test('E5: dependency and signature hashes match the cross-client vector', () => {
  assert.equal(depsHash([]), vector.emptyDepsHash);
  assert.equal(frameSignatureHash(vector.transactions[0]), vector.signatureHash);
  assert.equal(frameSignatureHash(decodeRlp(raw('wrapper.rlp'))[0][0]), manifest.wrapper.signatureHash);
  // The vector covers a zero data hash bound to the signature hash, a duplicate triple, an explicit-msg signature
  // and a leanSTARK dependency (split domain).
  const header = decodeRlp(vector.headerRlp), block = [header, vector.transactions, [], [], vector.proof];
  const result = decode(reencode(block), vector.blockHash);
  assert.equal(result.commitment, vector.depsHash);
  assert.equal(result.declarationCount, 4);
  assert.equal(result.claimCount, 3);
});

test('E7: upstream proofs are labelled as EIP-8288 recursive STARKs', () => {
  const {file, hash} = manifest.blocks.proof;
  assert.equal(decode(raw(file), hash).format, 'EIP-8288 recursive STARK');
});

const wrapper = raw('wrapper.rlp');
const parts = () => decodeRlp(wrapper);

test('G1: the upstream wrapper passes only under the upstream format', () => {
  assert.equal(validateProofWrapper(wrapper, lean), manifest.wrapper.txHash);
  assert.throws(() => validateProofWrapper(wrapper, 'daisugi-v1'));
  const [[typed], , [[dependency], [witness]]] = parts();
  assert.throws(() => validateProofWrapper(encodeRlp([[typed], '0x', [dependency, [witness]]]), lean), /dependency list/);
});

test('G2: the gateway refuses what the upstream decoder refuses', () => {
  const cases = {
    'no transaction': w => { w[0] = []; },
    'a transaction hash reference': w => { w[0] = [[w[0][0]]]; },
    'duplicate transactions': w => { w[0] = [w[0][0], w[0][0]]; },
    'an unknown mode': w => { w[1] = '0x02'; },
    'recursive mode (gateway policy: direct witnesses only)': w => { w[1] = '0x01'; },
    'a bare dependency': w => { w[2][0] = w[2][0][0]; },
    'a short triple': w => { w[2][0][0] = w[2][0][0].slice(0, -2); },
    'a non-zero triple prefix': w => { w[2][0][0] = '0x01' + w[2][0][0].slice(4); },
    'an unknown scheme': w => { w[2][0][0] = w[2][0][0].slice(0, 64) + '12' + w[2][0][0].slice(66); },
    'no witness list': w => { w[2][1] = w[2][1][0]; },
    'another chain': w => { const tx = decodeRlp('0x' + w[0][0].slice(4)); tx[0] = '0x01'; w[0][0] = '0x06' + encodeRlp(tx).slice(2); },
    'a non-frame transaction': w => { w[0][0] = vector.transactions[2]; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const w = parts(); mutate(w);
    assert.throws(() => validateProofWrapper(encodeRlp(w), lean), Error, name);
  }
  assert.throws(() => validateProofWrapper(wrapper + '00', lean), /trailing|encoding/);
  assert.throws(() => validateProofWrapper('0x' + '00'.repeat(2 * 1024 * 1024 + 1), lean), /oversized/);
});
