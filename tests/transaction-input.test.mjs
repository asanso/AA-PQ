import test from 'node:test';
import assert from 'node:assert/strict';
import {entryPointInput,operationCallData,addTransactionInput} from '../frontend/transaction-input.mjs';

const sender='0x'+'1'.repeat(40),other='0x'+'2'.repeat(40),entryPoint='0x'+'3'.repeat(40),hash='0x'+'4'.repeat(64);
const gas='0x'+'0'.repeat(64);
const operation=(values={})=>({sender,nonce:7n,initCode:'0x1234',callData:'0xb61d27f6'+'ab'.repeat(120),accountGasLimits:gas,preVerificationGas:21000n,gasFees:gas,paymasterAndData:'0x',signature:'0x'+'cd'.repeat(2420),...values});
const bundle=ops=>({hash,to:entryPoint,data:entryPointInput.encodeFunctionData('handleOps',[ops,other])});
const fixture=(tx,chain=1337n)=>({getNetwork:async()=>({chainId:chain}),getTransaction:async value=>{assert.equal(value,hash);return tx;}});
const enrich=(tx,values={})=>addTransactionInput({provider:fixture(tx),data:{hash,status:'Confirmed',signature:'0xaabb'},kind:'tx',id:hash,entryPoint,...values});

test('the requested operation is extracted from a multi-operation bundle without truncation',()=>{
 const op=operation();const tx=bundle([operation({sender:other,callData:'0xdeadbeef'}),op]);
 assert.equal(operationCallData(tx,{sender,nonce:'7'},entryPoint),op.callData);
 assert.ok(tx.data.includes(op.signature.slice(2)));
});
test('aggregated operations retain their individual callData',()=>{
 const op=operation({callData:'0x'+'ef'.repeat(8000)});
 const tx={to:entryPoint,data:entryPointInput.encodeFunctionData('handleAggregatedOps',[[{userOps:[operation({sender:other}),op],aggregator:other,signature:'0xabcdef'}],other])};
 assert.equal(operationCallData(tx,{sender,nonce:7},entryPoint),op.callData);
});
test('empty operation callData remains available as 0x',()=>{
 assert.equal(operationCallData(bundle([operation({callData:'0x'})]),{sender,nonce:7},entryPoint),'0x');
});
test('wrong EntryPoint, unsupported or malformed encoding, missing or ambiguous operations are not guessed',()=>{
 const op=operation(),match={sender,nonce:7};
 for(const tx of [bundle([op,op]),bundle([operation({sender:other})]),{...bundle([op]),to:other},{to:entryPoint,data:'0x12345678'},{to:entryPoint,data:'0xdeadbeef00'}]) assert.equal(operationCallData(tx,match,entryPoint),null);
 assert.equal(operationCallData(bundle([op]),match,''),null);
});
test('full transaction input survives enrichment byte for byte',async()=>{
 const tx=bundle([operation(),operation({sender:other})]);const result=await enrich(tx);
 assert.equal(result.inputData,tx.data);assert.equal(result.inputDataError,null);assert.equal(result.status,'Confirmed');assert.equal(result.signature,'0xaabb');
});
test('operation response includes inner callData, enclosing input and unchanged signature',async()=>{
 const op=operation();const tx=bundle([op]);const result=await enrich(tx,{kind:'op',data:{sender,nonce:'7',transactionHash:hash,signature:op.signature}});
 assert.equal(result.operationCallData,op.callData);assert.equal(result.inputData,tx.data);assert.equal(result.signature,op.signature);
});
test('unsupported operation decoding preserves full raw input and signature',async()=>{
 const result=await enrich({hash,to:entryPoint,data:'0x12345678'},{kind:'op',data:{sender,nonce:'7',transactionHash:hash,signature:'0xaabb'}});
 assert.equal(result.operationCallData,null);assert.equal(result.inputData,'0x12345678');assert.equal(result.signature,'0xaabb');
});
test('empty transaction input and contract creation are represented accurately',async()=>{
 assert.equal((await enrich({hash,to:sender,data:'0x'})).inputData,'0x');
 const creation=await enrich({hash,to:null,data:'0x60016000'});assert.equal(creation.inputIsContractCreation,true);assert.equal(creation.inputData,'0x60016000');
});
test('failed or wrong-chain reads preserve indexed details and do not invent empty data',async()=>{
 const tx=bundle([operation()]);
 for(const provider of [fixture(tx,11155111n),fixture(null),fixture({...tx,hash:'0x'+'9'.repeat(64)}),fixture({...tx,data:'0x123'}),{getNetwork:async()=>{throw new Error('RPC offline');},getTransaction:async()=>tx}]){
  const result=await enrich(tx,{provider});assert.equal(result.inputData,null);assert.ok(result.inputDataError);assert.equal(result.signature,'0xaabb');assert.equal(result.status,'Confirmed');
 }
});

test('optional transaction-detail failures preserve verified input, decoding and signature', async () => {
  const op = operation();
  const tx = bundle([op]);
  const result = await enrich(tx, {
    kind: 'op',
    data: {sender, nonce: '7', transactionHash: hash, signature: op.signature},
    loadTransactionDetails: async () => { throw new Error('Receipt enrichment failed'); }
  });
  assert.equal(result.inputData, tx.data);
  assert.equal(result.inputDataError, null);
  assert.equal(result.inputDecoded.status, 'decoded');
  assert.equal(result.operationCallData, op.callData);
  assert.equal(result.signature, op.signature);
  assert.equal(result.transactionDetails, undefined);
});
