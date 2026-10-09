import { getAddress } from 'ethers';
import { sendCall } from './protocol-adapter.js';
import { smartAddr } from '../ui/store.js';
export async function handleDappTransaction(tx,_legacy,options={}) {
  if(!tx.from || getAddress(tx.from)!==getAddress(smartAddr.value)) throw Error('Requested account is not active.');
  if(tx.chainId!=null && BigInt(tx.chainId)!==1337n) throw Error('Daisugi chain ID is required.');
  const supported=new Set(['from','to','value','data','input','nonce','chainId','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','type']);
  for(const name of Object.keys(tx)) if(!supported.has(name)) throw Error('Unsupported transaction field: '+name);
  if(tx.input && tx.data && tx.input!==tx.data) throw Error('Conflicting input and data fields.');
  if(tx.gasPrice!=null || tx.maxFeePerGas!=null || tx.maxPriorityFeePerGas!=null || tx.gas!=null)
    throw Error('This wallet calculates gas limits and fees for its selected transaction mode. Remove EOA gas overrides and review the wallet fee.');
  if(tx.type!=null && ![0n,2n].includes(BigInt(tx.type))) throw Error('Unsupported dApp transaction type. Request a contract call without a raw transaction type.');
  return sendCall({to:tx.to,value:BigInt(tx.value || 0),data:tx.data || tx.input || '0x',expectedNonce:tx.nonce,
    reviewed:options.reviewed,onPhase:options.onPhase,details:{kind:'contract-call'}});
}
