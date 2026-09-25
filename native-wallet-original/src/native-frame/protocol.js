import { encodeRlp, decodeRlp, keccak256, getBytes, toBeHex, getAddress, getCreate2Address, Interface, ZeroHash } from 'ethers';

export const CHAIN_ID = 1337n;
export const SIGNATURE_BYTES = 6176;
export const FACTORY_ABI = new Interface([
  'function getAddress(bytes32,bytes32,bytes32) view returns(address)',
  'function createAccount(bytes32,bytes32,bytes32) returns(address)',
  'function ACCOUNT_IMPL() view returns(address)',
  'function SPHINCS_VERIFIER() view returns(address)',
]);
export const quantity = value => BigInt(value) === 0n ? '0x' : toBeHex(value);
export const rpcQuantity = value => '0x' + BigInt(value === '0x' ? 0 : value).toString(16);
export const encodeFrame = payload => '0x06' + encodeRlp(payload).slice(2);
export function signingHash(payload) {
  const canonical = structuredClone(payload);
  for (const witness of canonical[4]) if (witness[2] === '0x') witness[3] = '0x';
  return keccak256(encodeFrame(canonical));
}
export function decodeFrame(raw) {
  if (!/^0x06[0-9a-f]+$/i.test(raw)) throw Error('Expected a native frame transaction (type 0x06).');
  return decodeRlp('0x' + raw.slice(4));
}
export function accountRuntime(implementation, pkSeed, pkRoot) {
  for (const key of [pkSeed, pkRoot]) if (!/^0x[0-9a-f]{32}0{32}$/i.test(key)) throw Error('Invalid SPHINCS public-key encoding.');
  return '0x363d3d373d3d3d363d73' + getAddress(implementation).slice(2).toLowerCase() +
    '5af43d82803e903d91602b57fd5bf3' + pkSeed.slice(2) + pkRoot.slice(2);
}
export function accountAddress(config, pkSeed, pkRoot) {
  const runtime = accountRuntime(config.implementation, pkSeed, pkRoot);
  return getCreate2Address(config.factory, ZeroHash, keccak256('0x3d606d80600a3d3981f3' + runtime.slice(2)));
}

export function buildTransfer({ config, pkSeed, pkRoot, sender, recipient, nonce, value, deployed, maxFee, priorityFee, data = '0x', callGas = 500000n }) {
  sender = getAddress(sender); recipient = getAddress(recipient);
  if (BigInt(value) < 0n || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw Error('Invalid transaction value or calldata.');
  if (BigInt(callGas) < 21000n || BigInt(callGas) > 5000000n) throw Error('Contract call exceeds the supported gas budget.');
  if (BigInt(nonce) < 0n || BigInt(maxFee) < BigInt(priorityFee) || BigInt(priorityFee) < 0n) throw Error('Invalid nonce or fees.');
  if (sender !== accountAddress(config, pkSeed, pkRoot)) throw Error('The account does not match this factory and public key.');
  const frames = [];
  if (!deployed) frames.push(['0x', '0x', config.factory, [quantity(80000), quantity(450000)], '0x',
    FACTORY_ABI.encodeFunctionData('createAccount', [pkSeed, pkRoot, ZeroHash])]);
  frames.push([quantity(1), quantity(3), sender, [quantity(deployed ? 450000 : 415000), '0x'], '0x', '0x']);
  frames.push([quantity(2), '0x', recipient, [quantity(callGas), quantity(callGas)], quantity(value), data]);
  return [quantity(CHAIN_ID), quantity(nonce), sender, frames, [['0x', '0x', '0x', '0x']],
    [quantity(priorityFee), quantity(maxFee), '0x'], []];
}
export function signedFrame(payload, signature) {
  if (getBytes(signature).length !== SIGNATURE_BYTES) throw Error('Unexpected SPHINCS signature length.');
  const signed = structuredClone(payload); signed[4][0][3] = signature;
  return signed;
}
export function frameRpc(payload) {
  return { type: '0x6', chainId: rpcQuantity(payload[0]), nonce: rpcQuantity(payload[1]), from: payload[2], to: payload[2],
    frames: payload[3].map(f => ({ mode: Number(BigInt(rpcQuantity(f[0]))), flags: Number(BigInt(rpcQuantity(f[1]))),
      target: f[2], executionGasLimit: rpcQuantity(f[3][0]), stateGasLimit: rpcQuantity(f[3][1]), value: rpcQuantity(f[4]), data: f[5] })),
    signatures: payload[4].map(w => ({ scheme: 0, signer: null, msg: w[2], signature: w[3] })),
    maxPriorityFeePerGas: rpcQuantity(payload[5][0]), maxFeePerGas: rpcQuantity(payload[5][1]), maxFeePerBlobGas: '0x0', blobVersionedHashes: [] };
}
export function receiptOutcome(receipt, expectedHash, expectedFrames) {
  if (!receipt) return { status: 'pending' };
  if (receipt.transactionHash?.toLowerCase() !== expectedHash.toLowerCase() || BigInt(receipt.type ?? -1) !== 6n)
    throw Error('The receipt does not match this frame transaction.');
  if (receipt.status == null || receipt.blockNumber == null) throw Error('Incomplete transaction receipt.');
  if (BigInt(receipt.status) !== 1n) return { status: 'failed', message: 'Transaction failed.', receipt };
  if (!Array.isArray(receipt.frameReceipts) || receipt.frameReceipts.length !== expectedFrames)
    throw Error('Frame execution results are unavailable. Success cannot be confirmed.');
  const failed = receipt.frameReceipts.findIndex(f => f.status == null || BigInt(f.status) !== 1n);
  return failed < 0 ? { status: 'confirmed', receipt } :
    { status: 'failed', message: `Frame ${failed} failed. The transfer was not confirmed.`, receipt };
}
