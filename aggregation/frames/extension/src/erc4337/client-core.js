import { Interface, getAddress, keccak256 } from 'ethers';
import { ACCOUNT_ABI, ENTRY_POINT_ABI, SIGNATURE_BYTES, accountAddress, accountRuntime,
  buildOperation, isHex, operationHash, packOperation, quantity, receiptOutcome } from './protocol.js';

const verifierAbi = new Interface(['function verify(bytes32,bytes32,bytes32,bytes) view returns(bool)']);
const equal = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

export function createClient({ config, rpc, bundler, now = Date.now }) {
  async function readContract(address, abi, method, args) {
    const result = await rpc('eth_call', [{ to: address, data: abi.encodeFunctionData(method, args) }, 'latest']);
    return abi.decodeFunctionResult(method, result)[0];
  }

  async function verifyNetwork() {
    if (!config.factory || !config.implementation || !config.entryPointCodeHash) {
      throw Error('This wallet build is awaiting deployment of its SPHINCS ERC-4337 factory.');
    }
    const [chain, genesis, endpoints, ...codes] = await Promise.all([
      rpc('eth_chainId'), rpc('eth_getBlockByNumber', ['0x0', false]), bundler('eth_supportedEntryPoints'),
      ...['factory', 'implementation', 'verifier', 'entryPoint'].map(key => rpc('eth_getCode', [config[key], 'latest'])),
    ]);
    if (BigInt(chain) !== BigInt(config.chainId) || !equal(genesis?.hash, config.genesisHash)) throw Error('Unexpected network. Sending is disabled.');
    if (!Array.isArray(endpoints) || !endpoints.some(address => equal(address, config.entryPoint))) throw Error('The bundler does not support this EntryPoint.');
    for (const [index, key] of ['factory', 'implementation', 'verifier', 'entryPoint'].entries()) {
      if (!equal(keccak256(codes[index]), config[key + 'CodeHash'])) throw Error('Unexpected ' + key + ' bytecode. Sending is disabled.');
    }
  }

  async function accountState(key) {
    const address = accountAddress(config, key.backupPkSeed, key.backupPkRoot);
    const [balance, code, nonce, deposit] = await Promise.all([
      rpc('eth_getBalance', [address, 'latest']), rpc('eth_getCode', [address, 'latest']),
      readContract(config.entryPoint, ENTRY_POINT_ABI, 'getNonce', [address, 0]),
      readContract(config.entryPoint, ENTRY_POINT_ABI, 'balanceOf', [address]),
    ]);
    const deployed = code !== '0x';
    if (deployed) {
      if (!equal(code, accountRuntime(config.implementation))) throw Error('Unexpected smart account bytecode.');
      const words = await Promise.all(['pkSeed', 'pkRoot'].map(method => readContract(address, ACCOUNT_ABI, method, [])));
      if (!equal(words[0], key.backupPkSeed) || !equal(words[1], key.backupPkRoot)) throw Error('Smart account public key mismatch.');
    }
    return { address, balance: BigInt(balance), deposit: BigInt(deposit), nonce: BigInt(nonce), deployed };
  }

  async function quoteCall(address, recipient, value = 0n, data = '0x') {
    recipient = getAddress(recipient);
    if (!isHex(data) || BigInt(value) < 0n || data.length > 90002) throw Error('Invalid or unsupported call data.');
    const [block, balance, code, deposit] = await Promise.all([
      rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_getBalance', [address, 'latest']),
      rpc('eth_getCode', [address, 'latest']), readContract(config.entryPoint, ENTRY_POINT_ABI, 'balanceOf', [address]),
    ]);
    if (block?.baseFeePerGas == null) throw Error('Network fee data is unavailable.');
    const priorityFee = 1_000_000_000n;
    const maxFee = BigInt(block.baseFeePerGas) * 2n + priorityFee;
    if (maxFee > 3_000_000_000n) throw Error('Network fees exceed this build’s configured fee cap.');
    // The public RPC intentionally excludes eth_estimateGas. Select a bounded
    // execution budget with read-only calls, then simulate the complete signed
    // EntryPoint operation before submission. The UI shows the maximum reserve.
    let callGas;
    let callError;
    for (const budget of [150_000n, 500_000n, 1_500_000n, 5_000_000n]) {
      try {
        await rpc('eth_call', [{ from: address, to: recipient, value: quantity(value), data,
          gas: quantity(budget - 50_000n) }, 'latest']);
        callGas = budget;
        break;
      } catch (error) {
        if (error.rpcCode == null) throw error;
        callError = error;
      }
    }
    if (callGas == null) throw Error('The call failed simulation within this build’s gas budget: ' + callError.message);
    const callDataBytes = BigInt((ACCOUNT_ABI.encodeFunctionData('execute', [recipient, BigInt(value), data]).length - 2) / 2);
    // A complete SPHINCS signature is needed for validation. Use explicit budgets
    // and simulate the final signed operation; do not estimate with a fake signature.
    const verificationGas = 1_500_000n;
    const preVerificationGas = (BigInt(SIGNATURE_BYTES) + 1280n + callDataBytes) * 40n + 50_000n;
    const reserveGas = verificationGas + callGas + preVerificationGas;
    const feeReserve = reserveGas * maxFee;
    const depositWei = BigInt(deposit);
    const requiredBalance = BigInt(value) + (feeReserve > depositWei ? feeReserve - depositWei : 0n);
    return { maxFee, priorityFee, callGas, verificationGas, preVerificationGas, reserveGas, feeReserve,
      requiredBalance, balance: BigInt(balance), deposit: depositWei, deployed: code !== '0x', blockNumber: block.number };
  }

  async function verifyHash(operation) {
    const local = operationHash(config, operation);
    const onChain = await readContract(config.entryPoint, ENTRY_POINT_ABI, 'getUserOpHash', [packOperation(operation)]);
    if (!equal(local, onChain)) throw Error('EntryPoint UserOperation hash mismatch. No signature was submitted.');
    return local;
  }

  async function prepareCall(key, recipient, value, data = '0x', reviewed) {
    await verifyNetwork();
    const account = await accountState(key);
    const quote = await quoteCall(account.address, recipient, value, data);
    if (reviewed && (quote.feeReserve > BigInt(reviewed.feeReserve) || now() - reviewed.at > 240000)) throw Error('The reviewed fee changed or expired. Review again.');
    if (account.balance < quote.requiredBalance) throw Error('Insufficient test ETH for the call and maximum network fee.');
    const operation = buildOperation({ config, key, nonce: account.nonce, deployed: account.deployed, recipient, value, data, quote });
    return { ...quote, account, key, recipient, value: BigInt(value), data, operation,
      digest: await verifyHash(operation), preparedAt: now() };
  }

  async function submitCall(quote, signed, persist, assertContext = () => {}) {
    assertContext();
    if (now() - quote.preparedAt > 240000) throw Error('Transaction preparation expired.');
    if (!equal(signed.backupPkSeed, quote.key.backupPkSeed) || !equal(signed.backupPkRoot, quote.key.backupPkRoot)) throw Error('Signing key changed.');
    if (!isHex(signed.signature) || signed.signature.length !== 2 + SIGNATURE_BYTES * 2) throw Error('Invalid SPHINCS signature length.');
    await verifyNetwork();
    const account = await accountState(quote.key);
    if (account.nonce !== quote.account.nonce || account.deployed !== quote.account.deployed) throw Error('Account state changed. Review again.');
    const requiredBalance = quote.value + (quote.feeReserve > account.deposit ? quote.feeReserve - account.deposit : 0n);
    if (account.balance < requiredBalance) throw Error('Insufficient test ETH.');
    const operation = { ...quote.operation, signature: signed.signature };
    const hash = await verifyHash(operation);
    if (!equal(hash, quote.digest)) throw Error('Prepared UserOperation changed.');
    const valid = await readContract(config.verifier, verifierAbi, 'verify', [quote.key.backupPkSeed, quote.key.backupPkRoot, hash, signed.signature]);
    if (!valid) throw Error('The configured verifier rejected the signature.');
    // eth_call executes the full EntryPoint path without persisting state.
    await rpc('eth_call', [{ to: config.entryPoint, gas: quantity(quote.reserveGas + 1_000_000n),
      data: ENTRY_POINT_ABI.encodeFunctionData('handleOps', [[packOperation(operation)], account.address]) }, 'latest']);
    const record = { userOpHash: hash, sender: account.address, recipient: quote.recipient, value: quote.value.toString(),
      nonce: account.nonce.toString(), status: 'pending', createdAt: now(), entryPoint: config.entryPoint, startBlock: quote.blockNumber };
    await persist(record);
    try { assertContext(); }
    catch (error) {
      // The journal exists, but the transport has not been called. Preserve
      // that distinction so a locked or switched wallet is not left pending.
      await persist({ ...record, status: 'rejected', message: 'Not submitted: ' + error.message });
      error.submissionRejected = true;
      throw error;
    }
    try {
      const returned = await bundler('eth_sendUserOperation', [operation, config.entryPoint]);
      if (!equal(returned, hash)) throw Error('Unexpected bundler operation hash.');
    } catch (error) {
      if (error.rpcCode != null) {
        await persist({ ...record, status: 'rejected', message: error.message });
        error.submissionRejected = true;
        throw error;
      }
      record.message = 'Submission outcome is uncertain. Check this UserOperation before sending again.';
      await persist(record);
    }
    return record;
  }

  async function refreshRecord(record) {
    if (record.status === 'rejected') return record;
    const result = await bundler('eth_getUserOperationReceipt', [record.userOpHash]);
    if (!result) return record;
    if (!equal(result.userOpHash, record.userOpHash) || !equal(result.sender, record.sender) || !equal(result.entryPoint, config.entryPoint)) {
      throw Error('Unexpected bundler receipt identity.');
    }
    const transactionHash = result.receipt?.transactionHash;
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash || '')) throw Error('Missing inclusion transaction hash.');
    const receipt = await rpc('eth_getTransactionReceipt', [transactionHash]);
    if (!receipt) return record;
    if (!equal(receipt.transactionHash, transactionHash)) throw Error('Unexpected transaction receipt hash.');
    return { ...record, ...receiptOutcome(receipt, record.userOpHash, record.sender, config.entryPoint) };
  }

  return { verifyNetwork, accountState, quoteCall, prepareCall, submitCall, refreshRecord };
}
