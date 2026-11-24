import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ContractFactory, ZeroAddress, ZeroHash, concat, decodeRlp, getAddress, getBytes, getCreate2Address, id, keccak256 } from 'ethers';
import { parseVector } from './leansphincs-reference.mjs';
import { compile, startAnvil } from './local-chain.mjs';

// A real leanSPHINCS public key, from EthLib's key_gen known answer.
const publicKey = parseVector(readFileSync(new URL('fixtures/leansphincs-ethlib/key_gen/key_gen_known_answer/data.yaml',
  import.meta.url), 'utf8')).output;
const salt = id('Daisugi leanSPHINCS account test');
const runtimeSource = readFileSync(new URL('../contracts/LeanSphincsFrameRuntime.sol', import.meta.url), 'utf8');
let chain, provider, signer, artifact, verifier, factory, deployed;

before(async () => {
  artifact = compile(['LeanSphincsVerifier', 'LeanSphincsFrameRuntime', 'LeanSphincsFrameAccount', 'LeanSphincsFrameAccountFactory']);
  chain = await startAnvil();
  provider = chain.provider;
  signer = await provider.getSigner(0);
  const verifierArtifact = artifact('LeanSphincsVerifier');
  verifier = await new ContractFactory(verifierArtifact.abi, verifierArtifact.evm.bytecode.object, signer).deploy();
  await verifier.waitForDeployment();
  const factoryArtifact = artifact('LeanSphincsFrameAccountFactory');
  factory = await new ContractFactory(factoryArtifact.abi, factoryArtifact.evm.bytecode.object, signer).deploy(await verifier.getAddress());
  await factory.waitForDeployment();
}, { timeout: 30000 });

after(async () => { await chain?.stop(); });

test('pins the runtime hash of the compiled LeanSphincsVerifier', async () => {
  const code = await provider.getCode(await verifier.getAddress());
  assert.equal(code, '0x' + artifact('LeanSphincsVerifier').evm.deployedBytecode.object);
  assert.equal(keccak256(code), await factory.VERIFIER_CODE_HASH(), 'Update VERIFIER_CODE_HASH in the account and factory');
  assert.equal(await factory.LEAN_SPHINCS_VERIFIER(), await verifier.getAddress());
});

test('rejects an absent or different verifier', async () => {
  const factoryArtifact = artifact('LeanSphincsFrameAccountFactory');
  const deployer = new ContractFactory(factoryArtifact.abi, factoryArtifact.evm.bytecode.object, signer);
  await assert.rejects(deployer.deploy(ZeroAddress));
  await assert.rejects(deployer.deploy(await signer.getAddress()));
  const other = '0x00000000000000000000000000000000000000f1';
  await provider.send('anvil_setCode', [other, (await provider.getCode(await verifier.getAddress())) + '00']);
  await assert.rejects(deployer.deploy(other));
  const accountArtifact = artifact('LeanSphincsFrameAccount');
  await assert.rejects(new ContractFactory(accountArtifact.abi, accountArtifact.evm.bytecode.object, signer).deploy(other));
});

test('the implementation is the generated leanSPHINCS runtime calling the pinned verifier', async () => {
  const pieces = [...runtimeSource.matchAll(/hex"([0-9a-f]+)"/g)].map(match => match[1]);
  assert.equal(pieces.length, 2);
  const expected = '0x' + pieces[0] + (await verifier.getAddress()).slice(2).toLowerCase() + pieces[1];
  assert.equal(await provider.getCode(await factory.ACCOUNT_IMPL()), expected);
  assert.equal(getBytes(expected).length, 250);
});

test('binds CREATE2 addresses to the public key and salt, as the wallet derives them', async () => {
  const predicted = await factory.getFunction('getAddress')(publicKey, salt);
  const runtime = concat(['0x363d3d373d3d3d363d73', await factory.ACCOUNT_IMPL(), '0x5af43d82803e903d91602b57fd5bf3', publicKey]);
  assert.equal(predicted, getCreate2Address(await factory.getAddress(), salt, keccak256(concat(['0x3d604d80600a3d3981f3', runtime]))));
  const changedKey = publicKey.slice(0, -1) + (publicKey.endsWith('0') ? '1' : '0');
  for (const changed of [[changedKey, salt], ['0x80' + publicKey.slice(4), salt], [publicKey, id('other salt')]])
    assert.notEqual(await factory.getFunction('getAddress')(...changed), predicted);
  assert.equal(await factory.createAccount.staticCall(publicKey, salt), predicted);
  const receipt = await (await factory.createAccount(publicKey, salt)).wait();
  assert.equal(receipt.logs.length, 1);
  deployed = getAddress(predicted);
  const code = await provider.getCode(deployed);
  assert.equal(code, runtime.toLowerCase());
  assert.equal(code, await factory.accountRuntime(publicKey));
  assert.equal(getBytes(code).length, 77);
});

test('third-party deployment is idempotent and does not change the public key', async () => {
  const other = factory.connect(await provider.getSigner(1));
  assert.equal(await other.createAccount.staticCall(publicKey, salt), deployed);
  const code = await provider.getCode(deployed);
  const receipt = await (await other.createAccount(publicKey, salt)).wait();
  assert.equal(receipt.logs.length, 0);
  assert.equal(await provider.getCode(deployed), code);
});

test('accepts funding and rejects calls outside native verification', async () => {
  await (await signer.sendTransaction({ to: deployed, value: 123n })).wait();
  assert.equal(await provider.getBalance(deployed), 123n);
  for (const signature of ['verify(bytes32,bytes32,bytes)', 'initialize(bytes32,bytes32)', 'execute(address,uint256,bytes)']) {
    await assert.rejects(provider.call({ to: deployed, data: id(signature).slice(0, 10) + '00'.repeat(96) }));
  }
  assert.equal(await provider.getBalance(deployed), 123n);
});

test('the wallet known answers match these contracts, and the verifier accepts the wallet signatures', async () => {
  // The extension's leanSPHINCS fixture was generated against this deployment order: verifier, then factory, by account 0.
  const wallet = JSON.parse(readFileSync(new URL('../../aggregation/frames/extension/tests/fixtures/native-lean-sphincs.json',
    import.meta.url), 'utf8'));
  const { config } = wallet;
  assert.equal(config.verifier, await verifier.getAddress());
  assert.equal(config.factory, await factory.getAddress());
  assert.equal(config.implementation, await factory.ACCOUNT_IMPL());
  for (const field of ['verifier', 'factory', 'implementation'])
    assert.equal(config[field + 'CodeHash'], keccak256(await provider.getCode(config[field])), field);
  assert.equal(await factory.getFunction('getAddress')(wallet.publicKey, ZeroHash), getAddress(wallet.account));
  assert.equal(wallet.accountCode, await factory.accountRuntime(wallet.publicKey));
  for (const tx of wallet.transactions) {
    const witness = decodeRlp('0x' + tx.raw.slice(4))[5][0][3];
    assert.equal(await verifier.verify(wallet.publicKey, tx.digest, witness), true, tx.hash);
    const changed = getBytes(witness); changed[100] ^= 1;
    assert.equal(await verifier.verify(wallet.publicKey, tx.digest, changed), false, tx.hash);
  }
});
