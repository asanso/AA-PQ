import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const cwd = fileURLToPath(new URL('../', import.meta.url));
// A complete active native profile: the pins of the leanSPHINCS known-answer fixture.
const complete = JSON.parse(readFileSync(new URL('./fixtures/native-lean-sphincs.json', import.meta.url), 'utf8')).config;

function withProfile(profile, run) {
  const directory = mkdtempSync(join(tmpdir(), 'nicetry-native-profile-'));
  const file = join(directory, 'native-deployment.json');
  try {
    if (profile) writeFileSync(file, JSON.stringify(profile));
    return run(profile ? file : undefined);
  } finally { rmSync(directory, {recursive:true, force:true}); }
}
function environment(profile, rpc, explorer) {
  const env = {...process.env};
  for (const name of ['NICETRY_RPC_URL', 'NICETRY_EXPLORER_URL', 'NICETRY_BUNDLER_URL', 'NICETRY_AGGREGATION_PROFILE', 'NICETRY_NATIVE_PROFILE']) delete env[name];
  if (profile) env.NICETRY_NATIVE_PROFILE = profile;
  if (rpc !== undefined) env.NICETRY_RPC_URL = rpc;
  if (explorer !== undefined) env.NICETRY_EXPLORER_URL = explorer;
  return env;
}
const publicUrls = ['https://staging.invalid/rpc', 'https://staging.invalid/explorer'];
function resolveBuild(profile, [rpc, explorer] = publicUrls) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {resolveConfig} from 'vite'; await resolveConfig({logLevel:'silent',build:{outDir:'nicetry-daisugi-profile-test'}},'build');"],
  {cwd, env: environment(profile, rpc, explorer), encoding:'utf8', timeout:15000});
}
function serverModules(profile, script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'vite';
    import {readdirSync,readFileSync} from 'node:fs'; import {join} from 'node:path';
    const s=await createServer({logLevel:'silent',server:{middlewareMode:true,hmr:false},appType:'custom'});
    try { ${script} } finally { await s.close(); }`], {cwd, env: environment(profile), encoding:'utf8', timeout:60000});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('requires explicit public HTTPS RPC and explorer URLs for extension builds', () => withProfile(complete, file => {
  const valid = resolveBuild(file);
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
    const result = resolveBuild(file, [rpc, explorer]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, 'An incomplete or non-public profile must not build');
  }
}));

test('a build requires an active native profile', () => {
  const missing = resolveBuild(undefined);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /active native frame profile/);
  withProfile({active:false}, file => {
    const result = resolveBuild(file);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /active native frame profile/);
  });
});

test('an active native profile requires the envelope, chain and contract pins and a fee ceiling', () => {
  for (const [profile, message] of [
    [{active:'true'}, /active flag/],
    [{...complete, chainId:'701563864'}, /pinned network or contract identity/],
    [{...complete, chainId:undefined}, /pinned network or contract identity/],
    [{...complete, verifierCodeHash:undefined}, /pinned network or contract identity/],
    [{...complete, eip8288Format:'daisugi-v1'}, /eip8288-lean/],
    [{...complete, maxFeePerGas:'0'}, /fee ceiling/],
  ]) withProfile(profile, file => {
    const result = resolveBuild(file);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
});

test('the extension network follows the native profile; without one it has none', () => {
  const identity = profile => serverModules(profile, `const m=await s.ssrLoadModule('/src/config/chain-defaults.js');
    console.log(JSON.stringify({...m.NETWORK_IDENTITY,defaultChainId:m.DEFAULT_CHAIN_ID,native:m.NATIVE_AVAILABLE}));`);
  assert.deepEqual(identity(), {chainId:0, genesisHash:null, defaultChainId:'0x0', native:false});
  withProfile(complete, file => assert.deepEqual(identity(file),
    {chainId:complete.chainId, genesisHash:complete.genesisHash, defaultChainId:'0x' + complete.chainId.toString(16), native:true}));
});

test('every import of the default profile resolves to the selected profile, whatever its specifier form', () => withProfile(complete, file => {
  // Resolves every profile import found in src through Vite's full resolver (alias included), then loads the
  // modules that hold the profile and reports what each one received.
  const {imports, loaded} = serverModules(file, `
    const files=readdirSync('src',{recursive:true}).filter(f=>/\\.(js|jsx|mjs)$/.test(f)).map(f=>join(process.cwd(),'src',f));
    const imports=[];
    for (const file of files) for (const [,spec] of readFileSync(file,'utf8').matchAll(/from\\s+['"]([^'"]*deployment\\.json)['"]/g))
      imports.push({file,spec,id:(await s.pluginContainer.resolveId(spec,file))?.id});
    const loaded={};
    for (const [name,path] of [['native','/src/native-frame/native.js'],['networks','/src/config/chain-defaults.js']]) {
      const m=await s.ssrLoadModule(path); loaded[name]=m.config?.factory ?? m.NATIVE_AVAILABLE;
    }
    console.log(JSON.stringify({imports,loaded}));`);
  assert.ok(imports.some(i => i.spec === './native-deployment.json'), 'the relative native import is covered');
  assert.ok(imports.length >= 3);
  for (const i of imports) assert.equal(i.id, file, i.file + ' ' + i.spec);
  assert.deepEqual(loaded, {native:complete.factory, networks:true});
}));

test('the extension describes its only transaction mode', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const {extensionDescription}=await import('./vite.config.js'); console.log(extensionDescription);"],
  {cwd, env: environment(), encoding:'utf8', timeout:30000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').at(-1), 'Experimental Daisugi testnet wallet with SPHINCS signing: native frames.');
  assert.equal(JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8')).description,
    'Experimental Daisugi testnet wallet with SPHINCS signing: native frames.');
});
