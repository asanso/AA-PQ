import { createNativeProtocol, CREATE_GAS, CREATE_STATE_GAS, VERIFY_GAS, SIGNATURE_BYTES } from './native-protocol.mjs';

// Transport adapter for native leanSPHINCS frame accounts, driven by the send path, journal and activity poller.
// The caller supplies HTTPS transport and the frame-receipt parser. A key is { publicKey }: PK.seed || PK.root.
export function createNativeClient(e, { config: input, rpc, receiptOutcome, now = Date.now }) {
  const config = Object.freeze({ ...input });
  const p = createNativeProtocol(e);
  const hash = /^0x[0-9a-f]{64}$/i;
  if (config.eip8288Format !== 'eip8288-lean') throw Error('Native frame accounts require the eip8288-lean envelope.');
  for (const field of ['genesisHash', 'factoryCodeHash', 'implementationCodeHash', 'verifierCodeHash']) {
    if (!hash.test(config[field] ?? '')) throw Error('Missing pinned network or contract identity.');
  }
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw Error('Missing pinned network or contract identity.');
  e.getAddress(config.factory); e.getAddress(config.implementation); e.getAddress(config.verifier);
  if (BigInt(config.maxFeePerGas ?? 0) <= 0n) throw Error('A fee ceiling is required.');
  if (typeof rpc !== 'function' || typeof receiptOutcome !== 'function') throw Error('Transport and receipt parser are required.');
  // A JSON-RPC error answering the submission itself proves it was not admitted, except
  // internal errors, timeouts, 5xx replies other than 503 and errors a transaction already holding the nonce could cause.
  const submit = (method, params) => rpc(method, params).catch(error => { error.submission = true; throw error; });
  const rejected = error => error?.submission === true && Number.isInteger(error.rpcCode) && ![-32603, -32016].includes(error.rpcCode)
    && !(error.httpStatus >= 500 && error.httpStatus !== 503)
    && !/already ?known|timed out|nonce|replace|underpriced/i.test(error.message ?? '');

  async function verifyNetwork() {
    const [chain, genesis, factoryCode, implementationCode, verifierCode, implementation, verifier] = await Promise.all([
      rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]),
      rpc('eth_getCode', [config.factory, 'latest']), rpc('eth_getCode', [config.implementation, 'latest']),
      rpc('eth_getCode', [config.verifier, 'latest']),
      rpc('eth_call', [{ to: config.factory, data: p.abi.encodeFunctionData('ACCOUNT_IMPL') }, 'latest']),
      rpc('eth_call', [{ to: config.factory, data: p.abi.encodeFunctionData('LEAN_SPHINCS_VERIFIER') }, 'latest']),
    ]);
    if (BigInt(chain) !== BigInt(config.chainId) || genesis?.hash !== config.genesisHash) throw Error('Unexpected network. Sending is disabled.');
    if (e.keccak256(factoryCode) !== config.factoryCodeHash || e.keccak256(implementationCode) !== config.implementationCodeHash
        || e.keccak256(verifierCode) !== config.verifierCodeHash
        || e.getAddress(p.abi.decodeFunctionResult('ACCOUNT_IMPL', implementation)[0]) !== e.getAddress(config.implementation)
        || e.getAddress(p.abi.decodeFunctionResult('LEAN_SPHINCS_VERIFIER', verifier)[0]) !== e.getAddress(config.verifier))
      throw Error('Contract identity does not match this wallet build. Sending is disabled.');
  }

  async function accountState(key) {
    const address = p.accountAddress(config, key.publicKey);
    const [balance, nonce, code] = await Promise.all([
      rpc('eth_getBalance', [address, 'latest']), rpc('eth_getTransactionCount', [address, 'pending']),
      rpc('eth_getCode', [address, 'latest']),
    ]);
    const deployed = code !== '0x';
    if (deployed && code.toLowerCase() !== p.accountRuntime(config.implementation, key.publicKey))
      throw Error('Unexpected account bytecode.');
    return { address, deployed, nonce: BigInt(nonce), balance: BigInt(balance) };
  }

  async function quoteCall(address, recipient, value = 0n, data = '0x') {
    e.getAddress(address); recipient = e.getAddress(recipient);
    if (BigInt(value) < 0n || e.getBytes(data).length > 4096) throw Error('Unsupported call data or value.');
    const [block, balance, code] = await Promise.all([
      rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBalance', [address, 'latest']), rpc('eth_getCode', [address, 'latest']),
    ]);
    if (block?.baseFeePerGas == null) throw Error('The current base fee is unavailable.');
    const priorityFee = 1000000000n, maxFee = BigInt(block.baseFeePerGas) * 2n + priorityFee;
    if (maxFee > BigInt(config.maxFeePerGas)) throw Error('Network fees exceed this build’s fee ceiling.');
    const estimate = BigInt(await rpc('eth_estimateGas', [{ from: address, to: recipient, value: e.toQuantity(value), data }]));
    const callGas = estimate * 3n / 2n > 100000n ? estimate * 3n / 2n : 100000n;
    if (callGas > 5000000n) throw Error('Contract call exceeds the supported gas budget.');
    const deployed = code !== '0x';
    // Every frame limit, plus intrinsic gas for the witness and calldata: a conservative reservation, not a measurement.
    const reserveGas = (deployed ? VERIFY_GAS : CREATE_GAS + CREATE_STATE_GAS + VERIFY_GAS) + callGas * 2n
      + 100000n + BigInt(SIGNATURE_BYTES + e.getBytes(data).length) * 16n;
    return { maxFee, priorityFee, callGas, reserveGas, feeReserve: reserveGas * maxFee, balance: BigInt(balance), deployed };
  }

  async function prepareCall(key, recipient, value, data = '0x', reviewed) {
    await verifyNetwork();
    const account = await accountState(key);
    const quote = await quoteCall(account.address, recipient, value, data);
    if (reviewed && (quote.feeReserve > BigInt(reviewed.feeReserve) || now() - reviewed.at > 240000))
      throw Error('The reviewed fee changed or expired. Review this transaction again.');
    if (account.balance < BigInt(value) + quote.feeReserve) throw Error('Insufficient test ETH for the call and fee reservation.');
    // max_fee is the total fee budget: the reviewed reservation, which covers the transaction's maximum gas.
    const payload = p.prepare({ config, publicKey: key.publicKey, nonce: account.nonce,
      recipient, value, data, deployed: account.deployed, maxFee: quote.feeReserve, priorityFee: quote.priorityFee, callGas: quote.callGas });
    if (payload.sender !== account.address) throw Error('Account derivation mismatch.');
    return { ...quote, account, key: { ...key }, recipient: e.getAddress(recipient), value: BigInt(value), data,
      payload, digest: payload.digest, preparedAt: now() };
  }

  async function submitCall(quote, signed, persist, assertContext = () => {}) {
    assertContext();
    if (typeof persist !== 'function') throw Error('A durable transaction journal is required.');
    if (now() - quote.preparedAt > 240000) throw Error('Transaction preparation expired.');
    if (signed.publicKey?.toLowerCase() !== quote.key.publicKey?.toLowerCase()) throw Error('Signing key changed.');
    const request = p.signedRequest(quote.payload, signed.signature);
    await verifyNetwork();
    const current = await accountState(quote.key);
    if (current.nonce !== quote.account.nonce || current.deployed !== quote.account.deployed)
      throw Error('Account state changed. Review again.');
    if (current.balance < quote.value + quote.feeReserve) throw Error('Insufficient balance.');
    const record = { hash: request.hash, sender: current.address, recipient: quote.recipient, value: quote.value.toString(),
      nonce: current.nonce.toString(), frameCount: quote.payload.frameCount, status: 'pending', createdAt: now(),
      raw: request.raw, protocol: 'native' };
    await persist(record);
    assertContext();
    try {
      const result = await submit(request.method, request.params);
      if (typeof result !== 'string' || result.toLowerCase() !== request.hash.toLowerCase()) throw Error('Unexpected RPC transaction hash.');
    } catch (error) {
      if (rejected(error)) Object.assign(record, { status: 'failed', rejected: true, message: 'The network rejected this transaction: ' + error.message });
      else record.message = 'Submission outcome is uncertain. Check this transaction hash before sending again.';
      await persist(record);
    }
    return record;
  }

  async function refreshRecord(record) {
    const result = receiptOutcome(await rpc('eth_getTransactionReceipt', [record.hash]), record.hash, record.frameCount);
    return result.status === 'pending' ? record : { ...record, ...result };
  }
  // Resolved only by its receipt or by its nonce being used in a finalized block. A re-send
  // carries the identical signed bytes and its own errors prove nothing about the first copy.
  async function recoverRecord(record, { rebroadcast = false } = {}) {
    if (record.rejected) return { ...record, status: 'failed' };
    const finalized = await rpc('eth_getTransactionCount', [record.sender, 'finalized']).catch(() => null);
    const result = await refreshRecord(record);
    if (result.status !== 'pending') return result;
    if (finalized != null && BigInt(finalized) > BigInt(record.nonce))
      return { ...record, status: 'failed', rejected: true, message: 'Not included: another transaction used its nonce.' };
    if (!rebroadcast || !record.raw || e.keccak256(record.raw) !== record.hash.toLowerCase()) return record;
    await rpc('eth_sendRawTransaction', [record.raw]).catch(() => {});
    return record;
  }
  return { config, rpc, verifyNetwork, accountState, quoteCall, prepareCall, submitCall, refreshRecord, recoverRecord, accountAddress: p.accountAddress };
}
