// Read-only comparison at a common recent height; writes a JSON report to stdout.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const source=process.env.SOURCE_RPC_URL,candidate=process.env.CANDIDATE_RPC_URL;
if(!source||!candidate||source===candidate) throw Error('Set distinct SOURCE_RPC_URL and CANDIDATE_RPC_URL');
async function rpc(url,method,params=[]) {
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
  const j=await r.json();if(j.error)throw Error(method+': '+JSON.stringify(j.error));return j.result;
}
const block=(url,tag)=>rpc(url,'eth_getBlockByNumber',[tag,false]);
assert.equal(await rpc(source,'eth_chainId'),'0x539');
assert.equal(await rpc(candidate,'eth_chainId'),'0x539');
const genesis=await block(source,'0x0');
assert.equal((await block(candidate,'0x0')).hash,genesis.hash);
const candidateHead=await block(candidate,'latest'),sourceHead=await block(source,'latest');
const lag=Number(sourceHead.number)-Number(candidateHead.number);
assert.ok(lag>=0 && lag<=8,`Candidate lag ${lag} blocks exceeds tolerance`);
const tag=candidateHead.number,canonical=await block(source,tag);
assert.equal(candidateHead.hash,canonical.hash);
assert.equal(candidateHead.stateRoot,canonical.stateRoot);
const finalized=await block(source,'finalized');
assert.equal((await block(candidate,finalized.number)).hash,finalized.hash);
const ep='0x433709009b8330fda32311df1c2afa402ed8d009';
const logs=await rpc(source,'eth_getLogs',[{address:ep,fromBlock:'0x0',toBlock:tag,
  topics:['0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f']}]);
const addresses=new Set([ep,...(process.env.CHECK_ADDRESSES||'').split(',').filter(Boolean)]);
for(const log of logs.slice(-20)) if(log.topics[2]) addresses.add('0x'+log.topics[2].slice(-40));
const state=[];
for(const address of addresses) {
  const sample={address};
  for(const [label,method,params] of [
    ['balance','eth_getBalance',[address,tag]],['nonce','eth_getTransactionCount',[address,tag]],
    ['code','eth_getCode',[address,tag]],['slot0','eth_getStorageAt',[address,'0x0',tag]],
    ['slot1','eth_getStorageAt',[address,'0x1',tag]],
  ]) {
    const expected=await rpc(source,method,params),actual=await rpc(candidate,method,params);
    assert.equal(actual,expected,`${label} mismatch for ${address}`);
    sample[label]=label==='code'?{bytes:(actual.length-2)/2,sha256:createHash('sha256').update(Buffer.from(actual.slice(2),'hex')).digest('hex')}:actual;
  }
  state.push(sample);
}
const historicalReceipts=[];
for(const log of logs.filter((_,i)=>i===0||i===Math.floor(logs.length/2)||i===logs.length-1)) {
  const a=await rpc(source,'eth_getTransactionReceipt',[log.transactionHash]);
  const b=await rpc(candidate,'eth_getTransactionReceipt',[log.transactionHash]);
  assert.ok(b,'Historical receipt missing');
  for(const field of ['blockHash','transactionHash','status','gasUsed','logsBloom']) assert.equal(b[field],a[field]);
  assert.deepEqual(b.logs,a.logs);
  historicalReceipts.push(log.transactionHash);
}
console.log(JSON.stringify({passed:true,genesis:genesis.hash,block:Number(tag),hash:canonical.hash,
  stateRoot:canonical.stateRoot,finalized:Number(finalized.number),finalizedHash:finalized.hash,
  lag,accountSamples:state,historicalReceipts,userOperationEvents:logs.length},null,2));
