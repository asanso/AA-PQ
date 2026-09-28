import test from 'node:test';
import assert from 'node:assert/strict';
import {transactionMetrics,summarizeCallTrace,createTransactionDetails} from '../frontend/transaction-details.mjs';
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40),H='0x'+'4'.repeat(64),BH='0x'+'5'.repeat(64);
const tx={hash:H,from:A,to:B,value:0n,type:2,nonce:2n**100n,chainId:1337n,blockNumber:10,blockHash:BH,gasLimit:30000n,maxFeePerGas:20n,maxPriorityFeePerGas:10n};
const receipt={hash:H,blockNumber:10,blockHash:BH,index:0,status:1,gasUsed:21000n,gasPrice:12n,contractAddress:null};
const block={hash:BH,timestamp:1700000000,baseFeePerGas:7n};
const frame=(from,to,value,calls=[],type='CALL',error)=>({type,from,to,value,calls,error});
const provider={getTransactionReceipt:async()=>receipt,getBlockNumber:async()=>20,getBlock:async()=>block};
test('actual fees, burned fees and cap savings use receipt gas and integer wei',()=>{
 const d=transactionMetrics(tx,receipt,block,20);
 assert.equal(d.transactionFeeWei,'252000');assert.equal(d.burntExecutionFeeWei,'147000');assert.equal(d.feeSavingWei,'168000');assert.equal(d.gasUsedPercent,'70.00');
 assert.equal(d.confirmations,11);assert.equal(d.transactionIndex,0);assert.equal(d.nonce,(2n**100n).toString());assert.doesNotThrow(()=>JSON.stringify(d));
});
test('legacy, pending and missing fee data do not become fabricated zero values',()=>{
 const legacy=transactionMetrics({...tx,type:0,maxFeePerGas:null,maxPriorityFeePerGas:null},receipt,{timestamp:1,baseFeePerGas:null},20);
 assert.equal(legacy.maxFeePerGasWei,null);assert.equal(legacy.feeSavingWei,null);assert.equal(legacy.burntExecutionFeeWei,null);
 const pending=transactionMetrics({...tx,blockNumber:null,blockHash:null},null,null,20);
 assert.equal(pending.status,'Pending');assert.equal(pending.transactionFeeWei,null);assert.equal(pending.effectiveGasPriceWei,null);assert.equal(pending.confirmations,null);
 const missing=transactionMetrics(tx,{...receipt,gasPrice:null},block,null);assert.equal(missing.transactionFeeWei,null);assert.equal(missing.confirmations,null);
});
test('blob transaction totals include blob fee, or remain unknown when that component is missing',()=>{
 const d=transactionMetrics({...tx,type:3},{...receipt,blobGasUsed:100n,blobGasPrice:2n},block,20);
 assert.equal(d.executionFeeWei,'252000');assert.equal(d.blobFeeWei,'200');assert.equal(d.transactionFeeWei,'252200');
 assert.equal(transactionMetrics({...tx,type:3},receipt,block,20).transactionFeeWei,null);
 assert.equal(transactionMetrics({...tx,type:6,blobVersionedHashes:[H]},receipt,block,20).transactionFeeWei,null);
});
test('receipt status and root contract creation are independent of execution value',()=>{
 const d=transactionMetrics({...tx,to:null},{...receipt,status:0,contractAddress:null},block,20);assert.equal(d.status,'Failed');assert.equal(d.valueWei,'0');
 assert.equal(transactionMetrics({...tx,to:null},{...receipt,contractAddress:C},block,20).contractAddress,C);
});
test('call trace excludes root value, delegate values, reverted frames and reverted descendants',()=>{
 const root=frame(A,B,'0x64',[
  frame(B,C,'0xa'),frame(B,A,'0x99',[],'DELEGATECALL'),frame(B,A,'0x7',[frame(A,C,'0x3')],'CALL','reverted'),frame(C,A,'0x4')
 ]);
 const result=summarizeCallTrace(root);assert.deepEqual(result.transfers.map(t=>t.valueWei),['10','4']);
 assert.deepEqual(result.netTransfers,[{address:B,valueWei:'-10'},{address:C,valueWei:'6'},{address:A,valueWei:'4'}]);
 assert.equal(summarizeCallTrace({...root,error:'root reverted'}).transfers.length,0);
});
test('successful internal creates and selfdestruct movements are reported, with self transfers netting to zero',()=>{
 const result=summarizeCallTrace(frame(A,B,'0x0',[frame(B,C,'0x8',[],'CREATE2'),frame(C,B,'0x2',[],'SELFDESTRUCT'),frame(B,B,'0x1')]));
 assert.equal(result.createdContracts[0].address,C);assert.equal(result.transfers.length,3);assert.deepEqual(result.netTransfers,[{address:B,valueWei:'-6'},{address:C,valueWei:'6'}]);
 assert.throws(()=>summarizeCallTrace({}),/Invalid/);
});
test('historical state failure preserves real receipt/block data and reports trace unavailable',async()=>{
 const read=createTransactionDetails({provider,rpcUrl:'http://rpc.local',fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);assert.equal(body.method,'debug_traceTransaction');assert.equal(body.params[1].reexec,0);assert.equal(body.params[1].tracer,'callTracer');
  return {ok:true,json:async()=>({error:{message:'historical state is not available'}})};
 }});
 const data=await read(tx);assert.equal(data.transactionFeeWei,'252000');assert.equal(data.timestamp,1700000000);assert.equal(data.internalTransfers.status,'unavailable');assert.match(data.internalTransfers.message,/historical state/);
});
test('trace reads coalesce and cache while confirmations refresh independently',async()=>{
 let calls=0,head=20;const read=createTransactionDetails({provider:{...provider,getBlockNumber:async()=>head},rpcUrl:'http://rpc.local',fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({result:frame(A,B,'0x0')})};}});
 const first=await Promise.all([read(tx),read(tx)]);assert.equal(calls,1);assert.equal(first[0].confirmations,11);head=25;
 assert.equal((await read(tx)).confirmations,16);assert.equal(calls,1);
});
test('failed receipt/block reads leave values unavailable instead of clearing the record',async()=>{
 const read=createTransactionDetails({provider:{getTransactionReceipt:async()=>{throw new Error('offline');},getBlock:async()=>{throw new Error('offline');},getBlockNumber:async()=>{throw new Error('offline');}}});
 const d=await read(tx);assert.equal(d.hash,H);assert.equal(d.transactionFeeWei,null);assert.equal(d.timestamp,null);assert.equal(d.errors.length,3);assert.equal(d.internalTransfers.status,'unavailable');
});

test('a failed receipt prevents committed transfers even if a trace omits its root error',async()=>{
 const read=createTransactionDetails({provider:{...provider,getTransactionReceipt:async()=>({...receipt,status:0})},rpcUrl:'http://rpc.local',fetchImpl:async()=>({ok:true,json:async()=>({result:frame(A,B,'0x0',[frame(B,C,'0xa')])})})});
 const result=await read(tx);assert.equal(result.status,'Failed');assert.equal(result.internalTransfers.transfers.length,0);
});
