import { AbiCoder, Interface, TypedDataEncoder, concat, getAddress, getCreate2Address, keccak256, toBeHex } from 'ethers';

export const SIGNATURE_BYTES = 6176;
export const ACCOUNT_ABI = new Interface([
  'function execute(address target,uint256 value,bytes data)',
  'function pkSeed() view returns(bytes32)', 'function pkRoot() view returns(bytes32)',
]);
export const FACTORY_ABI = new Interface([
  'function createAccount(bytes32 pkSeed,bytes32 pkRoot,uint256 salt) returns(address)',
  'function getAddress(bytes32 pkSeed,bytes32 pkRoot,uint256 salt) view returns(address)',
]);
export const PACKED_TYPE = '(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)';
export const ENTRY_POINT_ABI = new Interface([
  `function getUserOpHash(${PACKED_TYPE} userOp) view returns(bytes32)`,
  'function getNonce(address sender,uint192 key) view returns(uint256)',
  'function balanceOf(address account) view returns(uint256)',
  `function handleOps(${PACKED_TYPE}[] ops,address payable beneficiary)`,
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
]);
const coder = AbiCoder.defaultAbiCoder();
export const quantity = value => '0x' + BigInt(value).toString(16);
export const isHex = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);

export function canonicalKey(seed, root) {
  for (const word of [seed, root]) {
    if (!/^0x[0-9a-f]{64}$/i.test(word) || BigInt(word) === 0n || BigInt(word) % (1n << 128n) !== 0n) {
      throw Error('Invalid SPHINCS-G public key encoding.');
    }
  }
}
export function accountRuntime(implementation) {
  return concat(['0x363d3d373d3d3d363d73', getAddress(implementation), '0x5af43d82803e903d91602b57fd5bf3']);
}
export function accountAddress(config, seed, root, salt = 0n) {
  canonicalKey(seed, root);
  if (!config.factory || !config.implementation) throw Error('This wallet build has no deployed SPHINCS ERC-4337 factory configured.');
  const initCode = concat(['0x3d602d80600a3d3981f3', accountRuntime(config.implementation)]);
  const fullSalt = keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [seed, root, salt]));
  return getCreate2Address(config.factory, fullSalt, keccak256(initCode));
}
export function pack128(high, low) {
  high = BigInt(high); low = BigInt(low);
  if (high < 0n || low < 0n || high >= 1n << 128n || low >= 1n << 128n) throw Error('Packed value exceeds uint128.');
  return toBeHex((high << 128n) | low, 32);
}
export function packOperation(operation) {
  return {
    sender: operation.sender, nonce: BigInt(operation.nonce),
    initCode: operation.factory ? concat([operation.factory, operation.factoryData]) : '0x',
    callData: operation.callData,
    accountGasLimits: pack128(operation.verificationGasLimit, operation.callGasLimit),
    preVerificationGas: BigInt(operation.preVerificationGas),
    gasFees: pack128(operation.maxPriorityFeePerGas, operation.maxFeePerGas),
    paymasterAndData: '0x', signature: operation.signature || '0x',
  };
}
export function operationHash(config, operation) {
  const fields = [
    ['sender', 'address'], ['nonce', 'uint256'], ['initCode', 'bytes'], ['callData', 'bytes'],
    ['accountGasLimits', 'bytes32'], ['preVerificationGas', 'uint256'], ['gasFees', 'bytes32'], ['paymasterAndData', 'bytes'],
  ].map(([name, type]) => ({ name, type }));
  return TypedDataEncoder.hash({ name: 'ERC4337', version: '1', chainId: config.chainId,
    verifyingContract: config.entryPoint }, { PackedUserOperation: fields }, packOperation(operation));
}
export function buildOperation({ config, key, nonce, deployed, recipient, value = 0n, data = '0x', quote }) {
  if (BigInt(value) < 0n || !isHex(data)) throw Error('Invalid call value or calldata.');
  const operation = {
    sender: accountAddress(config, key.backupPkSeed, key.backupPkRoot), nonce: quantity(nonce),
    callData: ACCOUNT_ABI.encodeFunctionData('execute', [getAddress(recipient), BigInt(value), data]),
    verificationGasLimit: quantity(quote.verificationGas), callGasLimit: quantity(quote.callGas),
    preVerificationGas: quantity(quote.preVerificationGas),
    maxFeePerGas: quantity(quote.maxFee), maxPriorityFeePerGas: quantity(quote.priorityFee), signature: '0x',
  };
  if (!deployed) {
    operation.factory = config.factory;
    operation.factoryData = FACTORY_ABI.encodeFunctionData('createAccount', [key.backupPkSeed, key.backupPkRoot, 0n]);
  }
  return operation;
}
export function receiptOutcome(receipt, hash, sender, entryPoint) {
  if (!receipt) return { status: 'pending' };
  if (receipt.status == null || BigInt(receipt.status) !== 1n) throw Error('Inconsistent inclusion receipt.');
  const matches = (receipt.logs || []).filter(log => log.address?.toLowerCase() === entryPoint.toLowerCase())
    .flatMap(log => { try { const parsed = ENTRY_POINT_ABI.parseLog(log); return parsed?.name === 'UserOperationEvent' ? [parsed] : []; } catch { return []; } })
    .filter(event => event.args.userOpHash.toLowerCase() === hash.toLowerCase());
  if (matches.length !== 1 || matches[0].args.sender.toLowerCase() !== sender.toLowerCase()) {
    throw Error('No matching EntryPoint UserOperation event in the transaction receipt.');
  }
  const success = matches[0].args.success;
  return { status: success ? 'confirmed' : 'failed', txHash: receipt.transactionHash, receipt,
    message: success ? undefined : 'The UserOperation was included but its execution reverted.' };
}
