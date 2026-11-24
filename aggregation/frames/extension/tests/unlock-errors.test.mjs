import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unlock must report a wrong password only when the vault cannot be decrypted. A right password whose account
// cannot be loaded (here: a native vault on a build without a native profile) must say so and stay locked.
// Runs through Vite so the hook's JSON profile imports resolve as in the extension build.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const profileConfig = JSON.parse(readFileSync(new URL('./fixtures/native-lean-sphincs.json', import.meta.url), 'utf8')).config;
const probe = `import {createServer} from 'vite';
  const stored = {};
  globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() }, storage: { local: {
    get(keys, callback) { const result = keys === null ? {...stored} : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); callback?.(result); return Promise.resolve(result); },
    set(values, callback) { Object.assign(stored, structuredClone(values)); callback?.(); return Promise.resolve(); },
    remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; callback?.(); return Promise.resolve(); },
  } } };
  // The leanSPHINCS worker is replaced by a fixed public key: these tests concern error reporting only.
  globalThis.Worker = class { postMessage() { queueMicrotask(() => this.onmessage({ data: { publicKey: '0x' + '11'.repeat(32) } })); } terminate() {} };
  const s = await createServer({logLevel:'silent', server:{middlewareMode:true, hmr:false}, appType:'custom'});
  try {
    const {useVault} = await s.ssrLoadModule('/src/ui/hooks/useVault.js');
    const {vaultManager} = await s.ssrLoadModule('/src/vault/VaultManager.js');
    const outcome = async password => { try { await useVault().unlock(password); return {unlocked: vaultManager.isUnlocked()}; }
      catch (error) { return {code: error.code ?? null, message: error.message, unlocked: vaultManager.isUnlocked()}; } };
    await vaultManager.restoreVault('Right-password!2026', 'test test test test test test test test test test test junk', {transactionMode: 'native'});
    vaultManager.lock();
    console.log(JSON.stringify({wrong: await outcome('Wrong-password!2026'), right: await outcome('Right-password!2026')}));
  } finally { await s.close(); }`;

function unlock(withProfile) {
  const env = { ...process.env };
  delete env.NICETRY_AGGREGATION_PROFILE;
  delete env.NICETRY_NATIVE_PROFILE;
  const directory = mkdtempSync(join(tmpdir(), 'nicetry-unlock-profile-'));
  try {
    if (withProfile) {
      env.NICETRY_NATIVE_PROFILE = join(directory, 'native-deployment.json');
      writeFileSync(env.NICETRY_NATIVE_PROFILE, JSON.stringify(profileConfig));
    }
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim().split('\n').at(-1));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('unlock separates a wrong password from an account that cannot be loaded', () => {
  for (const withProfile of [true, false])
    assert.deepEqual(unlock(withProfile).wrong, { code: 'WRONG_PASSWORD', message: 'Wrong password', unlocked: false });
  // With a native profile the account loads.
  assert.deepEqual(unlock(true).right, { unlocked: true });
  // Without one the password is accepted, the account is not, and the vault stays locked.
  const right = unlock(false).right;
  assert.equal(right.code, 'ACCOUNT_UNAVAILABLE');
  assert.equal(right.unlocked, false);
  assert.match(right.message, /^Your password is correct, but the wallet account could not be loaded: .*Native frame accounts are not available/);
});
