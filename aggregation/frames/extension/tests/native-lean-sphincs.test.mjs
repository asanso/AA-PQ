import { test as check } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as e from 'ethers';
import { LEAN_SPHINCS, deriveLeanSphincsSeed, instantiateLeanSphincs } from '../src/crypto/lean-sphincs-core.mjs';
import { createNativeProtocol, SIGNATURE_BYTES } from '../src/native-frame/native-protocol.mjs';
import { createNativeClient } from '../src/native-frame/native-client.mjs';
import { HdKeyring } from '../src/keyring/HdKeyring.js';

// Known answers generated on Anvil from frame-account's LeanSphincsVerifier and LeanSphincsFrameAccountFactory; the
// frame-account tests check the same fixture against the contracts. EthLib's vectors are vendored in frame-account.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-lean-sphincs.json', import.meta.url), 'utf8'));
const ethlib = new URL('../../../../frame-account/tests/fixtures/leansphincs-ethlib/', import.meta.url);
const wasm = readFileSync(new URL('../src/crypto/lean-sphincs.wasm', import.meta.url));
const lean = await instantiateLeanSphincs(wasm);
const p = createNativeProtocol(e);
const config = fixture.config;
const witnessOf = raw => e.decodeRlp('0x' + raw.slice(4))[5][0][3];
const vector = path => {
  const fields = Object.fromEntries([...readFileSync(new URL(path, ethlib), 'utf8').matchAll(/^ {2}([a-z_]+): '?(0x[0-9a-f]*)'?$/gm)]
    .map(([, key, value]) => [key, value]));
  const output = /^output: '?([^'\n]*)'?$/m.exec(readFileSync(new URL(path, ethlib), 'utf8'))[1];
  return { input: fields, output: output === 'true' ? true : output === 'false' ? false : output === 'null' ? null : output };
};
const prepare = tx => p.prepare({ config, publicKey: fixture.publicKey, nonce: tx.nonce, recipient: fixture.recipient,
  value: BigInt(tx.valueWei), deployed: tx.deployed, maxFee: BigInt(fixture.maxFeeWei), priorityFee: BigInt(fixture.priorityFeeWei),
  callGas: BigInt(fixture.callGas) });

check('the committed lean-sphincs.wasm is the build lean-sphincs-wasm/build.sh reproduces', () => {
  assert.equal(createHash('sha256').update(wasm).digest('hex'), '915e01cd4b8f900deac579965893add6247a2170234df94f4188bcfc5351a968');
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(wasm)), []);
});

check('the WASM signer reproduces EthLib key generation and signing and agrees with every verify vector', () => {
  for (const name of ['known_answer', 'zero_seed']) {
    const { input, output } = vector(`key_gen/key_gen_${name}/data.yaml`);
    assert.equal(e.hexlify(lean.keyGen(e.getBytes(input.seed))), output, name);
  }
  for (const name of ['known_answer', 'zero_message', 'zero_seed']) {
    const { input, output } = vector(`sign/sign_${name}/data.yaml`);
    assert.equal(e.hexlify(lean.sign(e.getBytes(input.seed), e.getBytes(input.message))), output, name);
  }
  const cases = readdirSync(new URL('verify/', ethlib)).filter(name => name.startsWith('verify_'));
  assert.equal(cases.length, 26);
  for (const name of cases) {
    const { input, output } = vector(`verify/${name}/data.yaml`);
    const args = [input.public_key, input.message, input.signature].map(e.getBytes);
    if (output === null) assert.throws(() => lean.verify(...args), /length/, name);
    else assert.equal(lean.verify(...args), output, name);
  }
});

check('SK.seed derives from the HD identity key under its tag, and the account key from SK.seed', () => {
  const hd = e.HDNodeWallet.fromSeed(e.Mnemonic.fromPhrase(fixture.mnemonic).computeSeed()).derivePath(fixture.path);
  assert.equal(fixture.path, "m/44'/60'/0'");
  assert.equal(hd.privateKey, fixture.hdPrivateKey);
  // The wallet's own keyring derives the same identity key, at the same path.
  const keyring = new HdKeyring({ mnemonic: fixture.mnemonic });
  const key = keyring.getKeyAtIndex(0, 0);
  assert.equal(key.path, fixture.path);
  assert.equal(key.privateKey, fixture.hdPrivateKey);
  assert.notEqual(keyring.getKeyAtIndex(0, 1).privateKey, fixture.hdPrivateKey);
  assert.throws(() => keyring.getKeyAtIndex(1, 0), /one stable/);
  const seed = deriveLeanSphincsSeed(e.getBytes(hd.privateKey));
  const tag = e.toUtf8Bytes('daisugi:lean-sphincs:sk-seed:v1');
  assert.equal(e.hexlify(seed), e.keccak256(e.concat([tag, hd.privateKey])));
  assert.equal(e.hexlify(lean.keyGen(seed)), fixture.publicKey);
  assert.throws(() => deriveLeanSphincsSeed(new Uint8Array(31)), /HD identity key/);
  assert.throws(() => lean.keyGen(new Uint8Array(31)), /seed length/);
  assert.equal(LEAN_SPHINCS.signatureBytes, SIGNATURE_BYTES);
});

