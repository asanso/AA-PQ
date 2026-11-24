// Deploys LeanSphincsVerifier and LeanSphincsFrameAccountFactory (which creates the account implementation) on a
// network with native frame transactions, checks every runtime against the pinned and compiled code, and writes the
// wallet's native frame profile.
//
//   node scripts/deploy-lean-sphincs.mjs --write-artifacts <file>
//       Compiles the contracts (Solidity 0.8.28, via IR, optimizer 200, Cancun) into an artifacts file, so a host
//       without the compiler can deploy them.
//   node scripts/deploy-lean-sphincs.mjs --rpc <url> --key-file <file> --out <profile.json>
//       [--artifacts <file>] [--ethers <package.json that depends on ethers>] [--max-fee-per-gas <wei>] [--dry-run]
//
// The key file holds the deployer's private key; the script never prints it. --dry-run estimates the two deployments
// without sending them. An existing --out file is never overwritten.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const VERIFIER_CODE_HASH = '0xcb1899cf8beccc7a966a04de3bdff0f24a4b32d6368fcfbb8c4d139b10b17aa9';
const CONTRACTS = ['LeanSphincsVerifier', 'LeanSphincsFrameRuntime', 'LeanSphincsFrameAccount', 'LeanSphincsFrameAccountFactory'];
const here = new URL('../', import.meta.url);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (!name.startsWith('--')) throw Error('Unexpected argument: ' + name);
  args[name.slice(2)] = name === '--dry-run' ? true : process.argv[++i];
}
const e = createRequire(args.ethers ?? fileURLToPath(new URL('package.json', here)))('ethers');

function compile() {
  const solc = createRequire(fileURLToPath(new URL('package.json', here)))('solc');
  assert.match(solc.version(), /^0\.8\.28\+/);
  const sources = Object.fromEntries(CONTRACTS.map(name =>
    [`${name}.sol`, { content: readFileSync(new URL(`contracts/${name}.sol`, here), 'utf8') }]));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } })));
  for (const error of out.errors ?? []) if (error.severity === 'error') throw Error(error.formattedMessage);
  const pick = name => { const c = out.contracts[`${name}.sol`][name];
    return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object }; };
  return { compiler: solc.version(), verifier: pick('LeanSphincsVerifier'), factory: pick('LeanSphincsFrameAccountFactory'),
    runtimeSource: readFileSync(new URL('contracts/LeanSphincsFrameRuntime.sol', here), 'utf8') };
}

// The implementation runtime LeanSphincsFrameRuntime.build(verifier) returns: two generated pieces around the address.
function implementationRuntime(runtimeSource, verifier) {
  const pieces = [...runtimeSource.matchAll(/hex"([0-9a-f]+)"/g)].map(match => match[1]);
  assert.equal(pieces.length, 2, 'unexpected LeanSphincsFrameRuntime source');
  return '0x' + pieces[0] + verifier.slice(2).toLowerCase() + pieces[1];
}

function checkArtifacts(artifacts) {
  assert.equal(e.keccak256(artifacts.verifier.deployedBytecode), VERIFIER_CODE_HASH,
    'the verifier does not compile to the runtime the account and factory pin');
  for (const part of ['verifier', 'factory']) assert.match(artifacts[part].bytecode, /^0x[0-9a-f]+$/);
  return artifacts;
}

if (args['write-artifacts']) {
  if (existsSync(args['write-artifacts'])) throw Error('Refusing to overwrite ' + args['write-artifacts']);
  const artifacts = checkArtifacts(compile());
  writeFileSync(args['write-artifacts'], JSON.stringify(artifacts, null, 2) + '\n');
  console.log(JSON.stringify({ wrote: args['write-artifacts'], compiler: artifacts.compiler,
    verifierCreationHash: e.keccak256(artifacts.verifier.bytecode), factoryCreationHash: e.keccak256(artifacts.factory.bytecode),
    verifierRuntimeHash: e.keccak256(artifacts.verifier.deployedBytecode) }, null, 2));
  process.exit(0);
}

