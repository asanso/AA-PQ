import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function resolveProfile(rpc, explorer) {
  const env = {...process.env};
  delete env.NICETRY_RPC_URL;
  delete env.NICETRY_EXPLORER_URL;
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
