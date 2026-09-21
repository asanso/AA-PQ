import {Interface} from 'ethers';

const packed = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
export const bundleInterface = new Interface([
  `function handleOps(${packed}[] ops,address beneficiary)`,
  `function handleAggregatedOps((${packed}[] userOps,address aggregator,bytes signature)[] opsPerAggregator,address beneficiary)`,
]);

// The event does not contain signature bytes. Read the exact bytes submitted
// in the enclosing EntryPoint call, never the outer transaction signature.
export function operationSignature(tx, op, entryPoint) {
  if (tx?.to?.toLowerCase() !== entryPoint.toLowerCase()) return null;
  try {
    const decoded = bundleInterface.parseTransaction({data: tx.data});
    if (!decoded) return null;
    const ops = decoded.name === 'handleOps' ? decoded.args.ops
      : decoded.args.opsPerAggregator.flatMap(group => [...group.userOps]);
    const matches = ops.filter(item => item.sender.toLowerCase() === op.sender.toLowerCase()
      && item.nonce.toString() === op.nonce.toString());
    // Do not guess if a bundle is ambiguous or uses an unsupported wrapper.
    return matches.length === 1 ? matches[0].signature : null;
  } catch { return null; }
}
