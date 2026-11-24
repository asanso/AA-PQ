import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { AbiCoder, ContractFactory, Interface, getBytes, hexlify, keccak256 } from 'ethers';
import { createLeanSphincs, parseVector, SIGNATURE_LEN } from './leansphincs-reference.mjs';
import { compile, startAnvil } from './local-chain.mjs';

const vectors = new URL('fixtures/leansphincs-ethlib/verify/', import.meta.url);
const names = readFileSync(new URL('../SHA256SUMS', vectors), 'utf8').split('\n')
  .map(line => /^[0-9a-f]{64}\s+\.?\/?verify\/([a-z_]+)\/data\.yaml$/.exec(line)?.[1]).filter(Boolean);
const cases = names.map(name => ({ name, ...parseVector(readFileSync(new URL(`${name}/data.yaml`, vectors), 'utf8')) }));
const reference = createLeanSphincs(bytes => getBytes(keccak256(bytes)));
const valid = cases.filter(({ output }) => output === true);
// The generated, gas-optimised verifier and the readable reference must agree on every input.
const NAMES = ['LeanSphincsVerifier', 'LeanSphincsVerifierReference'];
let chain, provider, artifacts, abi;
const verifiers = {};

before(async () => {
  artifacts = compile(NAMES);
  abi = new Interface(artifacts('LeanSphincsVerifier').abi);
  chain = await startAnvil();
  provider = chain.provider;
  const signer = await provider.getSigner(0);
  for (const name of NAMES) {
    const artifact = artifacts(name);
    assert.deepEqual(new Interface(artifact.abi).format(true), abi.format(true), name);
    verifiers[name] = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy();
    await verifiers[name].waitForDeployment();
  }
}, { timeout: 30000 });

after(async () => { await chain?.stop(); });

const callOn = async (name, publicKey, message, signature) => {
  const data = abi.encodeFunctionData('verify', [publicKey, message, signature]);
  return provider.send('eth_call', [{ to: await verifiers[name].getAddress(), data }, 'latest']);
};
const verifyOn = async (name, ...args) => abi.decodeFunctionResult('verify', await callOn(name, ...args))[0];

test('every EthLib verify vector gives its output', async () => {
  assert.equal(cases.length, 26);
  for (const { name, input, output } of cases) {
    const sizes = [input.public_key, input.message].map(value => getBytes(value).length);
    if (output === null && sizes.some(size => size !== 32)) {
      // A public key or message of another length has no bytes32 encoding, so it cannot reach the verifier.
      assert.throws(() => AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [input.public_key, input.message]), name);
    } else if (output === null) {
      for (const contract of NAMES)
        await assert.rejects(callOn(contract, input.public_key, input.message, input.signature), /InvalidSignatureLength|revert/i, `${contract} ${name}`);
      assert.notEqual(getBytes(input.signature).length, SIGNATURE_LEN, name);
    } else {
      for (const contract of NAMES)
        assert.equal(await verifyOn(contract, input.public_key, input.message, input.signature), output, `${contract} ${name}`);
    }
  }
});

test('flipping any one of a spread of signature, key and message bits invalidates a valid signature', async () => {
  // Deterministic positions across every field of the signature, plus the public key and the message.
  const { input } = valid[0];
  const signature = getBytes(input.signature), publicKey = getBytes(input.public_key), message = getBytes(input.message);
  const positions = [0, 15, 16, 31, 191, 4239, 4240, 4243, 4244, 5267, 5268, 5395, 5396, 5399, 6551, 6552, 6555, 6556, 7579, 7580, 7739];
  for (let at = 0; at < SIGNATURE_LEN; at += 97) positions.push(at);
  for (const at of positions) {
    for (const bit of [0, 7]) {
      const changed = signature.slice(); changed[at] ^= 1 << bit;
      assert.equal(reference(publicKey, message, changed), false, `reference byte ${at} bit ${bit}`);
      for (const contract of NAMES)
        assert.equal(await verifyOn(contract, input.public_key, input.message, hexlify(changed)), false, `${contract} byte ${at} bit ${bit}`);
    }
  }
  for (const [label, bytes] of [['public key', publicKey], ['message', message]]) {
    for (const at of [0, 15, 16, 31]) {
      const changed = bytes.slice(); changed[at] ^= 0x80;
      const args = label === 'message' ? [input.public_key, hexlify(changed)] : [hexlify(changed), input.message];
      for (const contract of NAMES)
        assert.equal(await verifyOn(contract, ...args, input.signature), false, `${contract} ${label} byte ${at}`);
    }
  }
});

test('the generated verifier fits the EIP-170 code size limit and keeps a VERIFY frame within 100,000 gas', async () => {
  const runtime = getBytes('0x' + artifacts('LeanSphincsVerifier').evm.deployedBytecode.object);
  console.log(`LeanSphincsVerifier runtime: ${runtime.length} bytes`);
  assert.ok(runtime.length <= 24_576, `${runtime.length} bytes`);
  for (const { name, input } of valid) {
    const data = abi.encodeFunctionData('verify', [input.public_key, input.message, input.signature]);
    // Cancun intrinsic cost of this external call. A frame account calls the verifier internally, so its VERIFY
    // frame pays only the execution part, plus the account's own code, the witness copy and the call.
    const calldata = getBytes(data).reduce((sum, byte) => sum + (byte ? 16n : 4n), 0n);
    const execution = {};
    for (const contract of NAMES) {
      const total = BigInt(await provider.send('eth_estimateGas', [{ to: await verifiers[contract].getAddress(), data }]));
      execution[contract] = total - 21_000n - calldata;
    }
    console.log(`${name}: ${execution.LeanSphincsVerifier} execution gas (readable reference ${execution.LeanSphincsVerifierReference})`);
    // The wallet gives the VERIFY frame 100,000 gas (EIP-8141 draft MAX_VERIFY_GAS); keep room for the account's part.
    assert.ok(execution.LeanSphincsVerifier < 85_000n, `${name} used ${execution.LeanSphincsVerifier}`);
    assert.ok(execution.LeanSphincsVerifierReference < 500_000n, `${name} reference used ${execution.LeanSphincsVerifierReference}`);
  }
});
