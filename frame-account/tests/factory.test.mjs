import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import solc from 'solc';
import { ContractFactory, JsonRpcProvider, keccak256, id, getBytes, ZeroAddress } from 'ethers';

const fixture = JSON.parse(readFileSync(new URL('fixtures/wallet-profile.json', import.meta.url)));
const verifier = fixture.verifierAddress;
let processHandle, provider, signer, factory, compiled, deployed;
const salt = id('Daisugi isolated SPHINCS account test');
const key = [fixture.pkSeed, fixture.pkRoot];

before(async () => {
  const sources = Object.fromEntries(['SphincsFrameAccount', 'SphincsFrameAccountFactory', 'SphincsFrameRuntime']
    .map(name => [`${name}.sol`, { content: readFileSync(new URL(`../contracts/${name}.sol`, import.meta.url), 'utf8') }]));
  assert.match(solc.version(), /^0\.8\.28\+/);
  compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  } })));
  assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), []);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  processHandle = spawn(new URL('../node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil', import.meta.url).pathname,
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'cancun', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let failed;
  processHandle.on('error', error => { failed = error; });
  processHandle.on('exit', code => { if (code) failed = Error(`Anvil exited: ${code}`); });
  const url = `http://127.0.0.1:${port}`;
  for (let retry = 0; retry < 40; retry++) {
    if (failed) throw failed;
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if ((await response.json()).result === '0x7a69') break;
    }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  assert.equal(await provider.send('eth_chainId', []), '0x7a69');
  assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
  assert.equal(keccak256(fixture.verifierCode), fixture.verifierCodeHash);
  await provider.send('anvil_setCode', [verifier, fixture.verifierCode]);
  signer = await provider.getSigner(0);
  const artifact = compiled.contracts['SphincsFrameAccountFactory.sol'].SphincsFrameAccountFactory;
  factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy(verifier);
  await factory.waitForDeployment();
}, { timeout: 30000 });

after(async () => {
  provider?.destroy();
  if (processHandle && processHandle.exitCode === null) {
    await new Promise(resolve => { processHandle.once('exit', resolve); processHandle.kill('SIGTERM'); });
  }
});

test('rejects an absent or incompatible verifier', async () => {
  const artifact = compiled.contracts['SphincsFrameAccountFactory.sol'].SphincsFrameAccountFactory;
  const deployer = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer);
  await assert.rejects(deployer.deploy(ZeroAddress));
  await assert.rejects(deployer.deploy(await signer.getAddress()));
});

test('binds CREATE2 addresses to both public-key components and salt', async () => {
  const predicted = await factory.getFunction('getAddress')(...key, salt);
  for (const changed of [
    [id('other seed').slice(0, 34) + '0'.repeat(32), key[1], salt],
    [key[0], id('other root').slice(0, 34) + '0'.repeat(32), salt],
    [...key, id('other salt')]
  ]) assert.notEqual(await factory.getFunction('getAddress')(...changed), predicted);
  assert.equal(await factory.createAccount.staticCall(...key, salt), predicted);
  await (await factory.createAccount(...key, salt)).wait();
  deployed = predicted;
  const runtime = await provider.getCode(deployed);
  assert.equal(runtime, await factory.accountRuntime(...key));
  assert.equal(getBytes(runtime).length, 109);
  const output = new URL('../artifacts/', import.meta.url); mkdirSync(output, { recursive: true });
  writeFileSync(new URL('factory-fixture.json', output), JSON.stringify({
    factory: await factory.getAddress(), factoryCode: await provider.getCode(await factory.getAddress()),
    implementation: await factory.ACCOUNT_IMPL(), implementationCode: await provider.getCode(await factory.ACCOUNT_IMPL()),
    account: deployed, accountCode: runtime, salt, ...fixture,
    createCalldata: factory.interface.encodeFunctionData('createAccount', [...key, salt])
  }, null, 2));
  const nativeFixture = JSON.parse(readFileSync(new URL('fixtures/native-frame.json', import.meta.url)));
  assert.equal(nativeFixture.account, deployed, 'Native fixture must use the current CREATE2 address');
  assert.equal(nativeFixture.accountCode, runtime, 'Native tests must exercise the current account runtime');
  assert.equal(nativeFixture.factoryCode, await provider.getCode(await factory.getAddress()),
    'Native tests must exercise the current factory runtime');
  assert.equal(nativeFixture.implementationCode, await provider.getCode(await factory.ACCOUNT_IMPL()),
    'Native tests must exercise the current implementation runtime');
});

test('third-party deployment is idempotent and does not change the public key', async () => {
  const other = factory.connect(await provider.getSigner(1));
  assert.equal(await other.createAccount.staticCall(...key, salt), deployed);
  const code = await provider.getCode(deployed);
  const receipt = await (await other.createAccount(...key, salt)).wait();
  assert.equal(receipt.logs.length, 0);
  assert.equal(await provider.getCode(deployed), code);
});

test('rejects noncanonical public-key encoding', async () => {
  const malformed = key[0].slice(0, -1) + '1';
  await assert.rejects(factory.createAccount(malformed, key[1], salt));
});

test('accepts funding and rejects legacy initialization, rotation and execute calls', async () => {
  await (await signer.sendTransaction({ to: deployed, value: 123n })).wait();
  assert.equal(await provider.getBalance(deployed), 123n);
  for (const signature of ['initialize(bytes32,bytes32,bytes32)', 'rotateOwner(address,address)', 'execute(address,uint256,bytes)']) {
    await assert.rejects(provider.call({ to: deployed, data: id(signature).slice(0, 10) + '00'.repeat(128) }));
  }
  assert.equal(await provider.getBalance(deployed), 123n);
});