check('the account address and runtime follow LeanSphincsFrameAccountFactory', () => {
  assert.equal(p.accountAddress(config, fixture.publicKey), e.getAddress(fixture.account));
  assert.equal(p.accountRuntime(config.implementation, fixture.publicKey), fixture.accountCode.toLowerCase());
  assert.equal(e.getBytes(fixture.accountCode).length, 77);
  assert.throws(() => p.accountAddress(config, '0x' + '11'.repeat(31)), /public-key encoding/);
});

check('prepared and signed transactions reproduce the known answers byte for byte', () => {
  const seed = deriveLeanSphincsSeed(e.getBytes(fixture.hdPrivateKey));
  for (const tx of fixture.transactions) {
    const prepared = prepare(tx);
    assert.equal(prepared.digest, tx.digest);
    assert.equal(prepared.frameCount, tx.deployed ? 2 : 3);
    const signature = e.hexlify(lean.sign(seed, e.getBytes(prepared.digest)));
    assert.equal(e.sha256(signature), tx.signatureSha256);
    assert.equal(lean.verify(e.getBytes(fixture.publicKey), e.getBytes(tx.digest), e.getBytes(signature)), true);
    const request = p.signedRequest(prepared, signature);
    assert.equal(request.raw, tx.raw);
    assert.equal(request.hash, tx.hash);
    assert.equal(request.method, 'eth_sendRawTransaction');
    const frames = e.decodeRlp('0x' + tx.raw.slice(4))[4];
    if (!tx.deployed) assert.equal(frames[0][5], p.abi.encodeFunctionData('createAccount', [fixture.publicKey, e.ZeroHash]));
  }
  seed.fill(0);
});

check('the signing hash elides the witness bytes and covers everything else', () => {
  const tx = fixture.transactions[1];
  const payload = e.decodeRlp('0x' + tx.raw.slice(4));
  assert.equal(p.sigHash(payload), tx.digest);
  const otherWitness = structuredClone(payload); otherWitness[5][0][3] = '0x' + 'ab'.repeat(SIGNATURE_BYTES);
  assert.equal(p.sigHash(otherWitness), tx.digest);
  const otherNonce = structuredClone(payload); otherNonce[2] = p.quantity(3);
  assert.notEqual(p.sigHash(otherNonce), tx.digest);
  const otherValue = structuredClone(payload); otherValue[4].at(-1)[4] = p.quantity(1);
  assert.notEqual(p.sigHash(otherValue), tx.digest);
});

check('a signed request rejects a wrong-length signature or a changed transaction', () => {
  const tx = fixture.transactions[1];
  const prepared = prepare(tx);
  assert.throws(() => p.signedRequest(prepared, '0x' + '00'.repeat(SIGNATURE_BYTES - 1)), /signature length/);
  const tampered = { ...prepared, payload: structuredClone(prepared.payload) };
  tampered.payload[2] = p.quantity(9);
  assert.throws(() => p.signedRequest(tampered, witnessOf(tx.raw)), /changed after preparation/);
});

check('the native client requires the eip8288-lean envelope and complete pins', () => {
  const make = overrides => createNativeClient(e, { config: { ...config, ...overrides }, rpc: async () => {}, receiptOutcome: () => {} });
  assert.doesNotThrow(() => make({}));
  assert.throws(() => make({ eip8288Format: 'daisugi-v1' }), /eip8288-lean/);
  assert.throws(() => make({ verifierCodeHash: undefined }), /pinned/);
  assert.throws(() => make({ maxFeePerGas: '0' }), /fee ceiling/);
});

check('the network check pins the leanSPHINCS verifier reported by the factory', async () => {
  const replies = verifier => ({ eth_chainId: '0x' + config.chainId.toString(16), eth_getBlockByNumber: { hash: config.genesisHash },
    eth_getCode: '0x', eth_call: e.AbiCoder.defaultAbiCoder().encode(['address'], [verifier]) });
  const calls = [];
  const client = verifier => createNativeClient(e, { config, receiptOutcome: () => {}, rpc: async (method, params) => {
    calls.push([method, params]);
    return replies(verifier)[method];
  } });
  await assert.rejects(client(config.verifier).verifyNetwork(), /Contract identity/);
  const selectors = calls.filter(([method]) => method === 'eth_call').map(([, [{ data }]]) => data);
  assert.ok(selectors.includes(p.abi.encodeFunctionData('LEAN_SPHINCS_VERIFIER')));
  assert.ok(selectors.includes(p.abi.encodeFunctionData('ACCOUNT_IMPL')));
});
