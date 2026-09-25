import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createRpcProxy,validateRpcRequest,validateFrameEnvelope} from '../frontend/rpc-policy.mjs';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';
const {encodeRlp} = createRequire(new URL('../frontend/package.json',import.meta.url))('ethers');
const address='0x'+'1'.repeat(40);
const payload = () => ['0x0539','0x',address,[['0x02','0x',address,['0x0100','0x'],'0x','0x']],[['0x','0x','0x','0x1234']],['0x01','0x02','0x'],[]];
const raw = p=>'0x06'+encodeRlp(p).slice(2);
const request=(method,params=[])=>({jsonrpc:'2.0',id:7,method,params});
test('native submission is explicitly gated while wallet reads remain available',()=>{
  for(const method of ['eth_getTransactionCount','eth_gasPrice','eth_estimateGas','eth_call','eth_getBlockByNumber'])validateRpcRequest(request(method));
  assert.throws(()=>validateRpcRequest(request('eth_sendRawTransaction',[raw(payload())])),/not enabled/);
  validateRpcRequest(request('eth_sendRawTransaction',[raw(payload())]),{nativeFramesEnabled:true});
});
test('the gateway rejects administrative methods, signing, overrides, batches and invalid envelopes',()=>{
  for(const method of ['debug_traceTransaction','admin_peers','eth_sendTransaction','personal_sign','eth_sign'])assert.throws(()=>validateRpcRequest(request(method)),/not enabled/);
  assert.throws(()=>validateRpcRequest([request('eth_chainId')]),/single/);
  assert.throws(()=>validateRpcRequest(request('eth_call',[{},'latest',{}])),/overrides/);
  for(const data of ['0x02abcd','0x06','0x06c0','0x06'+'a'.repeat(140000)])assert.throws(()=>validateFrameEnvelope(data));
  const wrong=payload();wrong[0]='0x01';assert.throws(()=>validateFrameEnvelope(raw(wrong)),/chain ID/);
  const malformed=payload();malformed[3][0][3]='0x';assert.throws(()=>validateFrameEnvelope(raw(malformed)),/frame fields/);
});
test('only the exact verified envelope is forwarded, after checking chain identity',async()=>{
  const calls=[];
  const proxy=createRpcProxy({url:'http://mock',nativeFramesEnabled:true,fetchImpl:async(url,options)=>{
    const call=JSON.parse(options.body);calls.push(call);
    return {ok:true,json:async()=>({jsonrpc:'2.0',id:call.id,result:call.method==='eth_chainId'?'0x539':call.method==='eth_getBlockByNumber'?{hash:DAISUGI_GENESIS}:'0xaccepted'})};
  }});
  const submitted=request('eth_sendRawTransaction',[raw(payload())]);await proxy(submitted);
  assert.deepEqual(calls.at(-1),submitted);assert.equal(calls.length,3);
  assert.equal((await proxy(request('eth_getTransactionCount',[address,'pending']))).result,'0xaccepted');
});
test('wrong chain identity blocks forwarding before any transaction submission',async()=>{
  const methods=[];
  const proxy=createRpcProxy({url:'http://mock',nativeFramesEnabled:true,fetchImpl:async(url,options)=>{
    const call=JSON.parse(options.body);methods.push(call.method);return {ok:true,json:async()=>({result:call.method==='eth_chainId'?'0x1':{hash:DAISUGI_GENESIS}})};
  }});
  await assert.rejects(proxy(request('eth_sendRawTransaction',[raw(payload())])),/genesis/);
  assert.ok(!methods.includes('eth_sendRawTransaction'));
});
