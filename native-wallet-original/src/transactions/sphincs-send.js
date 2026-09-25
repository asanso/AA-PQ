import { parseEther } from 'viem';
import { encodeErc20Transfer,parseTokenAmount } from '../blockchain/erc20.js';
import { sendCall } from '../native-frame/send.js';
export async function sendViaSphincs({request,activity,assertContext=()=>{}}) {
  assertContext();const token=request.selectedToken;
  return sendCall({to:token?token.address:request.recipient,value:token?0n:parseEther(request.amount),
    data:token?encodeErc20Transfer(request.recipient,parseTokenAmount(request.amount,token.decimals)):'0x',
    reviewed:request.reviewed,activity,details:{to:request.recipient,amount:request.amount,
      kind:token?'send-token':undefined,tokenSymbol:token?.symbol,tokenAddress:token?.address}});
}
