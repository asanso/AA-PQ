import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFrameIndex} from '../explorer/frame-index.mjs';
import {nativeFrameDetails,DAISUGI_GENESIS} from '../explorer/native-frame.mjs';
import {addTransactionInput} from '../frontend/transaction-input.mjs';
import {nativeAccountProfile} from '../frontend/native-profile.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/native-frame.json',import.meta.url),'utf8'));
test('the included wallet transaction preserves all frames, witnesses, receipts and zero-value self call',()=>{
  const {transaction:tx,receipt} = fixture;
  const result = nativeFrameDetails(tx,receipt);
  assert.equal(result.frames.length,3);
  assert.deepEqual(result.frames.map(f=>f.modeName),['DEFAULT','VERIFY','SENDER']);
  assert.deepEqual(result.frames.map(f=>f.status),['Success','Success','Success']);
  assert.equal(result.frames[2].target,tx.from);
  assert.equal(result.frames[2].valueWei,'0');
  assert.equal(result.frames[2].data,'0x');
  assert.equal((result.witnesses[0].signature.length-2)/2,6176);
  assert.equal(result.witnesses[0].schemeName,'ARBITRARY (account-defined)');
  assert.deepEqual(result.rawTransaction,tx);
  assert.deepEqual(result.rawReceipt,receipt);
});
test('missing, failed and skipped frames never inherit a successful outer status',()=>{
  const {transaction:tx,receipt} = structuredClone(fixture);
  receipt.frameReceipts[1].status = 0; receipt.frameReceipts[2].status = 2;
  assert.deepEqual(nativeFrameDetails(tx,receipt).frames.map(f=>f.status),['Success','Failed','Skipped']);
  delete receipt.frameReceipts;
  assert.equal(nativeFrameDetails(tx,receipt).resultsComplete,false);
  assert.equal(nativeFrameDetails(tx,receipt).frames[0].status,'Unavailable');
  assert.equal(nativeFrameDetails({...tx,blockNumber:null,blockHash:null},null).frames[0].status,'Pending');
  assert.throws(()=>nativeFrameDetails(tx,{...receipt,blockHash:'0xother'}),/does not match/);
});
test('native inputs are decoded per frame and a null outer destination is not contract creation',async()=>{
  const tx = fixture.transaction;
  const data = {hash:tx.hash,nativeFrame:nativeFrameDetails(tx,fixture.receipt)};
  const result = await addTransactionInput({provider:{getNetwork:async()=>({chainId:1337n}),getTransaction:async()=>({...tx,data:tx.input})},data,kind:'tx',id:tx.hash});
  assert.equal(result.inputIsContractCreation,false);
  assert.equal(result.nativeFrame.frames[0].inputDecoded.functionName,'createAccount');
  assert.equal(result.nativeFrame.frames[0].inputDecoded.parameters[0].name,'pkSeed');
  assert.equal(result.nativeFrame.frames[2].inputDecoded.status,'empty');
  assert.equal(result.nativeFrame.witnesses[0].signature,tx.signatures[0].signature);
});
test('signature length or an unrecognized sender cannot establish the SPHINCS-G account profile',async()=>{
  const provider={getBlock:async()=>({hash:DAISUGI_GENESIS}),getCode:async()=>'0x6000'};
  assert.equal(await nativeAccountProfile(provider,fixture.transaction),null);
  assert.equal(await nativeAccountProfile({getBlock:async()=>{throw Error('Unavailable');},getCode:async()=>'0x'},fixture.transaction),null);
});

