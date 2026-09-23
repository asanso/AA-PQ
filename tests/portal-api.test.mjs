import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortalApi,createFaucetLimiter} from '../frontend/portal-api.mjs';

function fixture(options={}) {
  let calls=0, time=1700000010000;
  const provider={async getNetwork(){calls++;return {chainId:options.chain ?? 1337n};},async getBlock(){return options.noBlock ? null : {number:42,timestamp:1700000000,baseFeePerGas:1000000001n};}};
  const fetchImpl=options.fetchImpl || (async()=>({ok:true,json:async()=>({result:'0x539'})}));
  const portal=createPortalApi({provider,bundlerUrl:'http://127.0.0.1:4337',explorerUrl:'http://127.0.0.1:3001',fetchImpl,now:()=>time});
  return {portal,setTime:value=>{time=value;},calls:()=>calls};
}
test('network reports real chain, exact fee, fresh block and bundler',async()=>{
  const {portal}=fixture(); const result=await portal.network();
  assert.equal(result.chainId,1337);assert.equal(result.status,'operational');assert.equal(result.baseFeePerGas,'1000000001');assert.equal(result.blockNumber,42);
});
test('concurrent checks are coalesced and cached only for five seconds',async()=>{
  const f=fixture();await Promise.all([f.portal.network(),f.portal.network()]);assert.equal(f.calls(),1);
  await f.portal.network();assert.equal(f.calls(),1);f.setTime(1700000016000);await f.portal.network();assert.equal(f.calls(),2);
});
test('a responding RPC with an old block is delayed',async()=>{
  const f=fixture();f.setTime(1700000060000);assert.equal((await f.portal.network()).status,'delayed');
});
test('wrong-chain RPC and missing blocks fail without invented values',async()=>{
  await assert.rejects(fixture({chain:11155111n}).portal.network(),/not connected to Daisugi/);
  await assert.rejects(fixture({noBlock:true}).portal.network(),/unavailable/);
});
test('failed, malformed and wrong-chain bundlers report degraded',async()=>{
  for(const fetchImpl of [async()=>{throw new Error('offline');},async()=>({ok:true,json:async()=>({result:'garbage'})}),async()=>({ok:true,json:async()=>({result:'0xaa36a7'})})]){
    const result=await fixture({fetchImpl}).portal.network();assert.equal(result.bundler,'unavailable');assert.equal(result.status,'degraded');
  }
});
test('read proxy pins its origin and rejects traversal and malformed identifiers',async()=>{
  const calls=[];const {portal}=fixture({fetchImpl:async(url)=>{calls.push(String(url));return {ok:true,json:async()=>({chainId:1337})};}});
  await portal.explorer('overview');await portal.explorer('address/0x'+'1'.repeat(40));
  assert.deepEqual(calls,['http://127.0.0.1:3001/api/overview','http://127.0.0.1:3001/api/address/0x'+'1'.repeat(40)]);
  for(const path of ['../config','http://example.com','block/1?x=y','tx/0x123','address/../../secret','overview/extra']) await assert.rejects(portal.explorer(path),/Invalid/);
  assert.equal(calls.length,2);
});
test('read proxy does not hide missing records or accept another network overview',async()=>{
  await assert.rejects(fixture({fetchImpl:async()=>({ok:false,json:async()=>({error:'Block not found'})})}).portal.explorer('block/999'),/Block not found/);
  await assert.rejects(fixture({fetchImpl:async()=>({ok:true,json:async()=>({chainId:1})})}).portal.explorer('overview'),/not connected to Daisugi/);
});
test('cooldown is case insensitive, reserves pending requests and expires',()=>{
  let now=100000;const claim=createFaucetLimiter({now:()=>now});
  assert.equal(claim('0xABC'),0);assert.equal(claim('0xabc'),60);now+=10100;assert.equal(claim('0xAbC'),50);
  now+=49900;assert.equal(claim('0xabc'),0);
});
test('cooldown storage remains bounded, without evicting an active reservation',()=>{
  let now=0;const claim=createFaucetLimiter({now:()=>now,maximum:2});
  assert.equal(claim('a'),0);assert.equal(claim('b'),0);assert.equal(claim('c'),60);assert.equal(claim('a'),60);
  now=60000;assert.equal(claim('c'),0);
});
