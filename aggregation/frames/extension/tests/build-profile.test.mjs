import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
      assert.match(result.stderr,/active flag|chain 1337|pinned network or contract identity/);
    }
  } finally { unlinkSync(file);rmdirSync(directory); }
});