const hex = n=>'0x'+n.toString(16);
const blockHash = n=>'0x'+n.toString(16).padStart(64,'0');
function chainFixture() {
  let head = 49, generation = 0, fork = Infinity, unavailable = null;
  const getHash = n=>blockHash(n+1+(n>=fork?generation*1000:0));
  function block(n) {
    const tx = {...fixture.transaction,blockNumber:hex(n),blockHash:getHash(n),hash:blockHash(100000+n+generation*1000),transactionIndex:'0x0'};
    return {number:hex(n),hash:getHash(n),parentHash:getHash(n-1),timestamp:hex(1700000000+n),transactions:n%10===0?[tx]:[]};
  }
  let active=0,maximum=0;
  async function rpc(method,params) {
    if (method==='eth_chainId') return '0x539';
    if (method==='eth_blockNumber') return hex(head);
    if (method==='eth_getBlockByNumber') {
      const n=Number(params[0]);
      if (n===0 && !params[1]) return {hash:DAISUGI_GENESIS};
      active++; maximum=Math.max(maximum,active);
      await new Promise(resolve=>setTimeout(resolve,1));active--;
      if(n===unavailable)throw Error('Mock missing block');
      return block(n);
    }
    if (method==='eth_getTransactionReceipt') {
      const n=Number(BigInt(params[0]))-100000-generation*1000;
      return {...fixture.receipt,transactionHash:params[0],blockHash:getHash(n),blockNumber:hex(n)};
    }
    throw Error('Unexpected RPC method');
  }
  return {rpc,setHead:n=>{head=n;},reorg:n=>{generation++;fork=n;},unavailable:n=>{unavailable=n;},maximum:()=>maximum};
}
test('background index backfills contiguous coverage, separates native transactions, and deduplicates updates',async()=>{
  const chain=chainFixture(),index=createFrameIndex({rpc:chain.rpc,startBlock:1,batchSize:16});
  assert.equal(index.snapshot().count,null);
  await index.update();assert.equal(index.snapshot().status,'indexing');assert.equal(index.snapshot().indexedFrom,18);
  await index.update();await index.update();assert.equal(index.snapshot().status,'complete');assert.equal(index.snapshot().count,4);
  await index.update();assert.equal(index.snapshot().count,4);assert.ok(chain.maximum()<=4);
  chain.setHead(51);await index.update();assert.equal(index.snapshot().count,5);assert.equal(index.snapshot().indexedTo,51);
  assert.equal(index.snapshot(fixture.transaction.from).transactions.length,5);
  assert.equal(index.snapshot('0x'+'9'.repeat(40)).transactions.length,0);
});
test('missing ranges remain partial and shallow or deep reorgs remove orphaned transaction hashes',async()=>{
  const chain=chainFixture(),index=createFrameIndex({rpc:chain.rpc,startBlock:1,batchSize:16});
  await index.update();const old=index.snapshot().transactions.find(tx=>tx.blockNumber===40).hash;
  chain.reorg(40);await index.update();assert.ok(!index.snapshot().transactions.some(tx=>tx.hash===old));
  chain.unavailable(1);await index.update();assert.equal(index.snapshot().status,'degraded');assert.ok(index.snapshot().indexedFrom>1);
  chain.unavailable(null);await index.update();assert.equal(index.snapshot().status,'complete');
  const hashes=new Set(index.snapshot().transactions.map(tx=>tx.hash));chain.reorg(10);
  await index.update();assert.equal(index.snapshot().status,'indexing');assert.ok(index.snapshot().transactions.every(tx=>!hashes.has(tx.hash)));
});
test('persisted coverage resumes, while the wrong genesis cannot expose cached counts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'daisugi-frame-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cacheFile=join(directory,'index.json'),chain=chainFixture();
  const first=createFrameIndex({rpc:chain.rpc,startBlock:1,batchSize:16,cacheFile});
  for(let i=0;i<3;i++)await first.update();await first.flush();
  const second=createFrameIndex({rpc:chain.rpc,startBlock:1,batchSize:16,cacheFile});await second.update();assert.equal(second.snapshot().status,'complete');assert.equal(second.snapshot().count,4);
  const wrong=createFrameIndex({rpc:chain.rpc,startBlock:1,cacheFile,genesisHash:blockHash(999)});await wrong.update();assert.equal(wrong.snapshot().status,'unavailable');assert.equal(wrong.snapshot().count,null);
});
