// Checks that the devnet and every AA-PQ service agree on the network identity and the lean contracts, then that a
// portal configured for another chain or genesis fails closed.
// Usage: node scripts/local-devnet/verify-services.mjs <devnet run dir>
// Env: EL_RPC (default http://127.0.0.1:28545), CL_API (default http://127.0.0.1:25052).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const run = resolve(process.argv[2] ?? '');
const e = createRequire(join(repo, 'frontend/package.json'))('ethers');
const EL = process.env.EL_RPC ?? 'http://127.0.0.1:28545', CL = process.env.CL_API ?? 'http://127.0.0.1:25052';
const params = JSON.parse(readFileSync(join(run, 'params.json'), 'utf8'));
const wallet = JSON.parse(readFileSync(join(run, 'aa-pq/wallet-profile.json'), 'utf8'));
const network = JSON.parse(readFileSync(join(run, 'aa-pq/network-profile.json'), 'utf8'));
const LEAN_RUNTIME_HASH = '0xa0fa54dffc48a5c423206cd198c7b3459baaa8b2728b7d8e7665bce52f20db13';
const LEAN_DOMAIN = '0x921d40cefd1cb6cc36d6c4a57637e6ff75f895719fc2879118b5ec9104423d78';
const chainHex = '0x' + params.chainId.toString(16);
const ok = (name, detail = '') => console.log('PASS', name, detail);
// The HTTPS front is checked as https://daisugi.test:8443 with only the run's own certificate trusted.
const ca = readFileSync(join(run, 'aa-pq/tls/cert.pem'));
function request(url, body) {
  if (!url.startsWith('https://daisugi.test:8443')) return fetch(url, body === undefined ? {} : { method: 'POST',
    headers: { 'content-type': 'application/json' }, body }).then(async r => ({ status: r.status, text: await r.text() }));
  return new Promise((done, fail) => {
    const req = https.request(url, { method: body === undefined ? 'GET' : 'POST', ca, lookup: (host, options, cb) =>
      options.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      headers: { 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('error', fail); req.end(body);
  });
}
const rpc = async (url, method, params = []) => {
  const r = await request(url, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  return { status: r.status, ...JSON.parse(r.text) };
};
const json = async url => { const r = await request(url); return { status: r.status, body: JSON.parse(r.text) }; };

// Devnet: chain, genesis, fork, finality.
assert.equal((await rpc(EL, 'eth_chainId')).result, chainHex);
assert.equal((await rpc(EL, 'eth_getBlockByNumber', ['0x0', false])).result.hash, params.elGenesisHash);
const finality = (await json(`${CL}/eth/v1/beacon/states/head/finality_checkpoints`)).body.data;
assert.ok(Number(finality.finalized.epoch) > params.daisugiForkEpoch, 'not finalized past the fork epoch yet');
const forkBlock = params.daisugiForkEpoch * params.slotsPerEpoch;
const fieldsAt = async n => (await rpc(EL, 'debug_getRawHeader', ['0x' + n.toString(16)])).result;
assert.equal(e.decodeRlp(await fieldsAt(forkBlock - 1)).length, 21);
assert.equal(e.decodeRlp(await fieldsAt(forkBlock)).length, 25);
ok('devnet identity, EIP-8288 fork and finality', `chain ${params.chainId}, genesis ${params.elGenesisHash}, finalized epoch ${finality.finalized.epoch}`);

// Lean contracts.
assert.equal(e.keccak256((await rpc(EL, 'eth_getCode', [wallet.implementation, 'latest'])).result), LEAN_RUNTIME_HASH);
assert.equal(e.keccak256((await rpc(EL, 'eth_getCode', [wallet.factory, 'latest'])).result), wallet.factoryCodeHash);
const impl = new e.Interface(['function ACCOUNT_IMPL() view returns(address)']);
assert.equal(impl.decodeFunctionResult('ACCOUNT_IMPL', (await rpc(EL, 'eth_call', [{ to: wallet.factory, data: impl.encodeFunctionData('ACCOUNT_IMPL') }, 'latest'])).result)[0], wallet.implementation);
assert.equal(wallet.profile, LEAN_DOMAIN);
ok('lean factory and implementation match the wallet profile', `factory ${wallet.factory}, implementation ${wallet.implementation}`);

// Every service reports the same identity.
for (const base of ['http://127.0.0.1:3004', 'https://daisugi.test:8443']) {
  const config = await json(base + '/api/config');
  assert.equal(config.status, 200); assert.equal(config.body.chainId, params.chainId); assert.equal(config.body.networkName, network.name);
  assert.equal((await json(base + '/api/network')).body.chainId, params.chainId);
  const site = (await request(base + '/site-config.js')).text;
  assert.equal(JSON.parse(site.match(/Object\.freeze\((.*)\);/)[1]).chainId, params.chainId);
  assert.equal((await rpc(base + '/rpc', 'eth_chainId')).result, chainHex);
  assert.equal((await rpc(base + '/rpc', 'eth_getBlockByNumber', ['0x0', false])).result.hash, params.elGenesisHash);
}
const overview = (await json('http://127.0.0.1:3005/api/overview')).body;
assert.equal(overview.chainId, params.chainId);
assert.equal(overview.nativeFrames?.status === 'unavailable', false, 'explorer frame index refused the chain');
ok('portal, gateway, HTTPS front and explorer report the devnet identity');

// A portal configured for another network fails closed.
let work;
async function portal(profile, port) {
  const file = join(work, `profile-${port}.json`);
  writeFileSync(file, JSON.stringify(profile));
  const child = spawn(process.execPath, ['frontend/server.mjs'], { cwd: repo, stdio: 'ignore', env: { PATH: process.env.PATH,
    HOST: '127.0.0.1', PORT: String(port), RPC_URL: EL, BUNDLER_URL: 'http://127.0.0.1:9', EXPLORER_URL: 'http://127.0.0.1:3005',
    NATIVE_AGGREGATION_RPC_ENABLED: 'true', DAISUGI_NETWORK_PROFILE: file, FAUCET_PRIVATE_KEY: e.Wallet.createRandom().privateKey } });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${port}/site-config.js`).then(() => true, () => false)) return child;
    await new Promise(r => setTimeout(r, 250));
  }
  child.kill(); throw Error('temporary portal did not start');
}
// A structurally valid lean wrapper; the gateway's network check runs before the node would verify it.
const { createProtocol } = await import(join(repo, 'aggregation/frames/wallet/protocol.mjs'));
const p = createProtocol(e, 'eip8288-lean');
const wrapperFor = chainId => p.signedRequest(p.prepare({ config: { ...wallet, chainId }, pkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16),
  pkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16), nonce: 0, deployed: false, recipient: '0x' + '40'.repeat(20), value: 1,
  maxFee: 3000000000n, priorityFee: 1000000000n }), '0x' + '55'.repeat(6176)).wrapper;
const children = [];
try {
  work = mkdtempSync(join(tmpdir(), 'aa-pq-wrong-'));
  const wrongChain = await portal({ ...network, chainId: params.chainId + 1 }, 3014); children.push(wrongChain);
  assert.equal((await json('http://127.0.0.1:3014/api/config')).status, 503);
  assert.equal((await json('http://127.0.0.1:3014/api/network')).status, 503);
  const refusedChain = await rpc('http://127.0.0.1:3014/rpc', 'eth_sendProofWrapper', [wrapperFor(params.chainId + 1)]);
  assert.ok(refusedChain.error, 'wrong-chain gateway forwarded a wrapper');
  ok('a portal for another chain ID fails closed', `/api/config 503; gateway: ${refusedChain.error.message}`);

  const wrongGenesis = await portal({ ...network, genesisHash: e.keccak256('0x01') }, 3015); children.push(wrongGenesis);
  const refusedGenesis = await rpc('http://127.0.0.1:3015/rpc', 'eth_sendProofWrapper', [wrapperFor(params.chainId)]);
  assert.ok(refusedGenesis.error, 'wrong-genesis gateway forwarded a wrapper');
  assert.match(refusedGenesis.error.message, /genesis/i);
  ok('a gateway for another genesis refuses submissions', refusedGenesis.error.message);
} finally {
  for (const child of children) child.kill();
  if (work) rmSync(work, { recursive: true, force: true });
}
