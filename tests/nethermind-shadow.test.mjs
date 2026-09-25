import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionPayload} from '../scripts/nethermind-shadow.mjs';
const block=()=>({requestsHash:'0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  withdrawals:[],blobGasUsed:'0x0',excessBlobGas:'0x0',parentBeaconBlockRoot:'0x1234',
  transactions:[{hash:'0x1234'}],hash:'0xabcd',miner:'0x0012',mixHash:'0x4321',number:'0x1'});
test('maps Prague block fields without fabricating transaction bytes',()=>{
  const b=block(),before=structuredClone(b),payload=executionPayload(b,['0x02c0']);
  assert.equal(payload.blockHash,b.hash);assert.equal(payload.feeRecipient,b.miner);
  assert.equal(payload.prevRandao,b.mixHash);assert.deepEqual(payload.transactions,['0x02c0']);
  assert.deepEqual(b,before);
});
test('fails closed on nonempty requests, missing fork fields or transaction bytes',()=>{
  assert.throws(()=>executionPayload({...block(),requestsHash:'0x1234'},['0x02c0']),/execution requests/);
  assert.throws(()=>executionPayload({...block(),withdrawals:undefined},['0x02c0']),/Prague/);
  assert.throws(()=>executionPayload(block(),[]),/transaction bytes/);
});
