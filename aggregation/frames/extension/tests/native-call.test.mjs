import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import * as e from 'ethers';
import {createNativeProtocol} from '../src/native-frame/native-protocol.mjs';
import {directTransfers} from '../src/native-frame/transfers.js';
import {receiptOutcome} from '../src/native-frame/receipt.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-lean-sphincs.json',import.meta.url)));
const p=createNativeProtocol(e);
const args={config:fixture.config,publicKey:fixture.publicKey,recipient:fixture.recipient,nonce:2n,value:0n,deployed:true,
  maxFee:2000000000n,priorityFee:1000000000n};
const sender=p.accountAddress(fixture.config,fixture.publicKey);

test('preserves arbitrary contract calldata and binds it to the signature',()=>{
  const abi=new e.Interface(['function transfer(address,uint256) returns(bool)']);
  const data=abi.encodeFunctionData('transfer',[fixture.recipient,1000n]);
  const {payload,digest}=p.prepare({...args,data});
  assert.equal(payload[4].at(-1)[5],data);
  assert.equal(payload[4].at(-1)[4],'0x');
  assert.notEqual(digest,p.prepare({...args,data:data+'00'}).digest);
  assert.throws(()=>p.prepare({...args,data:'0x1'}));
  assert.throws(()=>p.prepare({...args,value:-1n}));
});

test('includes successful direct SENDER transfers and excludes failed or unproven frames',()=>{
  const tx={type:'0x6',hash:'0x'+'11'.repeat(32),from:sender,
    frames:[{mode:1,target:sender,value:'0x0'},{mode:2,target:args.recipient,value:'0x123'}]};
  const receipt={status:'0x1',frameReceipts:[{status:1},{status:1}]};
  assert.equal(directTransfers(tx,receipt)[0].to,args.recipient);
  assert.equal(directTransfers(tx,receipt)[0].value,'0x123');
  assert.deepEqual(directTransfers(tx,{...receipt,frameReceipts:[{status:1},{status:0}]}),[]);
  assert.deepEqual(directTransfers(tx,{status:'0x1'}),[]);
  assert.deepEqual(directTransfers(tx,{...receipt,status:'0x0'}),[]);
  assert.deepEqual(directTransfers(tx,null),[]);
});

test('does not equate top-level success with successful transfer execution',()=>{
  const hash=fixture.transactions[1].hash;
  const receipt={transactionHash:hash,type:'0x6',status:'0x1',blockNumber:'0x10',frameReceipts:[{status:'0x1'},{status:'0x0'}]};
  assert.equal(receiptOutcome(null,hash,2).status,'pending');
  assert.equal(receiptOutcome(receipt,hash,2).status,'failed');
  assert.equal(receiptOutcome({...receipt,frameReceipts:[{status:'0x1'},{status:'0x1'}]},hash,2).status,'confirmed');
  assert.throws(()=>receiptOutcome({...receipt,frameReceipts:[{status:'0x1'}]},hash,2),/unavailable/);
  assert.throws(()=>receiptOutcome({...receipt,transactionHash:'0x'+'22'.repeat(32)},hash,2),/does not match/);
});
