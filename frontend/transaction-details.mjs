const addressPattern=/^0x[0-9a-fA-F]{40}$/;
const hashPattern=/^0x[0-9a-fA-F]{64}$/;
const quantity=value=>value==null?null:BigInt(value);
const decimal=value=>value==null?null:BigInt(value).toString();
function percent(used,limit) {
  if(used==null||limit==null||BigInt(limit)===0n)return null;
  const hundredths=(BigInt(used)*10000n+BigInt(limit)/2n)/BigInt(limit);
  return `${hundredths/100n}.${String(hundredths%100n).padStart(2,'0')}`;
}
export function transactionMetrics(tx,receipt,block,head) {
  const mined=receipt!=null;
  const used=quantity(receipt?.gasUsed),limit=quantity(tx.gasLimit);
  const price=quantity(receipt?.gasPrice ?? receipt?.effectiveGasPrice);
  const base=quantity(block?.baseFeePerGas),cap=quantity(tx.maxFeePerGas);
  const execution=used!=null&&price!=null?used*price:null;
  const blobUsed=quantity(receipt?.blobGasUsed),blobPrice=quantity(receipt?.blobGasPrice);
  const blobFee=blobUsed!=null&&blobPrice!=null?blobUsed*blobPrice:null;
  const isBlob=Number(tx.type)===3;
  const fee=execution!=null&&(!isBlob||blobFee!=null)?execution+(blobFee||0n):null;
  const burnt=used!=null&&base!=null?used*base:null;
  const saving=used!=null&&price!=null&&cap!=null?(cap>price?cap-price:0n)*used:null;
  const blockNumber=receipt?.blockNumber ?? tx.blockNumber ?? null;
  return {
    hash:tx.hash,from:tx.from,to:tx.to,contractAddress:receipt?.contractAddress || null,
    status:receipt ? receipt.status==null?'Unknown':Number(receipt.status)===1?'Success':Number(receipt.status)===0?'Failed':'Unknown' : tx.blockNumber==null?'Pending':'Unknown',
    blockNumber,blockHash:receipt?.blockHash ?? tx.blockHash ?? null,
    confirmations:mined&&blockNumber!=null&&head!=null?Math.max(0,Number(head)-Number(blockNumber)+1):null,
    observedHead:head??null,timestamp:block?.timestamp??null,
    valueWei:decimal(tx.value),gasLimit:decimal(limit),gasUsed:decimal(used),gasUsedPercent:percent(used,limit),
    effectiveGasPriceWei:decimal(price),baseFeePerGasWei:decimal(base),maxFeePerGasWei:decimal(cap),maxPriorityFeePerGasWei:decimal(tx.maxPriorityFeePerGas),
    transactionFeeWei:decimal(fee),executionFeeWei:decimal(execution),burntExecutionFeeWei:decimal(burnt),feeSavingWei:decimal(saving),
    blobGasUsed:decimal(blobUsed),blobGasPriceWei:decimal(blobPrice),blobFeeWei:decimal(blobFee),
    type:tx.type??null,nonce:decimal(tx.nonce),transactionIndex:receipt?.index??receipt?.transactionIndex??tx.index??null,
    chainId:decimal(tx.chainId),accessListEntries:Array.isArray(tx.accessList)?tx.accessList.length:null
  };
}
export function summarizeCallTrace(root) {
  if(!root||typeof root!=='object'||typeof root.type!=='string')throw new Error('Invalid call trace response');
  const transfers=[],createdContracts=[];
  function walk(frame,path,reverted) {
    const failed=reverted||Boolean(frame.error);
    if(!failed&&path.length){
      const type=String(frame.type).toUpperCase();
      if(['CREATE','CREATE2'].includes(type)&&addressPattern.test(frame.to||''))createdContracts.push({address:frame.to,type,path:path.join('.')});
      if(['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(type)&&addressPattern.test(frame.from||'')&&addressPattern.test(frame.to||'')){
        const value=quantity(frame.value??0);
        if(value>0n)transfers.push({type,from:frame.from,to:frame.to,valueWei:value.toString(),path:path.join('.')});
      }
    }
    if(frame.calls!=null&&!Array.isArray(frame.calls))throw new Error('Invalid child calls');
    for(const [index,child] of (frame.calls||[]).entries())walk(child,[...path,index],failed);
  }
  walk(root,[],false);
  const balances=new Map();
  for(const transfer of transfers){
    for(const [address,amount] of [[transfer.from,-BigInt(transfer.valueWei)],[transfer.to,BigInt(transfer.valueWei)]]){
      const key=address.toLowerCase(),entry=balances.get(key)||{address,value:0n};entry.value+=amount;balances.set(key,entry);
    }
  }
  return {status:'available',transfers,createdContracts,netTransfers:[...balances.values()].filter(item=>item.value!==0n).map(item=>({address:item.address,valueWei:item.value.toString()})),reverted:Boolean(root.error)};
}
export function createTransactionDetails({provider,rpcUrl,fetchImpl=fetch,now=Date.now}) {
  const traces=new Map(),pending=new Map();let active=0;
  async function trace(tx,receipt) {
    if(!receipt)return {status:'unavailable',message:tx.blockNumber==null?'Internal transfers are available after the transaction is mined.':'A receipt is required to inspect internal transfers.'};
    if(!rpcUrl)return {status:'unavailable',message:'Transaction tracing is not configured for this environment.'};
    const key=tx.hash+':'+receipt.blockHash;
    const cached=traces.get(key);if(cached&&cached.expires>now())return cached.value;
    if(pending.has(key))return pending.get(key);
    if(active>=2)return {status:'unavailable',message:'Transaction tracing is busy. Refresh to try again.'};
    active++;
    const work=(async()=>{
      let result;
      try{
        if(!hashPattern.test(tx.hash))throw new Error('Invalid transaction hash');
        const response=await fetchImpl(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'debug_traceTransaction',params:[tx.hash,{tracer:'callTracer',timeout:'2s',reexec:0}]}),signal:AbortSignal.timeout(5000)});
        const data=await response.json();
        if(!response.ok||data.error){
          const error=String(data.error?.message||'');
          result={status:'unavailable',message:/historical state|missing trie|state .*unavailable/i.test(error)?'The node does not have the historical state needed to trace this transaction. Internal transfers cannot be retrieved.':/method.*not|not.*available|not supported/i.test(error)?'This RPC node does not expose transaction tracing.':'The node could not return a transaction trace. Refresh to try again.'};
        }else result=summarizeCallTrace(receipt.status!=null&&Number(receipt.status)===0?{...data.result,error:data.result?.error||'Transaction reverted'}:data.result);
      }catch{result={status:'unavailable',message:'Transaction tracing is unavailable or timed out. The other transaction details remain available.'};}
      if(traces.size>=100)traces.delete(traces.keys().next().value);
      traces.set(key,{value:result,expires:now()+30000});return result;
    })().finally(()=>{active--;pending.delete(key);});
    pending.set(key,work);return work;
  }
  return async tx=>{
    const [receiptResult,headResult,blockResult]=await Promise.allSettled([
      provider.getTransactionReceipt(tx.hash),provider.getBlockNumber(),tx.blockHash?provider.getBlock(tx.blockHash):Promise.resolve(null)
    ]);
    const receipt=receiptResult.status==='fulfilled'?receiptResult.value:null;
    let block=blockResult.status==='fulfilled'?blockResult.value:null;
    if(block&&receipt?.blockHash&&block.hash!==receipt.blockHash)block=null;
    const head=headResult.status==='fulfilled'?headResult.value:null;
    const details=transactionMetrics(tx,receipt,block,head);
    details.errors=[];
    if(receiptResult.status==='rejected')details.errors.push('The transaction receipt is unavailable.');
    if(blockResult.status==='rejected'||tx.blockHash&&!block)details.errors.push('Block timestamp and base fee are unavailable.');
    if(headResult.status==='rejected')details.errors.push('The latest block height is unavailable; confirmations cannot be calculated.');
    details.internalTransfers=await trace(tx,receipt);
    return details;
  };
}
