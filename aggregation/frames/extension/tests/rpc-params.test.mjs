import test from 'node:test';
import assert from 'node:assert/strict';
import httpServer from 'node:http';
import {createPublicClient,http} from 'viem';
import {withPositionalRpcParams} from '../src/blockchain/rpc-params.js';

test('viem block polling sends explicit params through an unchanged strict gateway',async t=>{
  const calls=[];
  const server=httpServer.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);calls.push(body);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,...(Array.isArray(body.params)
      ? {result:'0x539'} : {error:{code:-32602,message:'Expected positional parameters'}})}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const client=createPublicClient({transport:http('http://127.0.0.1:'+server.address().port,
    {batch:false,retryCount:0,onFetchRequest:withPositionalRpcParams})});
  assert.equal(await client.getBlockNumber({cacheTime:0}),1337n);
  assert.equal(await client.getChainId(),1337);
  assert.deepEqual(calls.map(call=>call.params),[[],[]]);
  assert.ok(calls.every(call=>call.jsonrpc==='2.0' && Number.isInteger(call.id)));
  await client.request({method:'eth_call',params:[{to:'0x'+'11'.repeat(20),data:'0xabcdef'},'latest']});
  assert.deepEqual(calls.at(-1).params,[{to:'0x'+'11'.repeat(20),data:'0xabcdef'},'latest']);
});

test('parameter normalization preserves explicit bodies, transport settings and signed bytes',()=>{
  const controller=new AbortController();
  const init=Object.freeze({method:'POST',signal:controller.signal,headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_blockNumber'})});
  const normalized=withPositionalRpcParams(null,init);
  assert.equal(normalized.signal,init.signal);assert.equal(normalized.headers,init.headers);
  assert.deepEqual(JSON.parse(normalized.body),{jsonrpc:'2.0',id:2,method:'eth_blockNumber',params:[]});
  assert.equal(Object.hasOwn(JSON.parse(init.body),'params'),false);
  for(const params of [[],null,{},['0x06abcdef']]) {
    const explicit={...init,body:JSON.stringify({jsonrpc:'2.0',id:3,method:'eth_sendRawTransaction',params})};
    assert.equal(withPositionalRpcParams(null,explicit),explicit);
  }
});
