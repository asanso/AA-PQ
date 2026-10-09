import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { VaultManager } from '../src/vault/VaultManager.js';
import { transactionMode, requireTransactionMode } from '../src/config/transaction-mode.js';
import { encryptVaultDetailed, unlockVaultDetailed } from '../src/crypto/encryption.js';

const phrase = 'test test test test test test test test test test test junk';
const password = 'Isolated-vault-test!2026';
const vaultKey = 'nt_aggregate_vault_v1';
let stored;
beforeEach(() => {
  stored = {};
  transactionMode.value = null;
  globalThis.chrome = { storage: { local: {
    get(keys, callback) { const result = keys === null ? {...stored} : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); callback?.(result); return Promise.resolve(result); },
    set(values, callback) { Object.assign(stored, structuredClone(values)); callback?.(); return Promise.resolve(); },
    remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; callback?.(); return Promise.resolve(); },
  } } };
});

test('setup requires an explicit supported mode before creating or importing any vault', async () => {
  for (const mode of [undefined, null, '', 'secp', 'FRAME', '__proto__']) {
    assert.throws(() => requireTransactionMode(mode));
    const vault = new VaultManager();
    await assert.rejects(vault.createNewVault(password, {transactionMode: mode}));
    await assert.rejects(vault.restoreVault(password, phrase, {transactionMode: mode}));
    assert.equal(vault.isUnlocked(), false);
    assert.equal(stored[vaultKey], undefined);
  }
});

for (const mode of ['frame', 'aa']) {
  test(`${mode}: authenticated mode and account metadata survive password and session-key unlock`, async () => {
    const vault = new VaultManager();
    await vault.restoreVault(password, phrase, {transactionMode: mode});
    const identity = vault.getHdKeyring().getIdentityAddress(0);
    await vault.addAccount('Second account');
    const key = vault.getSessionKeyBytes();
    const {data} = await unlockVaultDetailed(password, stored[vaultKey]);
    assert.equal(data.meta.transactionMode, mode);
    assert.equal(data.meta.schemaVersion, 10);
    assert.equal(JSON.stringify(stored[vaultKey]).includes(phrase), false);
    const epoch = vault.sessionEpoch;
    vault.lock();
    assert.ok(vault.sessionEpoch > epoch);
    assert.throws(() => vault.getTransactionMode(), /Unlock/);
    await vault.unlock(password);
    assert.equal(vault.getTransactionMode(), mode);
    assert.equal(transactionMode.value, mode);
    assert.equal(vault.getAccountList().length, 2);
    assert.equal(vault.getHdKeyring().getIdentityAddress(0), identity);
    vault.lock();
    const reopened = new VaultManager();
    await reopened.unlockWithKey(key);
    assert.equal(reopened.getTransactionMode(), mode);
    assert.equal(reopened.getHdKeyring().getIdentityAddress(0), identity);
    await assert.rejects(reopened.restoreVault(password, phrase, {transactionMode: mode === 'frame' ? 'aa' : 'frame'}), /already exists/);
    assert.equal(reopened.getTransactionMode(), mode);
  });
  test(`${mode}: new wallet creation records the choice only when setup is completed`, async () => {
    const vault = new VaultManager();
    await vault.createNewVault(password, {transactionMode: mode, persist: false});
    assert.equal(stored[vaultKey], undefined);
    assert.equal(vault.getTransactionMode(), mode);
    await vault.persist();
    assert.equal((await unlockVaultDetailed(password, stored[vaultKey])).data.meta.transactionMode, mode);
  });
}

test('missing or unsupported encrypted mode and older vault schemas are rejected', async () => {
  for (const meta of [{schemaVersion:10}, {schemaVersion:10, transactionMode:'unknown'}, {schemaVersion:9, transactionMode:'frame'}]) {
    stored[vaultKey] = (await encryptVaultDetailed(password, {meta, keyrings:[]})).encrypted;
    const vault = new VaultManager();
    await assert.rejects(vault.unlock(password));
    assert.equal(vault.isUnlocked(), false);
  }
});

test('the aggregation namespace does not import existing native, unified or ERC-4337 vaults', async () => {
  stored.nt_frame_vault_v1 = {fixture: true};
  stored.nt_unified_vault_v1 = {fixture: true};
  stored.nt_sphincs_aa_vault_v1 = {fixture: true};
  assert.equal(await new VaultManager().hasVault(), false);
  const vault = new VaultManager();
  await vault.restoreVault(password, phrase, {transactionMode:'aa'});
  await vault.deleteVault();
  assert.equal(await vault.hasVault(), false);
  assert.deepEqual(stored.nt_frame_vault_v1, {fixture: true});
  assert.deepEqual(stored.nt_unified_vault_v1, {fixture: true});
  assert.deepEqual(stored.nt_sphincs_aa_vault_v1, {fixture: true});
  assert.equal(transactionMode.value, null);
});