for (const name of ['rpc', 'key-file', 'out']) if (!args[name]) throw Error('Missing --' + name);
if (existsSync(args.out)) throw Error('Refusing to overwrite ' + args.out);
const artifacts = checkArtifacts(args.artifacts ? JSON.parse(readFileSync(args.artifacts, 'utf8')) : compile());
const maxFeePerGas = BigInt(args['max-fee-per-gas'] ?? '100000000000');
const provider = new e.JsonRpcProvider(args.rpc, undefined, { batchMaxCount: 1, staticNetwork: true, cacheTimeout: -1 });
const key = readFileSync(args['key-file'], 'utf8').trim();
const deployer = new e.Wallet(key.startsWith('0x') ? key : '0x' + key, provider);
const [network, genesis, balance, nonce, latest] = await Promise.all([provider.getNetwork(), provider.getBlock(0),
  provider.getBalance(deployer.address), provider.getTransactionCount(deployer.address, 'pending'), provider.getBlock('latest')]);
const chainId = Number(network.chainId);
const verifierFactory = new e.ContractFactory(artifacts.verifier.abi, artifacts.verifier.bytecode, deployer);
const accountFactory = new e.ContractFactory(artifacts.factory.abi, artifacts.factory.bytecode, deployer);
const predicted = { verifier: e.getCreateAddress({ from: deployer.address, nonce }), factory: e.getCreateAddress({ from: deployer.address, nonce: nonce + 1 }) };
const estimate = {
  verifier: await provider.estimateGas(await verifierFactory.getDeployTransaction()),
  factory: await provider.estimateGas({ ...(await accountFactory.getDeployTransaction(predicted.verifier)), from: deployer.address }).catch(() => null),
};
const summary = { chainId, genesisHash: genesis.hash, deployer: deployer.address, balanceWei: balance.toString(), nonce,
  baseFeePerGas: latest.baseFeePerGas?.toString() ?? null, predicted,
  estimatedGas: { verifier: estimate.verifier.toString(), factory: estimate.factory?.toString() ?? 'after the verifier exists' } };
if (args['dry-run']) { console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2)); process.exit(0); }

// Explicit nonces: the contracts land at the predicted addresses or not at all.
const fees = { maxFeePerGas, maxPriorityFeePerGas: 1000000000n < maxFeePerGas ? 1000000000n : maxFeePerGas };
const deployed = async (factory, constructorArgs, txNonce, expected) => {
  const contract = await factory.deploy(...constructorArgs, { ...fees, nonce: txNonce });
  const receipt = await contract.deploymentTransaction().wait();
  assert.equal(receipt.status, 1);
  assert.equal(await contract.getAddress(), expected);
  return { contract, address: expected, hash: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
};
const verifier = await deployed(verifierFactory, [], nonce, predicted.verifier);
const factory = await deployed(accountFactory, [verifier.address], nonce + 1, predicted.factory);
const implementation = await factory.contract.ACCOUNT_IMPL();
const code = async address => provider.getCode(address);
assert.equal(e.keccak256(await code(verifier.address)), VERIFIER_CODE_HASH, 'deployed verifier runtime differs');
// The factory runtime embeds its immutables (verifier and implementation), so it is identified by them.
assert.equal(e.getAddress(await factory.contract.LEAN_SPHINCS_VERIFIER()), e.getAddress(verifier.address), 'factory verifier differs');
assert.equal(await factory.contract.VERIFIER_CODE_HASH(), VERIFIER_CODE_HASH, 'factory pins another verifier');
assert.equal(await code(implementation), implementationRuntime(artifacts.runtimeSource, verifier.address), 'implementation runtime differs');
const profile = { active: true, chainId, genesisHash: genesis.hash, eip8288Format: 'eip8288-lean', maxFeePerGas: maxFeePerGas.toString(),
  factory: factory.address, factoryCodeHash: e.keccak256(await code(factory.address)),
  implementation, implementationCodeHash: e.keccak256(await code(implementation)),
  verifier: verifier.address, verifierCodeHash: VERIFIER_CODE_HASH,
  deployment: { deployer: deployer.address, verifierTransaction: verifier.hash, factoryTransaction: factory.hash,
    blocks: [verifier.block, factory.block], gasUsed: { verifier: verifier.gasUsed, factory: factory.gasUsed } } };
writeFileSync(args.out, JSON.stringify(profile, null, 2) + '\n');
// The portal, gateway and explorer profile fields for these contracts.
console.log(JSON.stringify({ wrote: args.out, ...profile, networkProfileFields: { nativeAccountScheme: 'lean-sphincs',
  nativeFactory: factory.address, nativeImplementation: implementation, nativeImplementationCodeHash: profile.implementationCodeHash,
  nativeVerifier: verifier.address, nativeVerifierCodeHash: VERIFIER_CODE_HASH } }, null, 2));
