import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DAISUGI_GENESIS} from '../explorer/native-frame.mjs';

test('overview serves block data while EntryPoint history is still loading, without fabricated zero counts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'daisugi-startup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let releaseLogs;const gate=new Promise(resolve=>{releaseLogs=resolve;});t.after(releaseLogs);
  const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);let result;
    if(call.method==='eth_chainId')result='0x539';
    else if(call.method==='eth_blockNumber')result='0x2';
    else if(call.method==='eth_getLogs'){await gate;result=[];}
    else if(call.method==='eth_getBlockByNumber')result={number:call.params[0],hash:DAISUGI_GENESIS,parentHash:DAISUGI_GENESIS,
      timestamp:'0x65000000',nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x1c9c380',gasUsed:'0x0',
      miner:'0x'+'1'.repeat(40),extraData:'0x',transactions:[],baseFeePerGas:'0x7'};
    else throw Error(call.method);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,['explorer/server.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,
    env:{PATH:process.env.PATH,HOST:'127.0.0.1',PORT:String(port),RPC_URL:'http://127.0.0.1:'+upstream.address().port,FRAME_INDEX_CACHE:join(directory,'index.json')},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{releaseLogs();if(child.exitCode==null&&child.signalCode==null){const stopped=once(child,'exit');child.kill();await stopped;}});
  await once(child.stdout,'data');
  const origin='http://127.0.0.1:'+port;
  const first=await (await fetch(origin+'/api/overview',{signal:AbortSignal.timeout(3000)})).json();
  assert.equal(first.blocks.length,3);assert.equal(first.operationCount,null);assert.equal(first.walletCount,null);assert.equal(first.entryPointIndex.status,'initializing');
  releaseLogs();
  let complete;
  for(let i=0;i<20;i++){
    complete=await (await fetch(origin+'/api/overview')).json();
    if(complete.operationCount===0)break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(complete.operationCount,0);assert.equal(complete.indexedTo,2);
});
