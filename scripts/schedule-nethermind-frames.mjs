import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function frameGenesis({genesis,head,finalized,migrationBlock,activation,now=Math.floor(Date.now()/1000)}) {
  if(Number(genesis.config?.chainId)!==1337) throw Error('Expected chain ID 1337');
  for(const [name,value] of Object.entries({migrationBlock,activation,now,
    finalizedBlock:Number(finalized.number),headTimestamp:Number(head.timestamp),genesisTimestamp:Number(genesis.timestamp)})) {
    if(!Number.isSafeInteger(value)||value<0) throw Error('Invalid '+name);
  }
  if(Number(finalized.number)<=migrationBlock) throw Error('Migration has not finalized');
  if(now-Number(head.timestamp)>60 || Number(head.timestamp)>now+2) throw Error('Head is stale or ahead of clock');
  if(activation-now<300 || activation<=Number(head.timestamp)) throw Error('Allow at least five minutes before activation');
  if((activation-Number(genesis.timestamp))%2!==0) throw Error('Activation must match the existing two-second slot grid');
  if(genesis.config.eip8141PrototypeTime!=null) throw Error('Frame activation is already configured');
  const result=structuredClone(genesis);
  result.config.eip8141PrototypeTime=activation;
  return result;
}

async function main() {
  const [input,output,url,expectedGenesis,migrationBlock,activation,...extra]=process.argv.slice(2);
  if(!activation||extra.length) throw Error('Usage: node scripts/schedule-nethermind-frames.mjs ORIGINAL_GENESIS NEW_GENESIS PRIVATE_RPC GENESIS_HASH MIGRATION_BLOCK UNIX_TIMESTAMP');
  async function rpc(method,params) {
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
    const data=await response.json();if(data.error)throw Error(JSON.stringify(data.error));return data.result;
  }
  const block=tag=>rpc('eth_getBlockByNumber',[tag,false]);
  if((await block('0x0')).hash!==expectedGenesis) throw Error('Live genesis hash differs from the migration record');
  if(BigInt(await rpc('eth_chainId',[]))!==1337n) throw Error('Wrong live network');
  const genesis=JSON.parse(await readFile(input,'utf8'));
  const head=await block('latest'),finalized=await block('finalized');
  const result=frameGenesis({genesis,head,finalized,migrationBlock:Number(migrationBlock),activation:Number(activation)});
  await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({output,activation:Number(activation),utc:new Date(Number(activation)*1000).toISOString(),
    finalized:Number(finalized.number),changedConfigFields:['eip8141PrototypeTime'],installed:false}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
