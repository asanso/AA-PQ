import {Interface} from 'ethers';
import {decodeInputData} from './input-decoder.mjs';
import {isFrameTransaction} from '../explorer/native-frame.mjs';
import {nativeAccountProfile} from './native-profile.mjs';

const packed = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
const nativeFactoryInput = new Interface(['function createAccount(bytes32 pkSeed,bytes32 pkRoot,bytes32 salt)']);
export const entryPointInput = new Interface([
  `function handleOps(${packed}[] ops,address beneficiary)`,
  `function handleAggregatedOps((${packed}[] userOps,address aggregator,bytes signature)[] opsPerAggregator,address beneficiary)`,
]);
export const isHexData = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

// Decode only the supported EntryPoint ABI, never infer an account method or
// signature algorithm. A sender/nonce match must be unique within the bundle.
export function operationCallData(transaction, operation, entryPoint) {
  if (!entryPoint || transaction?.to?.toLowerCase() !== entryPoint.toLowerCase()) return null;
  try {
    const decoded = entryPointInput.parseTransaction({data:transaction.data});
    if (!decoded) return null;
    const operations = decoded.name === 'handleOps' ? decoded.args.ops
      : decoded.args.opsPerAggregator.flatMap(group => [...group.userOps]);
    const matches = operations.filter(item => item.sender.toLowerCase() === operation.sender.toLowerCase()
      && item.nonce.toString() === operation.nonce.toString());
    return matches.length === 1 && isHexData(matches[0].callData) ? matches[0].callData : null;
  } catch {return null;}
}

export async function addTransactionInput({provider, data, kind, id, entryPoint, loadTransactionDetails}) {
  const hash = kind === 'tx' ? id : data.transactionHash;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new Error('No valid enclosing transaction hash is available.');
    const [network, transaction] = await Promise.all([provider.getNetwork(),provider.getTransaction(hash)]);
    if (Number(network.chainId) !== 1337) throw new Error('The RPC is not connected to Daisugi (chain 1337).');
    if (!transaction) throw new Error('The transaction input is not available from the RPC.');
    if (transaction.hash?.toLowerCase() !== hash.toLowerCase()) throw new Error('The RPC returned a different transaction.');
    if (!isHexData(transaction.data)) throw new Error('The RPC returned invalid transaction input.');
    const innerCallData = kind === 'op' ? operationCallData(transaction,data,entryPoint) : null;
    const inputIsEntryPoint = entryPoint && transaction.to?.toLowerCase() === entryPoint.toLowerCase();
    const creation = transaction.to == null && !isFrameTransaction(transaction);
    const nativeFrame = data.nativeFrame ? {...data.nativeFrame,accountProfile:await nativeAccountProfile(provider,transaction),frames:data.nativeFrame.frames?.map(frame=>({
      ...frame, inputDecoded:decodeInputData(frame.data,frame.target?.toLowerCase() === '0xd07fcbdca6dea83b523faf95386cea236e32d989'
        ? {abi:nativeFactoryInput,abiSource:'Daisugi native factory ABI template'} : {})
    }))} : null;
    let transactionDetails = null;
    if (loadTransactionDetails) {
      try { transactionDetails = await loadTransactionDetails(transaction); }
      catch {
        // Optional metadata must not discard transaction input already verified above.
      }
    }
    return {
      ...data, ...(transactionDetails?{transactionDetails}:{}), inputData:transaction.data, inputDataError:null,
      ...(nativeFrame ? {nativeFrame} : {}), inputIsContractCreation:creation,
      inputDecoded:decodeInputData(transaction.data, {
        ...(inputIsEntryPoint ? {abi:entryPointInput,abiSource:'Packed EntryPoint ABI'} : {}),
        creation
      }),
      ...(kind === 'op' ? {operationCallData:innerCallData,operationCallDecoded:decodeInputData(innerCallData)} : {})
    };
  } catch (error) {
    // Keep indexed details and the signature visible when the extra RPC read fails.
    return {...data,inputData:null,inputDataError:error.shortMessage || error.message,inputDecoded:decodeInputData(null),
      ...(kind === 'op' ? {operationCallData:null,operationCallDecoded:decodeInputData(null)} : {})};
  }
}
