import { createProfile } from './account-profile.mjs';

export function createProtocol(e) {
  const p = createProfile(e);
  const { getAddress, getBytes, getCreate2Address, keccak256, concat, encodeRlp, toBeHex, Interface, ZeroHash } = e;
  const abi = new Interface(['function createAccount(bytes32,bytes32,bytes32) returns(address)',
    'function getAddress(bytes32,bytes32,bytes32) view returns(address)', 'function ACCOUNT_IMPL() view returns(address)']);
  const quantity = value => BigInt(value) === 0n ? '0x' : toBeHex(value);
  const accountAddress = (config, pkSeed, pkRoot) => getCreate2Address(config.factory, ZeroHash,
    keccak256(p.initCode(config.implementation, p.keyHash(pkSeed, pkRoot))));
  function prepare({ config, pkSeed, pkRoot, nonce, recipient, value, data = '0x', deployed, maxFee, priorityFee, callGas = 100000n, stateGas = 100000n }) {
    if (BigInt(nonce) < 0n || BigInt(value) < 0n || BigInt(priorityFee) < 0n || BigInt(maxFee) < BigInt(priorityFee)) throw Error('Invalid transaction quantity.');
    if (BigInt(callGas) < 21000n || BigInt(callGas) > 5000000n || BigInt(stateGas) < 0n || BigInt(stateGas) > 5000000n) throw Error('Unsupported call gas budget.');
    const key = p.keyHash(pkSeed, pkRoot), sender = accountAddress(config, pkSeed, pkRoot);
    const frame = (mode, flags, target, executionGas, stateGas, value, data) => ({ mode, flags, target,
      executionGas: executionGas.toString(), stateGas: stateGas.toString(), value: value.toString(), data });
    const frames = [];
    if (!deployed) frames.push(frame(0, 0, getAddress(config.factory), 100000, 450000, 0,
      abi.encodeFunctionData('createAccount', [pkSeed, pkRoot, ZeroHash])));
    const dependencyIndex = frames.length;
    frames.push(frame(4, 0, null, 3000, 0, 0, concat([p.word(16), p.word(0), key])));
    frames.push(frame(1, 3, null, 100000, 0, 0, '0x'));
    frames.push(frame(2, 0, getAddress(recipient), callGas, stateGas, value, data));
    const transaction = { chainId: '1337', nonce: BigInt(nonce).toString(), nonceKeys: ['0'], sender, frames,
      maxPriorityFee: BigInt(priorityFee).toString(), maxFee: BigInt(maxFee).toString(), maxBlobFee: '0' };
    const digest = p.digest(transaction, key);
    frames[dependencyIndex].data = concat([p.word(16), digest, key]);
    return { transaction, digest, keyHash: key, pkSeed, pkRoot, dependencyIndex };
  }
  function encode(transaction) {
    return '0x06' + encodeRlp([quantity(transaction.chainId), ['0x'], quantity(transaction.nonce), transaction.sender,
      transaction.frames.map(f => [quantity(f.mode), quantity(f.flags), f.target ?? '0x',
        [quantity(f.executionGas), quantity(f.stateGas)], quantity(f.value), f.data]), [],
      [quantity(transaction.maxPriorityFee), quantity(transaction.maxFee), '0x'], []]).slice(2);
  }
  function signedRequest(prepared, signature) {
    if (getBytes(signature).length !== 6176) throw Error('Unexpected SPHINCS signature length.');
    if (p.digest(prepared.transaction, prepared.keyHash) !== prepared.digest) throw Error('Transaction changed after preparation.');
    const dependency = concat([p.word(16), prepared.digest, prepared.keyHash]);
    if (prepared.transaction.frames[prepared.dependencyIndex].data !== dependency) throw Error('Dependency changed after preparation.');
    const witness = concat(['0x' + prepared.pkRoot.slice(2, 34), '0x' + prepared.pkSeed.slice(2, 34), signature]);
    const raw = encode(prepared.transaction), hash = keccak256(raw);
    const wrapper = encodeRlp([[raw], '0x', [dependency, [witness]]]);
    return { raw, hash, wrapper, method: 'eth_sendProofWrapper', params: [wrapper] };
  }
  return { ...p, abi, accountAddress, prepare, encode, signedRequest };
}
