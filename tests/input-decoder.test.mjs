import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeInputData,accountExecutionInput} from '../frontend/input-decoder.mjs';
import {entryPointInput,addTransactionInput} from '../frontend/transaction-input.mjs';
const target='0x'+'1'.repeat(40),entryPoint='0x'+'2'.repeat(40),hash='0x'+'3'.repeat(64),gas='0x'+'0'.repeat(64);
const encode=(value=0n,data='0x')=>accountExecutionInput.encodeFunctionData('execute',[target,value,data]);
const op={sender:target,nonce:90071992547409930000n,initCode:'0x',callData:encode(),accountGasLimits:gas,preVerificationGas:21000n,gasFees:gas,paymasterAndData:'0x',signature:'0x'+'ab'.repeat(6176)};
test('execute yields named typed arguments and preserves arbitrary integer precision',()=>{
 const value=2n**200n;const result=decodeInputData(encode(value,'0xaabb'));
 assert.equal(result.status,'decoded');assert.equal(result.functionSignature,'execute(address target, uint256 value, bytes data)');
 assert.deepEqual(result.parameters,[{name:'target',type:'address',value:target},{name:'value',type:'uint256',value:value.toString()},{name:'data',type:'bytes',value:'0xaabb'}]);
 assert.equal(result.trailingData,'0x');assert.doesNotThrow(()=>JSON.stringify(result));
});
test('the observed trailing-data pattern is retained outside the ABI arguments',()=>{
 const trailing='de'.repeat(40);const result=decodeInputData(encode()+trailing);
 assert.equal(result.status,'decoded');assert.equal(result.parameters[2].value,'0x');assert.equal(result.trailingData,'0x'+trailing);
});
test('a valid noncanonical offset is reported without falsely labelling bytes as trailing',()=>{
 const canonical=encode();const body=canonical.slice(10);
 const offset='80'.padStart(64,'0');const noncanonical=canonical.slice(0,10)+body.slice(0,128)+offset+'0'.repeat(64)+body.slice(192);
 const result=decodeInputData(noncanonical);assert.equal(result.status,'decoded');assert.equal(result.trailingData,null);assert.match(result.message,/differs from canonical/);
});
test('EntryPoint tuples and arrays keep names, exact nonce and all signature bytes',()=>{
 const input=entryPointInput.encodeFunctionData('handleOps',[[op],target]);
 const result=decodeInputData(input,{abi:entryPointInput,abiSource:'Packed EntryPoint ABI'});
 assert.equal(result.status,'decoded');assert.equal(result.functionName,'handleOps');
 const fields=result.parameters[0].children[0].children;
 assert.equal(fields.find(f=>f.name==='nonce').value,op.nonce.toString());assert.equal(fields.find(f=>f.name==='signature').value,op.signature);assert.equal(fields.find(f=>f.name==='callData').value,op.callData);
});
test('aggregated bundles remain recursively structured',()=>{
 const input=entryPointInput.encodeFunctionData('handleAggregatedOps',[[{userOps:[op],aggregator:target,signature:'0xaabb'}],target]);
 const result=decodeInputData(input,{abi:entryPointInput});assert.equal(result.status,'decoded');
 const group=result.parameters[0].children[0].children;
 assert.equal(group.find(f=>f.name==='userOps').children[0].children.find(f=>f.name==='sender').value,target);
});
test('empty, unknown, malformed and creation data get distinct explicit fallbacks',()=>{
 assert.equal(decodeInputData('0x').status,'empty');assert.equal(decodeInputData(null).status,'unavailable');assert.equal(decodeInputData('0x12345678').status,'unsupported');
 assert.equal(decodeInputData('0xb61d27f6').status,'invalid');assert.equal(decodeInputData(encode(),{creation:true}).status,'unsupported');
});
test('enrichment selects EntryPoint decoding for its destination and account decoding for inner callData',async()=>{
 const input=entryPointInput.encodeFunctionData('handleOps',[[op],target]);
 const provider={getNetwork:async()=>({chainId:1337n}),getTransaction:async()=>({hash,to:entryPoint,data:input})};
 const result=await addTransactionInput({provider,data:{sender:target,nonce:op.nonce.toString(),transactionHash:hash,signature:op.signature},kind:'op',id:'0x'+'4'.repeat(64),entryPoint});
 assert.equal(result.inputDecoded.functionName,'handleOps');assert.equal(result.operationCallDecoded.functionName,'execute');assert.equal(result.signature,op.signature);
});
