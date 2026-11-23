import { test as check } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as e from 'ethers';
import { createNativeProtocol, SIGNATURE_BYTES } from '../src/native-frame/native-protocol.mjs';
import { createNativeClient } from '../src/native-frame/native-client.mjs';

// Two native frame transactions included on daisugi-devnet-0 (Nethermind af50ed1): the first creates the account.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-frame-devnet0.json', import.meta.url), 'utf8'));
const p = createNativeProtocol(e);
const config = fixture.config;
const witnessOf = raw => e.decodeRlp('0x' + raw.slice(4))[5][0][3];

check('the account address and runtime follow the frame-account factory', () => {
  assert.equal(p.accountAddress(config, fixture.pkSeed, fixture.pkRoot), e.getAddress(fixture.account));
  assert.equal(p.accountRuntime(config.implementation, fixture.pkSeed, fixture.pkRoot), fixture.accountCode.toLowerCase());
  assert.throws(() => p.accountAddress(config, '0x' + '11'.repeat(32), fixture.pkRoot), /public-key encoding/);
});

check('prepared transactions reproduce the included devnet-0 transactions byte for byte', () => {
  for (const tx of fixture.transactions) {
    const prepared = p.prepare({ config, pkSeed: fixture.pkSeed, pkRoot: fixture.pkRoot, nonce: tx.nonce, recipient: fixture.recipient,
      value: BigInt(tx.valueWei), deployed: tx.deployed, maxFee: BigInt(fixture.maxFeeWei), priorityFee: BigInt(fixture.priorityFeeWei),
      callGas: BigInt(fixture.callGas) });
    assert.equal(prepared.digest, tx.digest);
    assert.equal(prepared.frameCount, tx.deployed ? 2 : 3);
    const request = p.signedRequest(prepared, witnessOf(tx.raw));
    assert.equal(request.raw, tx.raw);
    assert.equal(request.hash, tx.hash);
    assert.equal(request.method, 'eth_sendRawTransaction');
  }
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
  const prepared = p.prepare({ config, pkSeed: fixture.pkSeed, pkRoot: fixture.pkRoot, nonce: tx.nonce, recipient: fixture.recipient,
    value: BigInt(tx.valueWei), deployed: true, maxFee: BigInt(fixture.maxFeeWei), priorityFee: BigInt(fixture.priorityFeeWei),
    callGas: BigInt(fixture.callGas) });
  assert.throws(() => p.signedRequest(prepared, '0x' + '00'.repeat(SIGNATURE_BYTES - 1)), /signature length/);
  const tampered = { ...prepared, payload: structuredClone(prepared.payload) };
  tampered.payload[2] = p.quantity(9);
  assert.throws(() => p.signedRequest(tampered, witnessOf(tx.raw)), /changed after preparation/);
});

check('the native client requires the eip8288-lean envelope and complete pins', () => {
  const pins = { active: true, chainId: config.chainId, genesisHash: '0x' + '11'.repeat(32), factory: config.factory,
    factoryCodeHash: '0x' + '22'.repeat(32), implementation: config.implementation, implementationCodeHash: '0x' + '33'.repeat(32),
    verifier: '0xA485414b1212E0729c9c3c8fF6EEa086b59791AB', verifierCodeHash: '0x' + '44'.repeat(32),
    maxFeePerGas: '100000000000', eip8288Format: 'eip8288-lean' };
  const make = overrides => createNativeClient(e, { config: { ...pins, ...overrides }, rpc: async () => {}, receiptOutcome: () => {} });
  assert.doesNotThrow(() => make({}));
  assert.throws(() => make({ eip8288Format: 'daisugi-v1' }), /eip8288-lean/);
  assert.throws(() => make({ verifierCodeHash: undefined }), /pinned/);
  assert.throws(() => make({ maxFeePerGas: '0' }), /fee ceiling/);
});
