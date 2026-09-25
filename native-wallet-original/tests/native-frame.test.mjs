import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, getBytes } from 'ethers';
import { accountAddress, accountRuntime, buildTransfer, signingHash, encodeFrame, decodeFrame, signedFrame, receiptOutcome, frameRpc } from '../src/native-frame/protocol.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/native-frame.json', import.meta.url)));
const config = { factory: fixture.factory, implementation: fixture.implementation };
const args = { config, pkSeed: fixture.pkSeed, pkRoot: fixture.pkRoot, sender: accountAddress(config, fixture.pkSeed, fixture.pkRoot),
  recipient: fixture.recipient, nonce: 0n, value: 123n, deployed: false, maxFee: 2000000000n, priorityFee: 1000000000n };

test('predicts immutable account code and binds the complete key', () => {
  assert.equal(accountRuntime(config.implementation, fixture.pkSeed, fixture.pkRoot), fixture.accountCode);
  const otherKey = '0x' + '11'.repeat(16) + '00'.repeat(16);
  assert.notEqual(accountAddress(config, otherKey, fixture.pkRoot), args.sender);
  assert.throws(() => accountRuntime(config.implementation, '0x' + '11'.repeat(32), fixture.pkRoot));
});
test('encodes creation, canonical VERIFY and SENDER frames without a rotation suffix', () => {
  const payload = buildTransfer(args);
  assert.equal(payload[3].length, 3);
  assert.equal(getBytes(payload[3][0][5]).length, 100);
  assert.equal(payload[3][1][5], '0x'); assert.equal(payload[3][2][5], '0x');
  assert.equal(BigInt(payload[3][0][3][0]) + BigInt(payload[3][1][3][0]) + 100n, 495100n);
  assert.equal(BigInt(payload[3][0][3][1]), 450000n);
  assert.equal(frameRpc(payload).nonce, '0x0');
  const raw = encodeFrame(payload); assert.equal(JSON.stringify(decodeFrame(raw)), JSON.stringify(payload).toLowerCase());
});
test('uses an arbitrary witness and the canonical digest, never a secp witness', () => {
  const p = buildTransfer(args), signed = signedFrame(p, '0x' + 'ab'.repeat(6176));
  assert.deepEqual(signed[4][0].slice(0, 3), ['0x', '0x', '0x']);
  assert.equal(signingHash(p), signingHash(signed));
  assert.notEqual(keccak256(encodeFrame(p)), keccak256(encodeFrame(signed)));
  assert.throws(() => signedFrame(p, '0x' + 'ab'.repeat(65)));
});
test('binds recipient, value, nonce and fees to the signature digest', () => {
  const original = signingHash(buildTransfer(args));
  for (const override of [{ recipient: '0x' + '33'.repeat(20) }, { value: 124n }, { nonce: 1n }, { maxFee: 2100000000n }])
    assert.notEqual(signingHash(buildTransfer({ ...args, ...override })), original);
  assert.throws(() => buildTransfer({ ...args, sender: '0x' + '33'.repeat(20) }));
});
test('omits deployment for an existing account and preserves large native nonces', () => {
  const p = buildTransfer({ ...args, deployed: true, nonce: 9007199254740999n });
  assert.equal(p[3].length, 2); assert.equal(BigInt(p[1]), 9007199254740999n);
});
test('does not equate top-level success with successful transfer execution', () => {
  const hash = '0x' + 'ab'.repeat(32);
  const receipt = { transactionHash: hash, type: '0x6', status: '0x1', blockNumber: '0x1', frameReceipts: [{ status: 1 }, { status: 0 }] };
  assert.equal(receiptOutcome(null, hash, 2).status, 'pending');
  assert.equal(receiptOutcome(receipt, hash, 2).status, 'failed');
  receipt.frameReceipts[1].status = '0x1'; assert.equal(receiptOutcome(receipt, hash, 2).status, 'confirmed');
  assert.throws(() => receiptOutcome({ ...receipt, frameReceipts: undefined }, hash, 2));
  assert.throws(() => receiptOutcome({ ...receipt, type: '0x2' }, hash, 2));
  assert.throws(() => receiptOutcome(receipt, '0x' + 'cd'.repeat(32), 2));
});
