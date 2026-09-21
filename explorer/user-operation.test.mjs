import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bundleInterface, operationSignature} from './user-operation.mjs';

const entryPoint = '0x433709009B8330FDa32311DF1C2AFA402eD8D009';
const sender = '0x0000000000000000000000000000000000000001';
const zero = '0x' + '00'.repeat(32);
const op = (nonce, signature) => [sender, nonce, '0x', '0x', zero, 0, zero, '0x', signature];
test('selects exact signature by sender and nonce, without truncating', () => {
  const signature = '0x' + 'abcd'.repeat(3000);
  const data = bundleInterface.encodeFunctionData('handleOps', [[op(1,'0x1234'),op(2,signature)],sender]);
  assert.equal(operationSignature({to:entryPoint,data},{sender,nonce:2},entryPoint),signature);
  assert.equal(operationSignature({to:entryPoint,data},{sender,nonce:3},entryPoint),null);
  assert.equal(operationSignature({to:sender,data},{sender,nonce:2},entryPoint),null);
});
test('aggregated bundle returns individual signature, not aggregate signature', () => {
  const data = bundleInterface.encodeFunctionData('handleAggregatedOps', [[[[op(1,'0x1234')],sender,'0xabcd']],sender]);
  assert.equal(operationSignature({to:entryPoint,data},{sender,nonce:1},entryPoint),'0x1234');
});
test('unsupported, malformed and ambiguous calldata fail explicitly', () => {
  for (const data of ['0x', '0xdeadbeef', bundleInterface.encodeFunctionData('handleOps',[[op(1,'0x'),op(1,'0xab')],sender])]) {
    assert.equal(operationSignature({to:entryPoint,data},{sender,nonce:1},entryPoint),null);
  }
});
