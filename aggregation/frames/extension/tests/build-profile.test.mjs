import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as e from 'ethers';
import {createProtocol} from '../src/aggregated-frame/protocol.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function resolveProfile(rpc, explorer, bundler = rpc?.startsWith('https://') ? new URL('/bundler', rpc).href : undefined, profile) {
  const env = {...process.env};
  delete env.NICETRY_RPC_URL;
  delete env.NICETRY_EXPLORER_URL;
  delete env.NICETRY_BUNDLER_URL;
  delete env.NICETRY_AGGREGATION_PROFILE;
  if (profile) env.NICETRY_AGGREGATION_PROFILE=profile;
  if (bundler !== undefined) env.NICETRY_BUNDLER_URL = bundler;
  if (rpc !== undefined) env.NICETRY_RPC_URL = rpc;
  if (explorer !== undefined) env.NICETRY_EXPLORER_URL = explorer;
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {resolveConfig} from 'vite'; await resolveConfig({logLevel:'silent',build:{outDir:'nicetry-daisugi-profile-test'}},'build');"],
  {cwd, env, encoding:'utf8', timeout:15000});
}

test('requires explicit public HTTPS RPC and explorer URLs for extension builds', () => {
  const valid = resolveProfile('https://staging.invalid/rpc', 'https://staging.invalid/explorer');
  assert.equal(valid.status, 0, valid.stderr);
  for (const [rpc, explorer] of [
    [undefined, undefined],
    ['https://staging.invalid/rpc', undefined],
    ['http://127.0.0.1:3007/rpc', 'https://staging.invalid/explorer'],
    ['https://localhost/rpc', 'https://staging.invalid/explorer'],
    ['https://user:secret@staging.invalid/rpc', 'https://staging.invalid/explorer'],
    ['https://staging.invalid/rpc?token=secret', 'https://staging.invalid/explorer'],
    ['https://staging.invalid/rpc', 'http://localhost:3003/explorer'],
  ]) {
    const result = resolveProfile(rpc, explorer);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'An incomplete or non-public profile must not build');
  }
});

test('requires a bundler on the explicit RPC origin', () => {
  for (const bundler of ['', 'https://another.invalid/bundler', 'http://localhost/bundler',
    'https://staging.invalid/rpc', 'https://staging.invalid/bundler?token=secret']) {
    const result = resolveProfile('https://staging.invalid/rpc', 'https://staging.invalid/explorer', bundler);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
  }
});

test('an activated aggregation build requires explicit chain and contract pins', () => {
  const directory=mkdtempSync(join(tmpdir(),'nicetry-aggregation-profile-'));
  const file=join(directory,'deployment.json');
  try {
    for (const profile of [{active:'true'}, {active:true,chainId:1}, {active:true,chainId:1337}]) {
      writeFileSync(file,JSON.stringify(profile));
      const result=resolveProfile('https://staging.invalid/rpc','https://staging.invalid/explorer','https://staging.invalid/bundler',file);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/active flag|pinned network or contract identity/);
    }
  } finally { unlinkSync(file);rmdirSync(directory); }
});

test('an activated aggregation build takes its chain ID from the profile', () => {
  const directory=mkdtempSync(join(tmpdir(),'nicetry-aggregation-profile-'));
  const file=join(directory,'deployment.json');
  const p=createProtocol(e,'eip8288-lean');
  const complete={active:true,chainId:7357,genesisHash:'0x'+'33'.repeat(32),factory:'0x'+'10'.repeat(20),implementation:'0x'+'20'.repeat(20),
    factoryCodeHash:e.keccak256('0x6000'),implementationCodeHash:e.keccak256(p.implementationRuntime()),profile:p.domain,
    maxFeePerGas:'100000000000',eip8288Format:'eip8288-lean'};
  try {
    for (const [profile, builds] of [[complete,true],[{...complete,chainId:'7357'},false],[{...complete,chainId:undefined},false]]) {
      writeFileSync(file,JSON.stringify(profile));
      const result=resolveProfile('https://staging.invalid/rpc','https://staging.invalid/explorer','https://staging.invalid/bundler',file);
      if (builds) assert.equal(result.status,0,result.stderr);
      else { assert.notEqual(result.status,0); assert.match(result.stderr,/pinned network or contract identity/); }
    }
  } finally { unlinkSync(file);rmdirSync(directory); }
});

test('the extension network follows an active aggregation profile and drops ERC-4337 elsewhere', () => {
  const directory=mkdtempSync(join(tmpdir(),'nicetry-aggregation-profile-'));
  const file=join(directory,'deployment.json');
  const p=createProtocol(e,'eip8288-lean');
  writeFileSync(file,JSON.stringify({active:true,chainId:7357,genesisHash:'0x'+'33'.repeat(32),factory:'0x'+'10'.repeat(20),
    implementation:'0x'+'20'.repeat(20),factoryCodeHash:e.keccak256('0x6000'),implementationCodeHash:e.keccak256(p.implementationRuntime()),
    profile:p.domain,maxFeePerGas:'100000000000',eip8288Format:'eip8288-lean'}));
  const identity = profile => {
    const env={...process.env};
    delete env.NICETRY_AGGREGATION_PROFILE;
    if (profile) env.NICETRY_AGGREGATION_PROFILE=profile;
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import {createServer} from 'vite';
      const s=await createServer({logLevel:'silent',server:{middlewareMode:true,hmr:false},appType:'custom'});
      try { const m=await s.ssrLoadModule('/src/config/chain-defaults.js');
        console.log(JSON.stringify({...m.NETWORK_IDENTITY,defaultChainId:m.DEFAULT_CHAIN_ID,erc4337:m.ERC4337_AVAILABLE})); } finally { await s.close(); }`],
    {cwd,env,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  try {
    assert.deepEqual(identity(), {chainId:1337,genesisHash:'0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55',defaultChainId:'0x539',erc4337:true});
    assert.deepEqual(identity(file), {chainId:7357,genesisHash:'0x'+'33'.repeat(32),defaultChainId:'0x1cbd',erc4337:false});
  } finally { unlinkSync(file);rmdirSync(directory); }
});
