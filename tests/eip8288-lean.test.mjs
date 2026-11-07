import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {decodeBlockProof, depsHash, frameSignatureHash} from '../explorer/aggregation-proof.mjs';
import {validateProofWrapper} from '../frontend/aggregation-rpc.mjs';
import {createProtocol} from '../aggregation/frames/wallet/protocol.mjs';

const ethers = createRequire(new URL('../explorer/package.json', import.meta.url))('ethers');
const {encodeRlp, decodeRlp, keccak256, hexlify} = ethers;
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

const wrapper = raw(manifest.walletWrapper.file);
const parts = () => decodeRlp(wrapper);

test('G1: the wallet wrapper passes only under the upstream format', () => {
  assert.equal(validateProofWrapper(wrapper, lean), manifest.walletWrapper.txHash);
  assert.throws(() => validateProofWrapper(wrapper, 'daisugi-v1'));
  const [[typed], , [[dependency], [witness]]] = parts();
  assert.throws(() => validateProofWrapper(encodeRlp([[typed], '0x', [dependency, [witness]]]), lean), /one wallet dependency/);
  // The upstream test wrapper carries a leanSTARK dependency, which the wallet never sends.
  assert.throws(() => validateProofWrapper(raw('wrapper.rlp'), lean), /oversized/);
});

test('G1: wallet-generated wrappers pass, with and without account creation', () => {
  const p = createProtocol(ethers, lean);
  const options = {config: {chainId: 1337, factory: '0x0000000000000000000000000000000000000010', implementation: '0x0000000000000000000000000000000000000020'},
    pkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), pkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16), nonce: 0,
    recipient: '0x0000000000000000000000000000000000000040', value: 1, data: '0x' + 'ab'.repeat(4096), maxFee: 3000000000n, priorityFee: 1000000000n};
  for (const deployed of [false, true]) {
    const request = p.signedRequest(p.prepare({...options, deployed}), '0x' + '55'.repeat(6176));
    assert.equal(validateProofWrapper(request.wrapper, lean), request.hash);
    assert.throws(() => validateProofWrapper(request.wrapper, 'daisugi-v1'));
  }
});

