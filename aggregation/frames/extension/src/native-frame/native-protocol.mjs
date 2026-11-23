// Native (non-aggregated) SPHINCS-G frame accounts on an eip8288-lean network.
//
// The account is the frame-account prototype (frame-account/contracts): an EIP-1167 clone whose code carries the
// public key, verifying one ARBITRARY witness over the transaction's canonical signature hash with the pinned
// SPHINCS-G verifier. No block proof is involved: the signature travels in the transaction itself.
//
// Envelope (upstream Nethermind feature/eip8288-lean, EIP-8141 with EIP-8250):
//   0x06 || rlp([chain_id, nonce_keys, nonce, sender, frames, signatures, [max_fee, max_priority_fee], blobs])
// An empty nonce_keys list selects the account nonce. max_fee is the transaction's total fee budget.
// The canonical signature hash is keccak256 of that encoding with the signature bytes of every empty-msg entry
// replaced by their length (Nethermind FrameTxSigHash), so the witness can be added after signing.
export const SIGNATURE_BYTES = 6176;
export const CREATE_GAS = 80000n;
export const CREATE_STATE_GAS = 450000n;
export const VERIFY_GAS_FIRST = 415000n;
export const VERIFY_GAS = 450000n;

export function createNativeProtocol(e) {
  const { getAddress, getBytes, getCreate2Address, keccak256, encodeRlp, toBeHex, Interface, ZeroHash } = e;
  const abi = new Interface([
    'function getAddress(bytes32,bytes32,bytes32) view returns(address)',
    'function createAccount(bytes32,bytes32,bytes32) returns(address)',
    'function ACCOUNT_IMPL() view returns(address)',
    'function SPHINCS_VERIFIER() view returns(address)',
  ]);
  const quantity = value => BigInt(value) === 0n ? '0x' : toBeHex(value);
  const encode = payload => '0x06' + encodeRlp(payload).slice(2);
  const checkKey = key => { if (!/^0x[0-9a-f]{32}0{32}$/i.test(key)) throw Error('Invalid SPHINCS public-key encoding.'); };

  // 45-byte EIP-1167 dispatcher followed by the 64 immutable public-key bytes (SphincsFrameAccountFactory.accountRuntime).
  function accountRuntime(implementation, pkSeed, pkRoot) {
    checkKey(pkSeed); checkKey(pkRoot);
    return ('0x363d3d373d3d3d363d73' + getAddress(implementation).slice(2) + '5af43d82803e903d91602b57fd5bf3'
      + pkSeed.slice(2) + pkRoot.slice(2)).toLowerCase();
  }
  const accountAddress = (config, pkSeed, pkRoot) => getCreate2Address(config.factory, ZeroHash,
    keccak256('0x3d606d80600a3d3981f3' + accountRuntime(config.implementation, pkSeed, pkRoot).slice(2)));

  function sigHash(payload) {
    const canonical = structuredClone(payload);
    for (const witness of canonical[5]) if (witness[2] === '0x') witness[3] = quantity(getBytes(witness[3]).length);
    return keccak256(encode(canonical));
  }

  function prepare({ config, pkSeed, pkRoot, nonce, recipient, value, data = '0x', deployed, maxFee, priorityFee, callGas = 100000n }) {
    if (BigInt(nonce) < 0n || BigInt(value) < 0n || BigInt(priorityFee) < 0n || BigInt(maxFee) <= 0n) throw Error('Invalid transaction quantity.');
    if (BigInt(callGas) < 21000n || BigInt(callGas) > 5000000n) throw Error('Unsupported call gas budget.');
    if (!/^0x(?:[0-9a-f]{2})*$/i.test(data) || getBytes(data).length > 4096) throw Error('Unsupported call data.');
    const sender = accountAddress(config, pkSeed, pkRoot);
    const frames = [];
    if (!deployed) frames.push(['0x', '0x', getAddress(config.factory), [quantity(CREATE_GAS), quantity(CREATE_STATE_GAS)], '0x',
      abi.encodeFunctionData('createAccount', [pkSeed, pkRoot, ZeroHash])]);
    // VERIFY, approving execution and payment (flags 3). The account requires empty calldata in this frame.
    frames.push([quantity(1), quantity(3), sender, [quantity(deployed ? VERIFY_GAS : VERIFY_GAS_FIRST), '0x'], '0x', '0x']);
    frames.push([quantity(2), '0x', getAddress(recipient), [quantity(callGas), quantity(callGas)], quantity(value), data]);
    // One ARBITRARY witness (scheme 0, no signer, empty msg = canonical hash); its bytes are elided from the hash.
    const payload = [quantity(config.chainId), [], quantity(nonce), sender, frames,
      [['0x', '0x', '0x', '0x' + '00'.repeat(SIGNATURE_BYTES)]], [quantity(maxFee), quantity(priorityFee)], []];
    return { payload, digest: sigHash(payload), sender, frameCount: frames.length };
  }

  function signedRequest(prepared, signature) {
    if (getBytes(signature).length !== SIGNATURE_BYTES) throw Error('Unexpected SPHINCS signature length.');
    const payload = structuredClone(prepared.payload);
    payload[5][0][3] = signature;
    if (sigHash(payload) !== prepared.digest) throw Error('Transaction changed after preparation.');
    const raw = encode(payload);
    return { raw, hash: keccak256(raw), method: 'eth_sendRawTransaction', params: [raw] };
  }

  return { abi, quantity, encode, sigHash, accountRuntime, accountAddress, prepare, signedRequest };
}
