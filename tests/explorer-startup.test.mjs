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
import {Interface,ZeroHash,ZeroAddress} from '../frontend/node_modules/ethers/lib.esm/index.js';

test('overview counts unique deployed accounts, preserves startup and failed-index states, and reconciles replaced logs',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'daisugi-startup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let releaseLogs;const gate=new Promise(resolve=>{releaseLogs=resolve;});t.after(releaseLogs);
  const entryPoint='0x433709009B8330FDa32311DF1C2AFA402eD8D009',factory='0xd07fcbdca6dea83b523faf95386cea236e32d989';
  const firstAccount='0x'+'1'.repeat(40),secondAccount='0x'+'2'.repeat(40);
  const abi=new Interface([
    'event AccountDeployed(bytes32 indexed userOpHash,address indexed sender,address factory,address paymaster)',
    'event AccountCreated(address indexed account,bytes32 indexed salt,bytes32 pkSeed,bytes32 pkRoot)',
  ]);
  function log(name,address,account,index){
    const encoded=abi.encodeEventLog(abi.getEvent(name),name==='AccountDeployed'?[ZeroHash,account,factory,ZeroAddress]:[account,ZeroHash,ZeroHash,ZeroHash]);
    return {...encoded,address,blockHash:DAISUGI_GENESIS,blockNumber:'0x2',transactionHash:ZeroHash,transactionIndex:'0x0',logIndex:'0x'+index.toString(16),removed:false};
  }
  let logs=[],logsFail=false;
  const upstream=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);let result;
    if(call.method==='eth_chainId')result='0x539';
    else if(call.method==='eth_blockNumber')result='0x2';
    else if(call.method==='eth_getLogs'){
      await gate;
      assert.deepEqual(call.params[0].address.map(a=>a.toLowerCase()).sort(),[entryPoint,factory].map(a=>a.toLowerCase()).sort());
      if(logsFail){res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32000,message:'Log history unavailable'}}));return;}
      result=logs;
    }
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
  assert.equal(first.smartAccountCount,null);assert.equal(first.nativeWalletCount,null);
  releaseLogs();
  async function waitFor(predicate){
    for(let i=0;i<100;i++){
      const record=await (await fetch(origin+'/api/overview')).json();
      if(predicate(record))return record;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail('Expected account index state was not observed');
  }
  const complete=await waitFor(record=>record.operationCount===0);
  assert.equal(complete.operationCount,0);assert.equal(complete.indexedTo,2);
  assert.equal(complete.smartAccountCount,0);assert.equal(complete.nativeWalletCount,0);
  logs=[log('AccountDeployed',entryPoint,firstAccount,0),log('AccountCreated',factory,firstAccount,1),
    log('AccountCreated',factory,secondAccount,2),log('AccountCreated',factory,secondAccount,3),
    log('AccountCreated',entryPoint,'0x'+'3'.repeat(40),4),log('AccountDeployed',factory,'0x'+'4'.repeat(40),5)];
  const combined=await waitFor(record=>record.smartAccountCount===2);
  assert.equal(combined.walletCount,1);assert.equal(combined.nativeWalletCount,2);assert.equal(combined.operationCount,0);
  logs=[logs[0]];
  const replaced=await waitFor(record=>record.smartAccountCount===1);
  assert.equal(replaced.nativeWalletCount,0);
  logsFail=true;
  const failed=await waitFor(record=>record.entryPointIndex.status==='degraded');
  assert.equal(failed.smartAccountCount,1);assert.match(failed.entryPointIndex.message,/unavailable/);
  logsFail=false;logs=[];
  const recovered=await waitFor(record=>record.smartAccountCount===0 && record.entryPointIndex.status==='complete');
  assert.equal(recovered.nativeWalletCount,0);
});