test('G2: the gateway refuses wrappers outside the wallet profile', () => {
  const tx = w => decodeRlp('0x' + w[0][0].slice(4));
  const setTx = (w, t) => { w[0][0] = '0x06' + encodeRlp(t).slice(2); };
  const flip = hex => hex.slice(0, -2) + (hex.endsWith('00') ? '01' : '00');
  const cases = {
    'no transaction': [/one direct-witness transaction/, w => { w[0] = []; }],
    'a transaction hash reference': [/witness encoding/, w => { w[0] = [[w[0][0]]]; }],
    'duplicate transactions': [/one direct-witness transaction/, w => { w[0] = [w[0][0], w[0][0]]; }],
    'an unknown mode': [/one direct-witness transaction/, w => { w[1] = '0x02'; }],
    'recursive mode (gateway policy: direct witnesses only)': [/one direct-witness transaction/, w => { w[1] = '0x01'; }],
    'a bare dependency': [/one wallet dependency/, w => { w[2][0] = w[2][0][0]; }],
    'two dependencies': [/one wallet dependency/, w => { w[2][0] = [w[2][0][0], w[2][0][0]]; w[2][1] = [w[2][1][0], w[2][1][0]]; }],
    'a short triple': [/witness encoding/, w => { w[2][0][0] = w[2][0][0].slice(0, -2); }],
    'a non-zero triple prefix': [/wallet profile/, w => { w[2][0][0] = '0x01' + w[2][0][0].slice(4); }],
    'a leanSTARK scheme': [/wallet profile/, w => { w[2][0][0] = w[2][0][0].slice(0, 64) + '11' + w[2][0][0].slice(66); }],
    'the key hash instead of the raw key': [/wallet profile/, w => { w[2][0][0] = w[2][0][0].slice(0, 130) + keccak256('0x' + w[2][0][0].slice(130)).slice(2); }],
    'a witness for another key': [/wallet profile/, w => { w[2][1][0] = '0x' + flip(w[2][1][0].slice(0, 66)).slice(2) + w[2][1][0].slice(66); }],
    'a short witness': [/witness encoding/, w => { w[2][1][0] = w[2][1][0].slice(0, -2); }],
    'no witness list': [/witness encoding/, w => { w[2][1] = w[2][1][0]; }],
    'a triple that is not the dependency frame': [/wallet profile/, w => { w[2][0][0] = flip(w[2][0][0].slice(0, 130)) + w[2][0][0].slice(130); }],
    'another chain': [/chain 1337/, w => { const t = tx(w); t[0] = '0x01'; setTx(w, t); }],
    'a non-frame transaction': [/witness encoding/, w => { w[0][0] = vector.transactions[2]; }],
    'a truncated transaction': [/Invalid frame transaction encoding\.$/, w => { w[0][0] = w[0][0].slice(0, -2); }],
    'trailing bytes after the transaction': [/Invalid frame transaction encoding\.$/, w => { w[0][0] += '00'; }],
    // Nonce 2 written as the one-byte string 0x8102 instead of 0x02.
    'a non-canonical transaction': [/Invalid frame transaction encoding\.$/, w => {
      assert.equal(w[0][0].slice(0, 16), '0x06f8ee820539c180'.slice(0, 16));
      w[0][0] = '0x06f8ef820539c1808102' + w[0][0].slice(20); }],
  };
  for (const [name, [reason, mutate]] of Object.entries(cases)) {
    const w = parts(); mutate(w);
    assert.throws(() => validateProofWrapper(encodeRlp(w), lean), reason, name);
  }
  assert.throws(() => validateProofWrapper(wrapper + '00', lean), /encoding/);
  assert.throws(() => validateProofWrapper(wrapper.slice(0, -2), lean), /encoding/);
  assert.throws(() => validateProofWrapper('0x' + '00'.repeat(48 * 1024 + 1), lean), /oversized/);
});

// The gateway reads its chain from the network profile at import, so the other network runs in its own process.
test('G3: the gateway accepts only wallet wrappers signed for the profile chain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'eip8288-lean-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'network.json');
  await writeFile(file, JSON.stringify({name: 'Daisugi Next', chainId: 7357, genesisHash: '0x' + '11'.repeat(32), frameActivationBlock: 100,
    entryPoint: '0x' + '22'.repeat(20), nativeFactory: '0x' + '33'.repeat(20), nativeImplementation: '0x' + '44'.repeat(20),
    nativeImplementationCodeHash: '0x' + '55'.repeat(32), nativeVerifier: '0x' + '66'.repeat(20), nativeVerifierCodeHash: '0x' + '77'.repeat(32),
    eip8288Format: lean}));
  const p = createProtocol(ethers, lean);
  const signedFor = chainId => p.signedRequest(p.prepare({config: {chainId, factory: '0x' + '10'.repeat(20), implementation: '0x' + '20'.repeat(20)},
    pkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), pkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16), nonce: 0, deployed: false,
    recipient: '0x' + '40'.repeat(20), value: 1, maxFee: 3000000000n, priorityFee: 1000000000n}), '0x' + '55'.repeat(6176));
  const other = signedFor(7357);
  assert.throws(() => validateProofWrapper(other.wrapper, lean), /chain 1337/);
  const probe = `import {validateProofWrapper} from './frontend/aggregation-rpc.mjs';
    const check = wrapper => { try { return validateProofWrapper(wrapper); } catch (error) { return error.message; } };
    console.log(JSON.stringify([check(process.argv[1]), check(process.argv[2])]));`;
  const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', probe, other.wrapper, wrapper],
    {cwd: new URL('..', import.meta.url), env: {...process.env, DAISUGI_NETWORK_PROFILE: file}, maxBuffer: 1 << 20});
  assert.deepEqual(JSON.parse(stdout), [other.hash, 'Expected a chain 7357 frame transaction with nonce key zero.']);
});
