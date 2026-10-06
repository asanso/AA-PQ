import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createProtocol } from './protocol.mjs';
import { loadWalletSigner, moduleSha256 } from '../authorization/wallet-signer.mjs';

const [project, compilerPackage, signerModule, output] = process.argv.slice(2);
if (!output) throw Error('Usage: prepare-fixtures.mjs PROJECT COMPILER_PACKAGE ORIGINAL_SIGNER OUTPUT');
const e = createRequire(join(resolve(project), 'frontend/package.json'))('ethers');
const solc = createRequire(resolve(compilerPackage))('solc');
assert.match(solc.version(), /^0\.8\.28\+/);
const p = createProtocol(e);
const runtime = p.implementationRuntime();
const generated = `// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\nlibrary AggregateAccountRuntime { function build() internal pure returns(bytes memory) { return hex"${runtime.slice(2)}"; } }\n`;
const name = 'SphincsAggregateAccountFactory.sol';
const input = { language: 'Solidity', sources: {
  [name]: { content: readFileSync(new URL('./contracts/' + name, import.meta.url), 'utf8') },
  'AggregateAccountRuntime.sol': { content: generated },
}, settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode'] } } } };
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
for (const error of compiled.errors ?? []) if (error.severity === 'error') throw Error(error.formattedMessage);
const factory = compiled.contracts[name].SphincsAggregateAccountFactory;
const config = { factory: '0xda1500000000000000000000000000000000f001',
  implementation: '0xda1500000000000000000000000000000000f002' };
const factoryBytes = e.getBytes('0x' + factory.evm.deployedBytecode.object);
const references = Object.values(factory.evm.deployedBytecode.immutableReferences).flat();
assert.ok(references.length > 0);
for (const reference of references) {
  assert.equal(reference.length, 32);
  factoryBytes.set(e.getBytes(e.zeroPadValue(config.implementation, 32)), reference.start);
}
const factoryRuntime = e.hexlify(factoryBytes);
const wallet = await loadWalletSigner(signerModule, e);
mkdirSync(output);
const fixtures = [];
for (let index = 0; index < 2; index++) {
  const seed = randomBytes(32);
  try {
    const { backupPkSeed: pkSeed, backupPkRoot: pkRoot } = wallet.sphincsDerive(seed);
    const scenarios = [];
    for (const deployed of [false, true]) {
      const prepared = p.prepare({ config, pkSeed, pkRoot, deployed, nonce: deployed ? 2 : 0,
        recipient: '0xda1500000000000000000000000000000000c001', value: 100000000000000n,
        data: p.word(index + 7), maxFee: 100000000000n, priorityFee: 1000000000n });
      const signed = wallet.sphincsSign(seed, e.getBytes(prepared.digest)).sigHex;
      assert.equal(wallet.sphincsVerify(pkSeed, pkRoot, prepared.digest, signed).valid, true);
      scenarios.push({ ...prepared, ...p.signedRequest(prepared, signed) });
    }
    fixtures.push({ sender: scenarios[0].transaction.sender, pkSeed, pkRoot, keyHash: scenarios[0].keyHash,
      runtime: p.cloneRuntime(config.implementation, scenarios[0].keyHash), scenarios });
  } finally { seed.fill(0); }
}
writeFileSync(join(output, 'wallet.json'), JSON.stringify({ config, moduleSha256, factoryRuntime, implementationRuntime: runtime,
  factoryCreation: '0x' + factory.evm.bytecode.object, fixtures }, null, 2) + '\n', { flag: 'wx' });
writeFileSync(join(output, 'compiler-input.json'), JSON.stringify(input) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ accounts: 2, signatures: 4, privateKeysWritten: false, implementationBytes: e.getBytes(runtime).length,
  factoryRuntimeBytes: factoryBytes.length, compiler: solc.version() }));
