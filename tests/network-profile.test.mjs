import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {DAISUGI_PROFILE, NETWORK, chainIdHex, chainIdRlp, loadNetworkProfile, parseNetworkProfile} from '../explorer/network-profile.mjs';
import {DAISUGI_GENESIS, FRAME_ACTIVATION_BLOCK} from '../explorer/native-frame.mjs';

// The running Daisugi network, written out independently of the module under test.
const legacy = {
  name:'Daisugi', chainId:1337,
  genesisHash:'0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55',
  frameActivationBlock:519324,
  entryPoint:'0x433709009B8330FDa32311DF1C2AFA402eD8D009',
  nativeFactory:'0xd07fcbdca6dea83b523faf95386cea236e32d989',
  nativeImplementation:'0xfec328c1725f6ef48160053e14379865aec07568',
  nativeImplementationCodeHash:'0xc8117616be026fd5b351f98470a35e46a1932816f04733e6d23ba51c8b93be30',
  nativeVerifier:'0xf505ad2cff58b84e145d637d99fae0617b5685be',
  nativeVerifierCodeHash:'0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417',
  eip8288Format:'daisugi-v1',
};
const alternative = {
  name:'Daisugi Next', chainId:7357,
  genesisHash:'0x'+'11'.repeat(32), frameActivationBlock:100,
  entryPoint:'0x'+'22'.repeat(20), nativeFactory:'0x'+'33'.repeat(20),
  nativeImplementation:'0x'+'44'.repeat(20), nativeImplementationCodeHash:'0x'+'55'.repeat(32),
  nativeVerifier:'0x'+'66'.repeat(20), nativeVerifierCodeHash:'0x'+'77'.repeat(32),
  eip8288Format:'eip8288-lean',
};

test('without a profile file, every consumer sees the running Daisugi network', () => {
  assert.equal(process.env.DAISUGI_NETWORK_PROFILE, undefined);
  assert.deepEqual({...NETWORK}, legacy);
  assert.equal(NETWORK, DAISUGI_PROFILE);
  assert.equal(DAISUGI_GENESIS, legacy.genesisHash);
  assert.equal(FRAME_ACTIVATION_BLOCK, legacy.frameActivationBlock);
  assert.equal(chainIdHex, '0x539');
  assert.equal(chainIdRlp, '0x0539');
});

test('a profile must be complete and well formed', () => {
  assert.deepEqual({...parseNetworkProfile(alternative)}, alternative);
  const {genesisHash, ...missing} = alternative;
  assert.throws(() => parseNetworkProfile(missing), /genesisHash/);
  assert.throws(() => parseNetworkProfile({...alternative, rpcUrl:'http://127.0.0.1'}), /Unknown network profile fields: rpcUrl/);
  assert.throws(() => parseNetworkProfile({...alternative, chainId:'7357'}), /chainId/);
  assert.throws(() => parseNetworkProfile({...alternative, genesisHash:'0x11'}), /genesisHash/);
  assert.throws(() => parseNetworkProfile({...alternative, nativeFactory:'0x'+'33'.repeat(19)}), /nativeFactory/);
  assert.throws(() => parseNetworkProfile({...alternative, eip8288Format:'daisugi-v2'}), /eip8288Format/);
  assert.throws(() => parseNetworkProfile([]), /JSON object/);
  assert.equal(loadNetworkProfile({}), DAISUGI_PROFILE);
});

// The profile is read once at import, so the alternative network runs in its own process.
test('a profile file switches the portal and explorer to another network and rejects the current one', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'network-profile-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'network.json');
  await writeFile(file, JSON.stringify(alternative));
  const probe = `
    import {NETWORK, chainIdHex, chainIdRlp} from './explorer/network-profile.mjs';
    import {DAISUGI_GENESIS, FRAME_ACTIVATION_BLOCK} from './explorer/native-frame.mjs';
    import {createPortalApi} from './frontend/portal-api.mjs';
    import {createFrameIndex} from './explorer/frame-index.mjs';
    const portal = chain => createPortalApi({provider:{getNetwork:async()=>({chainId:chain}),
      getBlock:async()=>({number:1,timestamp:Math.floor(Date.now()/1000),baseFeePerGas:1n})},
      bundlerUrl:'http://127.0.0.1:1', fetchImpl:async()=>({ok:true,json:async()=>({result:chainIdHex})})});
    const index = async (chain, genesis) => {
      const frames = createFrameIndex({rpc:async method => method === 'eth_chainId' ? chain
        : method === 'eth_getBlockByNumber' ? {hash:genesis} : method === 'eth_blockNumber' ? '0x5' : null});
      await frames.update();
      return frames.snapshot().status;
    };
    const accepted = await portal(7357n).network();
    const rejected = await portal(1337n).network().then(() => 'accepted', error => error.message);
    console.log(JSON.stringify({network:{...NETWORK}, chainIdHex, chainIdRlp, DAISUGI_GENESIS, FRAME_ACTIVATION_BLOCK,
      portal:{chainId:accepted.chainId, name:accepted.network, bundler:accepted.bundler, rejected},
      index:{alternative:await index('0x1cbd', '0x'+'11'.repeat(32)), legacy:await index('0x539', '${legacy.genesisHash}')}}));`;
  const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', probe],
    {cwd:new URL('..', import.meta.url), env:{...process.env, DAISUGI_NETWORK_PROFILE:file}});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.network, alternative);
  assert.equal(result.chainIdHex, '0x1cbd');
  assert.equal(result.chainIdRlp, '0x1cbd');
  assert.equal(result.DAISUGI_GENESIS, alternative.genesisHash);
  assert.equal(result.FRAME_ACTIVATION_BLOCK, 100);
  assert.deepEqual(result.portal, {chainId:7357, name:'Daisugi Next', bundler:'available',
    rejected:'The RPC is not connected to Daisugi Next (chain 7357).'});
  // Head 5 is below the profile's start block 100: identity accepted, nothing to index yet. The current chain is refused.
  assert.equal(result.index.alternative, 'complete');
  assert.equal(result.index.legacy, 'unavailable');
});

test('ENTRY_POINT must agree with the selected profile', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'network-profile-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'network.json');
  await writeFile(file, JSON.stringify(alternative));
  assert.throws(() => loadNetworkProfile({DAISUGI_NETWORK_PROFILE:file, ENTRY_POINT:legacy.entryPoint}), /ENTRY_POINT does not match/);
  assert.deepEqual({...loadNetworkProfile({DAISUGI_NETWORK_PROFILE:file, ENTRY_POINT:alternative.entryPoint.toUpperCase().replace('0X', '0x')})}, alternative);
  assert.equal(loadNetworkProfile({ENTRY_POINT:legacy.entryPoint.toLowerCase()}), DAISUGI_PROFILE);
  assert.throws(() => loadNetworkProfile({ENTRY_POINT:alternative.entryPoint}), /ENTRY_POINT does not match/);
});

test('an invalid profile file stops startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'network-profile-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const file = join(directory, 'network.json');
  await writeFile(file, JSON.stringify({...alternative, chainId:0}));
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', "import './explorer/network-profile.mjs';"],
    {cwd:new URL('..', import.meta.url), env:{...process.env, DAISUGI_NETWORK_PROFILE:file}}), /Invalid or missing network profile field: chainId/);
});
