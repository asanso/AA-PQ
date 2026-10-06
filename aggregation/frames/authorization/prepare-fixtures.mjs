import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { accountTools } from './account.mjs';
import { loadWalletSigner, moduleSha256 } from './wallet-signer.mjs';

const [project, originalModule, output] = process.argv.slice(2);
if (!project || !originalModule || !output) throw Error('Usage: prepare-fixtures.mjs PROJECT ORIGINAL_SIGNER OUTPUT');
const ethers = createRequire(join(resolve(project), 'frontend/package.json'))('ethers');
const { keccak256, concat, getBytes } = ethers;
const tools = accountTools(ethers);
const wallet = await loadWalletSigner(originalModule, ethers);
mkdirSync(output);
const fixtures = [];
for (let index = 0; index < 2; index++) {
  const seed = randomBytes(32);
  try {
    const derived = wallet.sphincsDerive(seed);
    const pkSeed = derived.backupPkSeed;
    const pkRoot = derived.backupPkRoot;
    assert.match(pkSeed, /^0x[0-9a-fA-F]{32}0{32}$/);
    assert.match(pkRoot, /^0x[0-9a-fA-F]{32}0{32}$/);
    const publicKey = '0x' + pkRoot.slice(2, 34) + pkSeed.slice(2, 34);
    const keyHash = keccak256(publicKey);
    const sender = '0xda1500000000000000000000000000000000000' + (index + 1);
    const transaction = {
      chainId: '1337', sender, nonce: '0', nonceKeys: ['0'],
      maxPriorityFee: '1000000000', maxFee: '100000000000', maxBlobFee: '0',
      frames: [
        { mode: 4, flags: 0, target: null, executionGas: 3000, stateGas: 0, value: '0',
          data: concat([tools.word(16), tools.word(0), keyHash]) },
        { mode: 1, flags: 3, target: null, executionGas: 100000, stateGas: 50000, value: '0', data: '0x' },
        { mode: 2, flags: 0, target: '0xda15' + '0'.repeat(32) + 'c001',
          executionGas: 100000, stateGas: 100000, value: '100000000000000', data: tools.word(index + 7) },
      ],
    };
    const message = tools.digest(transaction, keyHash);
    const signed = wallet.sphincsSign(seed, getBytes(message));
    assert.equal(wallet.sphincsVerify(pkSeed, pkRoot, message, signed.sigHex).valid, true);
    transaction.frames[0].data = concat([tools.word(16), message, keyHash]);
    assert.equal(tools.digest(transaction, keyHash), message);
    const unrelatedMessage = keccak256(tools.word(index + 99));
    const unrelatedSignature = wallet.sphincsSign(seed, getBytes(unrelatedMessage)).sigHex;
    assert.equal(wallet.sphincsVerify(pkSeed, pkRoot, unrelatedMessage, unrelatedSignature).valid, true);
    fixtures.push({ transaction, message, publicKey, keyHash, runtime: tools.runtime(keyHash),
      witness: concat([publicKey, signed.sigHex]),
      unrelatedMessage, unrelatedWitness: concat([publicKey, unrelatedSignature]) });
  } finally { seed.fill(0); }
}
writeFileSync(join(output, 'authorization.json'), JSON.stringify({ profile: 'daisugi-aggregate-intent-v1',
  moduleSha256, domain: tools.domain, fixtures }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ accounts: fixtures.length, signatures: 4, privateKeysWritten: false,
  runtimeBytes: getBytes(fixtures[0].runtime).length }));
