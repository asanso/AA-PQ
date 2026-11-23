import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Unlock must report a wrong password only when the vault cannot be decrypted. A right password whose account
// cannot be loaded (here: a native-mode vault on a build without a native profile) must say so and stay locked.
// Runs through Vite so the hook's JSON profile imports resolve as in the extension build.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const probe = `import {createServer} from 'vite';
  const stored = {};
  globalThis.chrome = { runtime: { sendMessage: () => Promise.resolve() }, storage: { local: {
    get(keys, callback) { const result = keys === null ? {...stored} : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); callback?.(result); return Promise.resolve(result); },
    set(values, callback) { Object.assign(stored, structuredClone(values)); callback?.(); return Promise.resolve(); },
    remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; callback?.(); return Promise.resolve(); },
  } } };
  // The SPHINCS-G worker is replaced by a fixed, well-formed public key: these tests concern error reporting only.
  globalThis.Worker = class { postMessage() { queueMicrotask(() => this.onmessage({ data: {
    backupPkSeed: '0x' + '11'.repeat(16) + '00'.repeat(16), backupPkRoot: '0x' + '22'.repeat(16) + '00'.repeat(16) } })); } terminate() {} };
  const s = await createServer({logLevel:'silent', server:{middlewareMode:true, hmr:false}, appType:'custom'});
  try {
    const {useVault} = await s.ssrLoadModule('/src/ui/hooks/useVault.js');
    const {vaultManager} = await s.ssrLoadModule('/src/vault/VaultManager.js');
    const outcome = async password => { try { await useVault().unlock(password); return {unlocked: vaultManager.isUnlocked()}; }
      catch (error) { return {code: error.code ?? null, message: error.message, unlocked: vaultManager.isUnlocked()}; } };
    const result = {};
    for (const mode of ['aa', 'native']) {
      for (const key of Object.keys(stored)) delete stored[key];
      vaultManager.lock();
      await vaultManager.restoreVault('Right-password!2026', 'test test test test test test test test test test test junk', {transactionMode: mode});
      vaultManager.lock();
      result[mode] = {wrong: await outcome('Wrong-password!2026'), right: await outcome('Right-password!2026')};
    }
    console.log(JSON.stringify(result));
  } finally { await s.close(); }`;

test('unlock separates a wrong password from an account that cannot be loaded', () => {
  const env = { ...process.env };
  delete env.NICETRY_AGGREGATION_PROFILE;
  delete env.NICETRY_NATIVE_PROFILE;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  for (const mode of ['aa', 'native']) assert.deepEqual(result[mode].wrong, { code: 'WRONG_PASSWORD', message: 'Wrong password', unlocked: false });
  // ERC-4337 is deployed on the default network, so its account loads.
  assert.deepEqual(result.aa.right, { unlocked: true });
  // The default build has no native profile: the password is accepted, the account is not, and the vault stays locked.
  assert.equal(result.native.right.code, 'ACCOUNT_UNAVAILABLE');
  assert.equal(result.native.right.unlocked, false);
  assert.match(result.native.right.message, /^Your password is correct, but the wallet account could not be loaded: .*Native frame accounts are not available/);
});
