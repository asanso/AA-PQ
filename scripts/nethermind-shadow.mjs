// Follow an existing Prague chain without asking the candidate to build payloads.
// Run only against the private candidate Engine API, never the live beacon's EL.
import {readFile} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const emptyRequestsHash='0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export function executionPayload(block, rawTransactions) {
  if(block.requestsHash!==emptyRequestsHash) throw Error('Nonempty execution requests require a consensus-payload source');
  if(!Array.isArray(block.withdrawals) || block.blobGasUsed==null || block.excessBlobGas==null || !block.parentBeaconBlockRoot) {
    throw Error('Expected a Prague execution block');
  }
  if(block.transactions.length!==rawTransactions.length) throw Error('Missing transaction bytes');
  return {parentHash:block.parentHash,feeRecipient:block.miner,stateRoot:block.stateRoot,
    receiptsRoot:block.receiptsRoot,logsBloom:block.logsBloom,prevRandao:block.mixHash,
    blockNumber:block.number,gasLimit:block.gasLimit,gasUsed:block.gasUsed,
    timestamp:block.timestamp,extraData:block.extraData,baseFeePerGas:block.baseFeePerGas,
    blockHash:block.hash,transactions:rawTransactions,withdrawals:block.withdrawals,
    blobGasUsed:block.blobGasUsed,excessBlobGas:block.excessBlobGas};
}

async function main() {
  const {SOURCE_RPC_URL:source, CANDIDATE_RPC_URL:candidate,
    CANDIDATE_ENGINE_URL:engine, ENGINE_JWT_FILE:jwtFile, EXPECTED_GENESIS_HASH:expected}=process.env;
  if(!source || !candidate || !engine || !jwtFile || !/^0x[0-9a-f]{64}$/.test(expected||'')) {
    throw Error('Set SOURCE_RPC_URL, CANDIDATE_RPC_URL, CANDIDATE_ENGINE_URL, ENGINE_JWT_FILE, EXPECTED_GENESIS_HASH');
  }
  if(source===candidate || source===engine || candidate===engine) throw Error('Source and candidate endpoints must be distinct');
  const secretHex=(await readFile(jwtFile,'utf8')).trim().replace(/^0x/,'');
  if(!/^[0-9a-fA-F]{64}$/.test(secretHex)) throw Error('Invalid Engine JWT secret');
  const secret=Buffer.from(secretHex,'hex');
  async function rpc(url,method,params=[]) {
    const headers={'content-type':'application/json'};
    if(url===engine) {
      const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
      const p=Buffer.from(JSON.stringify({iat:Math.floor(Date.now()/1000)})).toString('base64url');
      headers.Authorization='Bearer '+h+'.'+p+'.'+createHmac('sha256',secret).update(h+'.'+p).digest('base64url');
    }
    const response=await fetch(url,{method:'POST',headers,
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});
    const result=await response.json();
    if(result.error) throw Error(method+': '+JSON.stringify(result.error));
    return result.result;
  }
  for(const url of [source,candidate]) {
    if(BigInt(await rpc(url,'eth_chainId'))!==1337n) throw Error('Expected chain ID 1337');
    if((await rpc(url,'eth_getBlockByNumber',['0x0',false])).hash!==expected) throw Error('Genesis mismatch');
  }
  while(true) {
    const head=await rpc(source,'eth_getBlockByNumber',['latest',true]);
    const finalized=await rpc(source,'eth_getBlockByNumber',['finalized',false]);
    const previous=await rpc(candidate,'eth_getBlockByNumber',['latest',false]);
    const blocks=[];
    if(Number(head.number)-Number(previous.number)<=16) {
      for(let n=Number(previous.number)+1;n<Number(head.number);n++) {
        blocks.push(await rpc(source,'eth_getBlockByNumber',['0x'+n.toString(16),true]));
      }
    }
    blocks.push(head);
    let accepted;
    for(const block of blocks) {
      const raw=await Promise.all(block.transactions.map(tx=>rpc(source,'debug_getRawTransaction',[tx.hash])));
      const payload=executionPayload(block,raw);
      const hashes=block.transactions.flatMap(tx=>tx.blobVersionedHashes||[]);
      accepted=await rpc(engine,'engine_newPayloadV4',[payload,hashes,block.parentBeaconBlockRoot,[]]);
      if(!['VALID','SYNCING','ACCEPTED'].includes(accepted.status)) throw Error('Candidate rejected canonical payload: '+JSON.stringify(accepted));
    }
    const fork=await rpc(engine,'engine_forkchoiceUpdatedV3',[{headBlockHash:head.hash,
      safeBlockHash:finalized.hash,finalizedBlockHash:finalized.hash},null]);
    if(!['VALID','SYNCING'].includes(fork.payloadStatus.status)) throw Error('Candidate rejected forkchoice: '+JSON.stringify(fork));
    const target=await rpc(candidate,'eth_getBlockByNumber',['latest',false]);
    console.log(JSON.stringify({source:Number(head.number),candidate:Number(target.number),
      sourceHash:head.hash,candidateHash:target.hash,engine:accepted.status}));
    if(process.argv.includes('--once')) break;
    await new Promise(resolve=>setTimeout(resolve,4000));
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
