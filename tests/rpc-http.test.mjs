import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';
const {encodeRlp,keccak256,concat,toBeHex} = createRequire(new URL('../frontend/package.json',import.meta.url))('ethers');
const account='0x'+'1'.repeat(40);
const signed='0x06'+encodeRlp(['0x0539','0x',account,[['0x02','0x',account,['0x5208','0x'],'0x','0x']],[['0x','0x','0x','0xabcd']],['0x01','0x02','0x'],[]]).slice(2);
async function fixture(t,enabled,aggregationEnabled=false) {
  const calls=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const call=JSON.parse(raw);calls.push(call);
    const result=call.method==='eth_chainId'?'0x539':call.method==='eth_getBlockByNumber'?{hash:DAISUGI_GENESIS}:call.method==='eth_sendRawTransaction'?'0x'+'2'.repeat(64):call.method==='eth_sendProofWrapper'?['0x'+'3'.repeat(64)]:'0x0';
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const rpc='http://127.0.0.1:'+upstream.address().port;
  const child=spawn(process.execPath,['frontend/server.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,
    env:{PATH:process.env.PATH,PORT:String(port),HOST:'127.0.0.1',RPC_URL:rpc,BUNDLER_URL:rpc,FAUCET_RPC_URL:rpc,
      ENTRY_POINT:account,FAUCET_PRIVATE_KEY:'0x'+'0'.repeat(63)+'1',NATIVE_FRAME_RPC_ENABLED:enabled?'true':'false',
      NATIVE_AGGREGATION_RPC_ENABLED:aggregationEnabled?'true':'false'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode==null&&child.signalCode==null){const stopped=once(child,'exit');child.kill();await stopped;}});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Frontend startup failed');})]);
  const url='http://127.0.0.1:'+port;
  return {url,calls,post:async(method,params)=>{
    const response=await fetch(url+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:11,method,params})});
    return {response,body:await response.json()};
  }};
}
test('HTTP RPC accepts wallet requests with omitted params and preserves JSON-RPC identity',async t=>{
  const f=await fixture(t,false);
  for(const method of ['eth_blockNumber','eth_chainId']) {
    const accepted=await f.post(method);
    assert.equal(accepted.response.status,200);
    assert.equal(accepted.body.jsonrpc,'2.0');assert.equal(accepted.body.id,11);
    assert.equal(accepted.body.result,method==='eth_chainId'?'0x539':'0x0');
    assert.deepEqual(f.calls.at(-1),{jsonrpc:'2.0',id:11,method,params:[]});
  }
  const count=f.calls.length;
  assert.equal((await f.post('eth_blockNumber',null)).response.status,400);
  assert.match((await f.post('eth_sendRawTransaction')).body.error.message,/not enabled/);
  assert.equal(f.calls.length,count);
});

test('HTTP RPC advertises explicit activation, serves CORS, preserves data and rejects legacy broadcasts',async t=>{
  const f=await fixture(t,true);
  const options=await fetch(f.url+'/rpc',{method:'OPTIONS'});assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),'*');
  assert.equal((await (await fetch(f.url+'/api/config')).json()).nativeFrameSubmissionEnabled,true);
  const accepted=await f.post('eth_sendRawTransaction',[signed]);assert.equal(accepted.body.result,'0x'+'2'.repeat(64));
  assert.equal(f.calls.filter(c=>c.method==='eth_sendRawTransaction').length,1);
  assert.equal(f.calls.find(c=>c.method==='eth_sendRawTransaction').params[0],signed);
  const denied=await f.post('eth_sendRawTransaction',['0x02abcd']);assert.equal(denied.response.status,400);assert.equal(denied.body.id,11);assert.ok(denied.body.error);
  assert.equal(f.calls.filter(c=>c.method==='eth_sendRawTransaction').length,1);
  const oversized=await f.post('eth_call',[{data:'0x'+'aa'.repeat(70000)},'latest']);assert.equal(oversized.response.status,413);
});
test('HTTP RPC remains read-only for native submissions until explicitly enabled',async t=>{
  const f=await fixture(t,false);
  assert.equal((await f.post('eth_getTransactionCount',[account,'pending'])).body.result,'0x0');
  const denied=await f.post('eth_sendRawTransaction',[signed]);assert.match(denied.body.error.message,/not enabled/);
  assert.ok(!f.calls.some(c=>c.method==='eth_sendRawTransaction'));
  assert.equal((await (await fetch(f.url+'/api/config')).json()).nativeAggregationSubmissionEnabled,false);
  assert.match((await f.post('eth_getProofWrapper',[])).body.error.message,/not enabled/);
});

test('HTTP aggregate submission has its own gate and forwards complete wrappers',async t=>{
  const f=await fixture(t,false,true);
  const witness='0x'+'22'.repeat(6208);
  const dep=concat([toBeHex(16,32),'0x'+'33'.repeat(32),keccak256('0x'+witness.slice(2,66))]);
  const raw='0x06'+encodeRlp(['0x0539',['0x'],'0x',account,[
    ['0x04','0x','0x',['0x0bb8','0x'],'0x',dep],
    ['0x01','0x03','0x',['0x0186a0','0x'],'0x','0x'],
    ['0x02','0x',account,['0x03d090','0x03d090'],'0x','0x'],
  ],[],['0x01','0x02','0x'],[]]).slice(2);
  const wrapper=encodeRlp([[raw],'0x',[dep,[witness]]]);
  assert.equal((await (await fetch(f.url+'/api/config')).json()).nativeAggregationSubmissionEnabled,true);
  const accepted=await f.post('eth_sendProofWrapper',[wrapper]);
  assert.equal(accepted.response.status,200);
  assert.deepEqual(accepted.body.result,['0x'+'3'.repeat(64)]);
  assert.deepEqual(f.calls.find(c=>c.method==='eth_sendProofWrapper').params,[wrapper]);
  assert.match((await f.post('eth_sendRawTransaction',[signed])).body.error.message,/not enabled/);
  assert.equal((await f.post('eth_sendProofWrapper',['0x00'])).response.status,400);
  assert.equal(f.calls.filter(c=>c.method==='eth_sendProofWrapper').length,1);
});
