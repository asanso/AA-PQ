// Deploys the eip8288-lean aggregate account factory on a local daisugi-devnet run and writes the
// AA-PQ server network profile and the wallet build profile for it.
// Usage: node scripts/local-devnet/deploy-lean-factory.mjs <devnet run dir> [rpc url]
// Writes <run dir>/aa-pq/{network-profile.json,wallet-profile.json}. Disposable devnets only: the deployer is the
// run's first premined account, derived from <run dir>/mnemonic.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const [run, rpcUrl = 'http://127.0.0.1:28545'] = process.argv.slice(2);
if (!run) throw Error('Usage: deploy-lean-factory.mjs <devnet run dir> [rpc url]');
const e = createRequire(join(repo, 'frontend/package.json'))('ethers');
const solc = createRequire(join(repo, 'frame-account/package.json'))('solc');
const { createProtocol } = await import(join(repo, 'aggregation/frames/wallet/protocol.mjs'));

// The lean account domain and runtime this checkout must produce (AA-PQ A2, eip8288-lean.v2 domain).
const LEAN_DOMAIN = '0xf85581336272cf62a5b94ecfef7281f771727d40ba797c1780191b82537e0768';
const LEAN_RUNTIME_HASH = '0x0b882e19e2b9d99498fec4d6c7df7d308c190b5e73a4ffd2542d0aef1d11b467';
const LEAN_FACTORY_CREATION_HASH = '0x20b2c6800593acfdccbd46aa34420792b734993e1ca4d4867971194f30315462';

const p = createProtocol(e, 'eip8288-lean');
assert.equal(p.domain, LEAN_DOMAIN, 'unexpected lean account domain');
assert.equal(e.keccak256(p.implementationRuntime()), LEAN_RUNTIME_HASH, 'unexpected lean runtime');
const name = 'SphincsAggregateAccountFactory.sol';
const input = { language: 'Solidity', sources: {
  [name]: { content: readFileSync(join(repo, 'aggregation/frames/wallet/contracts', name), 'utf8') },
  'AggregateAccountRuntime.sol': { content: `// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\nlibrary AggregateAccountRuntime { function build() internal pure returns(bytes memory) { return hex"${p.implementationRuntime().slice(2)}"; } }\n` },
}, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
assert.match(solc.version(), /^0\.8\.28\+/);
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
for (const error of compiled.errors ?? []) if (error.severity === 'error') throw Error(error.formattedMessage);
const factory = compiled.contracts[name].SphincsAggregateAccountFactory;
assert.equal(e.keccak256('0x' + factory.evm.bytecode.object), LEAN_FACTORY_CREATION_HASH, 'unexpected factory creation code');

// The run directory holds a mnemonic, validator keys and a TLS key: keep it out of the repository.
if ((realpathSync(run) + sep).startsWith(realpathSync(repo) + sep)) throw Error('Put the devnet run directory outside the repository.');
const params = JSON.parse(readFileSync(join(run, 'params.json'), 'utf8'));
// Shared networks (gen-genesis.sh without LOCAL=1) keep operator credentials off this host; never deploy from here.
if (params.local === false) throw Error('This is a shared-network run; deploy with the operators\' credentials, not this script.');
const provider = new e.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
assert.equal(BigInt((await provider.getNetwork()).chainId), BigInt(params.chainId), 'RPC chain differs from params.json');
assert.equal((await provider.getBlock(0)).hash, params.elGenesisHash, 'RPC genesis differs from params.json');
const deployer = e.HDNodeWallet.fromPhrase(readFileSync(join(run, 'mnemonic'), 'utf8').trim(), undefined, "m/44'/60'/0'/0/0").connect(provider);
const contract = await new e.ContractFactory(factory.abi, factory.evm.bytecode.object, deployer).deploy();
const receipt = await contract.deploymentTransaction().wait();
const address = await contract.getAddress();
const implementation = await contract.ACCOUNT_IMPL();
assert.equal(implementation, e.getCreateAddress({ from: address, nonce: 1 }));
const implementationCodeHash = e.keccak256(await provider.getCode(implementation));
assert.equal(implementationCodeHash, LEAN_RUNTIME_HASH, 'deployed implementation runtime differs');

const out = join(run, 'aa-pq');
mkdirSync(out, { recursive: true });
const wallet = { active: true, chainId: params.chainId, genesisHash: params.elGenesisHash,
  factory: address, factoryCodeHash: e.keccak256(await provider.getCode(address)),
  implementation, implementationCodeHash, profile: p.domain, maxFeePerGas: '100000000000', eip8288Format: 'eip8288-lean',
  deploymentHash: receipt.hash, deploymentBlock: '0x' + receipt.blockNumber.toString(16) };
// The legacy ERC-4337 and native-frame contracts do not exist on a fresh devnet. The server profile still requires
// well-formed values for them; these placeholders hold no code.
const placeholder = n => '0x' + n.toString(16).padStart(40, '0');
const network = { name: 'Daisugi Local', chainId: params.chainId, genesisHash: params.elGenesisHash, frameActivationBlock: 0,
  entryPoint: placeholder(0xe4337), nativeFactory: placeholder(0xf01), nativeImplementation: placeholder(0xf02),
  nativeImplementationCodeHash: e.ZeroHash, nativeVerifier: placeholder(0xf03), nativeVerifierCodeHash: e.ZeroHash,
  eip8288Format: 'eip8288-lean' };
writeFileSync(join(out, 'wallet-profile.json'), JSON.stringify(wallet, null, 2) + '\n');
writeFileSync(join(out, 'network-profile.json'), JSON.stringify(network, null, 2) + '\n');
console.log(JSON.stringify({ ...wallet, deployer: deployer.address, gasUsed: receipt.gasUsed.toString(), wrote: out }, null, 2));
