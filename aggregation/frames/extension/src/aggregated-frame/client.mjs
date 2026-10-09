import { createProtocol } from './protocol.mjs';

// Transport adapter for a separately configured experimental wallet build.
// The caller supplies HTTPS transport and the existing frame-receipt parser.
export function createClient(e, { config: input, rpc, receiptOutcome, now = Date.now,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const p = createProtocol(e);
  const config = Object.freeze({ ...input });
  const hash = /^0x[0-9a-f]{64}$/i;
  for (const field of ['genesisHash', 'factoryCodeHash', 'implementationCodeHash']) {
    if (!hash.test(config[field] ?? '')) throw Error('Missing pinned network or contract identity.');
  }
  e.getAddress(config.factory); e.getAddress(config.implementation);
  if (config.profile !== p.domain || e.keccak256(p.implementationRuntime()) !== config.implementationCodeHash)
    throw Error('Unsupported account profile.');
  if (BigInt(config.maxFeePerGas ?? 0) <= 0n) throw Error('A fee ceiling is required.');
  if (typeof rpc !== 'function' || typeof receiptOutcome !== 'function') throw Error('Transport and receipt parser are required.');

  async function verifyNetwork() {
    const [chain, genesis, factoryCode, implementationCode, implementation] = await Promise.all([
      rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]),
      rpc('eth_getCode', [config.factory, 'latest']), rpc('eth_getCode', [config.implementation, 'latest']),
      rpc('eth_call', [{ to: config.factory, data: p.abi.encodeFunctionData('ACCOUNT_IMPL') }, 'latest']),
    ]);
    if (BigInt(chain) !== 1337n || genesis?.hash !== config.genesisHash) throw Error('Unexpected network. Sending is disabled.');
    if (e.keccak256(factoryCode) !== config.factoryCodeHash || e.keccak256(implementationCode) !== config.implementationCodeHash
        || e.getAddress(p.abi.decodeFunctionResult('ACCOUNT_IMPL', implementation)[0]) !== e.getAddress(config.implementation))
      throw Error('Contract identity does not match this wallet build. Sending is disabled.');
    try { await rpc('eth_getProofWrapper'); }
    catch (error) {
      if (error.rpcCode !== -32000 || error.message !== 'Proof wrapper is not ready; retry after the next background cycle.') throw error;
    }
  }

  async function accountState(key) {
    const address = p.accountAddress(config, key.backupPkSeed, key.backupPkRoot);
    const [balance, nonce, code] = await Promise.all([
      rpc('eth_getBalance', [address, 'latest']), rpc('eth_getTransactionCount', [address, 'pending']),
      rpc('eth_getCode', [address, 'latest']),
    ]);
    const deployed = code !== '0x';
    if (deployed && code.toLowerCase() !== p.cloneRuntime(config.implementation, p.keyHash(key.backupPkSeed, key.backupPkRoot)).toLowerCase())
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
    const callGas = estimate * 3n / 2n > 250000n ? estimate * 3n / 2n : 250000n;
    if (callGas > 5000000n) throw Error('Contract call exceeds the supported gas budget.');
    // Conservative reservation, not a measurement of proof verification or final gas.
    const reserveGas = 3000000n + callGas * 2n + BigInt(e.getBytes(data).length) * 40n;
    return { maxFee, priorityFee, callGas, reserveGas, feeReserve: reserveGas * maxFee, balance: BigInt(balance), deployed: code !== '0x' };
  }

  async function prepareCall(key, recipient, value, data = '0x', reviewed) {
    await verifyNetwork();
    const account = await accountState(key);
    const quote = await quoteCall(account.address, recipient, value, data);
    if (reviewed && (quote.feeReserve > BigInt(reviewed.feeReserve) || now() - reviewed.at > 240000))
      throw Error('The reviewed fee changed or expired. Review this transaction again.');
    if (account.balance < BigInt(value) + quote.feeReserve) throw Error('Insufficient test ETH for the call and fee reservation.');
    const payload = p.prepare({ config, pkSeed: key.backupPkSeed, pkRoot: key.backupPkRoot, nonce: account.nonce,
      recipient, value, data, deployed: account.deployed, maxFee: quote.maxFee, priorityFee: quote.priorityFee,
      callGas: quote.callGas, stateGas: quote.callGas });
    return { ...quote, account, key: { ...key }, recipient: e.getAddress(recipient), value: BigInt(value), data,
      payload, digest: payload.digest, preparedAt: now() };
  }

  async function submitCall(quote, signed, persist, assertContext = () => {}) {
    assertContext();
    if (typeof persist !== 'function') throw Error('A durable transaction journal is required.');
    if (now() - quote.preparedAt > 240000) throw Error('Transaction preparation expired.');
    if (signed.backupPkSeed !== quote.key.backupPkSeed || signed.backupPkRoot !== quote.key.backupPkRoot)
      throw Error('Signing key changed.');
    const request = p.signedRequest(quote.payload, signed.signature);
    await verifyNetwork();
    const current = await accountState(quote.key);
    if (current.nonce !== quote.account.nonce || current.deployed !== quote.account.deployed)
      throw Error('Account state changed. Review again.');
    if (current.balance < quote.value + quote.feeReserve) throw Error('Insufficient balance.');
    const record = { hash: request.hash, sender: current.address, recipient: quote.recipient, value: quote.value.toString(),
      nonce: current.nonce.toString(), frameCount: quote.payload.transaction.frames.length, status: 'pending', createdAt: now() };
    await persist(record);
    assertContext();
    try {
      let hashes;
      try {
        hashes = await rpc(request.method, request.params);
      } catch (error) {
        // Rejected hashes remain cached until canonical progress. Retry identical bytes once.
        // Transport failures and all other validation errors remain uncertain.
        if (error.rpcCode !== -32000 || error.message !==
            'frame transaction validation-prefix simulation failed, validation-prefix simulation timed out') throw error;
        const rejectedHead = await rpc('eth_blockNumber');
        if (!/^0x[0-9a-f]+$/i.test(rejectedHead ?? '')) throw Error('Current block is unavailable.');
        let advanced = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          await delay(500);
          assertContext();
          if (now() - quote.preparedAt > 240000) throw Error('Transaction preparation expired.');
          const head = await rpc('eth_blockNumber');
          if (!/^0x[0-9a-f]+$/i.test(head ?? '')) throw Error('Current block is unavailable.');
          if (BigInt(head) > BigInt(rejectedHead)) { advanced = true; break; }
        }
        if (!advanced) throw Error('Admission retry requires a new block.');
        hashes = await rpc(request.method, request.params);
      }
      if (!Array.isArray(hashes) || hashes.length !== 1 || hashes[0]?.toLowerCase() !== request.hash.toLowerCase())
        throw Error('Unexpected RPC transaction hash.');
    } catch {
      record.message = 'Submission outcome is uncertain. Check this transaction hash before sending again.';
      await persist(record);
    }
    return record;
  }

  async function refreshRecord(record) {
    const result = receiptOutcome(await rpc('eth_getTransactionReceipt', [record.hash]), record.hash, record.frameCount);
    return result.status === 'pending' ? record : { ...record, ...result };
  }
  return { config, rpc, verifyNetwork, accountState, quoteCall, prepareCall, submitCall, refreshRecord, accountAddress: p.accountAddress };
}
