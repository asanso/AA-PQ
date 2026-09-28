import {formatEther} from 'viem';
import {quoteCall} from '../native-frame/client.js';
export const fetchFeeTiers=async()=>null;
export async function estimateUserOpCost({smartAddress,valueWei=0n,to,data='0x'}) {
  if(!smartAddress || !to) throw Error('Sender and destination are required for the fee review.');
  const quote=await quoteCall(smartAddress,to,valueWei,data);
  const gasCostWei=quote.feeReserve,totalCostWei=valueWei+gasCostWei;
  const sufficient=quote.balance>=totalCostWei,deficitWei=sufficient?0n:totalCostWei-quote.balance;
  return {...quote,valueWei,gasCostWei,totalCostWei,balanceWei:quote.balance,sufficient,deficitWei,tiers:null,
    prefundWei:gasCostWei,totalGas:quote.reserveGas,gasCostEth:formatEther(gasCostWei),prefundEth:formatEther(gasCostWei),
    balanceEth:formatEther(quote.balance),deficitEth:formatEther(deficitWei),reviewed:{feeReserve:gasCostWei.toString(),at:Date.now()}};
}
