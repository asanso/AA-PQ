import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {Interface} from 'ethers';
import {accountAddress,buildTransfer,signingHash} from '../src/native-frame/protocol.js';
import {directTransfers} from '../src/native-frame/transfers.js';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-frame.json',import.meta.url)));
const config={factory:fixture.factory,implementation:fixture.implementation};
const args={config,pkSeed:fixture.pkSeed,pkRoot:fixture.pkRoot,sender:accountAddress(config,fixture.pkSeed,fixture.pkRoot),
  recipient:fixture.recipient,nonce:2n,value:0n,deployed:true,maxFee:2000000000n,priorityFee:1000000000n};

test('preserves arbitrary contract calldata and binds it to the signature',()=>{
  const abi=new Interface(['function transfer(address,uint256) returns(bool)']);
  const data=abi.encodeFunctionData('transfer',[fixture.recipient,1000n]);
  const payload=buildTransfer({...args,data});
  assert.equal(payload[3].at(-1)[5],data);
  assert.equal(payload[3].at(-1)[4],'0x');
  assert.notEqual(signingHash(payload),signingHash(buildTransfer({...args,data:data+'00'})));
  assert.throws(()=>buildTransfer({...args,data:'0x1'}));
  assert.throws(()=>buildTransfer({...args,value:-1n}));
});

test('includes successful direct SENDER transfers and excludes failed or unproven frames',()=>{
  const tx={type:'0x6',hash:'0x'+'11'.repeat(32),from:args.sender,
    frames:[{mode:1,target:args.sender,value:'0x0'},{mode:2,target:args.recipient,value:'0x123'}]};
  const receipt={status:'0x1',frameReceipts:[{status:1},{status:1}]};
  assert.equal(directTransfers(tx,receipt)[0].to,args.recipient);
  assert.equal(directTransfers(tx,receipt)[0].value,'0x123');
  assert.deepEqual(directTransfers(tx,{...receipt,frameReceipts:[{status:1},{status:0}]}),[]);
  assert.deepEqual(directTransfers(tx,{status:'0x1'}),[]);
  assert.deepEqual(directTransfers(tx,{...receipt,status:'0x0'}),[]);
  assert.deepEqual(directTransfers(tx,null),[]);
});
