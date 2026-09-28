import { HdKeyring } from "../keyring/HdKeyring.js";
import { WatchKeyring } from "../keyring/WatchKeyring.js";
import { KEYRING_TYPES } from "../keyring/registry.js";
import {
  encryptVaultDetailed,
  encryptVaultWithKey,
  unlockVaultDetailed,
  decryptVaultWithKey,
  isLegacyVault,
} from "../crypto/encryption.js";
import { storageGet, storageSet, storageRemove } from "../utils/storage.js";

import {
  syncCachedFromVault,
  clearAllCachedSmartAccounts,
  syncAllAccountsMirror,
  clearAllAccountsMirror,
} from "../utils/sa-storage.js";

const VAULT_KEY = "nt_frame_vault_v1";
const SCHEMA_VERSION = 7;

const LEGACY_META_KEY = "nt_meta";
const LEGACY_SA_KEY = "SmartAccount";

const IMPORTED_INDEX_FLOOR = 10_000;

function removeStorageKeysByPrefix(prefixes) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (all) => {
        const keys = Object.keys(all || {}).filter((key) =>
          prefixes.some((prefix) => key.startsWith(prefix))
        );
        if (!keys.length) {
          resolve();
          return;
        }
        chrome.storage.local.remove(keys, resolve);
      });
    } catch {
      resolve();
    }
  });
}

export class VaultManager {
  constructor() {
    this.keyrings = [];
    this.password = null;
    /* Derived vault key ({ keyBytes, salt, iter }) established at unlock.
       It is what the popup session persists in chrome.storage.session
       instead of the raw password — see src/popup/session.js. While set,
       _persistVault re-encrypts with it (stable salt, fresh IV). */
    this.sessionKey = null;
    /* Multi-account state. accounts holds metadata ({ index, name }); the
       identity address of each account comes from the HD keyring. */
    this.accounts = [];
    this.activeAccountIndex = 0;
    this.activeAddress = null;

  this.perAccount = {};
  }

  /* ── Active chain / account helpers ─────────────────────────────── */
  getActiveChainId() {
    return globalThis.__NT_CHAIN_ID || null;
  }

  getActiveAccountIndex() {
    return this.activeAccountIndex || 0;
  }

  _resolveAccount(accountIndex) {
    return accountIndex == null ? this.activeAccountIndex : accountIndex;
  }

  /* Get (creating if needed) the per-account bucket. */
  _accountBucket(accountIndex) {
    const a=this._resolveAccount(accountIndex);
    return this.perAccount[a] ||= {smartAccountAddresses:{}};
  }

  /* Whether this account operates a per-device (mixed) hot chain. */

  getSmartAccountAddress(chainId, accountIndex) {
    const cid = chainId || this.getActiveChainId();
    if (!cid) return null;
    const b = this._accountBucket(accountIndex);
    return b.smartAccountAddresses[String(cid).toLowerCase()] || null;
  }

  get smartAccountAddress() {
    return this.getSmartAccountAddress();
  }

  async hasVault() {
    return !!(await storageGet(VAULT_KEY));
  }

  async createNewVault(password, { persist = true } = {}) {
    this.password = password;
    this.sessionKey = null; // re-derive from the new password on persist
    this.keyrings = [];
    this.perAccount = {};
    this.accounts = [];
    this.activeAccountIndex = 0;

  const hd = new HdKeyring();
    const mnemonic = hd.generateMnemonic();
    hd.addAccounts(1);
    this.keyrings.push(hd);

  this.accounts = [{ index: 0, name: "Account 1" }];
    this._accountBucket(0);
    this.activeAddress = hd.getIdentityAddress(0).toLowerCase();
    /* Mint the per-install device differentiator now, so it lives inside
       the authenticated vault from the start (not a swappable storage key). */

    // Onboarding passes { persist: false } so the vault stays in memory
    // until the user finishes the security-mode step and reaches the
    // final screen.
    if (persist) await this._persistVault();
    return mnemonic;
  }

  /* Restore from mnemonic. The wallet is fully determined by the seed
     phrase: the same phrase always reproduces the same accounts. */
  async restoreVault(password, phrase) {
    this.password = password;
    this.sessionKey = null; // re-derive from the new password on persist
    this.keyrings = [];
    this.perAccount = {};
    this.accounts = [];
    this.activeAccountIndex = 0;

  const hd = new HdKeyring({
      mnemonic: phrase,
      numberOfAccounts: 1,
    });
    this.keyrings.push(hd);

  this.accounts = [{ index: 0, name: "Account 1" }];
    this._accountBucket(0);
    this.activeAddress = hd.getIdentityAddress(0).toLowerCase();
    /* Fresh per-install device differentiator → different across two
       imports of the same seed (the core Problem-A separation), and stored
       inside the authenticated vault. */

  await this._persistVault();
    return hd.getAccounts();
  }

  async unlock(password) {
    const encrypted = await storageGet(VAULT_KEY);
    if (!encrypted) throw new Error("No vault found");

  const { data, keyBytes, salt, iter } = await unlockVaultDetailed(
      password,
      encrypted
    );
    this.password = password;
    this.sessionKey = { keyBytes, salt, iter };
    return this._applyDecryptedVault(data, encrypted);
  }

  /* Unlock with the derived session key persisted by the popup session
     (chrome.storage.session) — no raw password involved. GCM auth fails
     if the vault was re-encrypted with a different password since the
     key was derived. */
  async unlockWithKey(keyBytes) {
    const encrypted = await storageGet(VAULT_KEY);
    if (!encrypted) throw new Error("No vault found");

  const { data, salt, iter } = await decryptVaultWithKey(keyBytes, encrypted);
    this.password = null;
    this.sessionKey = { keyBytes: [...keyBytes], salt, iter };
    return this._applyDecryptedVault(data, encrypted);
  }

  /* The serializable session key the popup may stash in
     chrome.storage.session for password-free re-unlock. */
  getSessionKeyBytes() {
    return this.sessionKey ? [...this.sessionKey.keyBytes] : null;
  }

  _applyDecryptedVault(data) {
    if(data.meta?.schemaVersion!==7) throw Error('This vault belongs to a different account implementation. Import its seed into the native-frame build.');
    this.keyrings=data.keyrings.map(kr=>{const Klass=KEYRING_TYPES[kr.type];if(!Klass)throw Error('Unsupported keyring.');const instance=new Klass();instance.deserialize(kr.data);return instance;});
    this.perAccount=data.meta.perAccount || {};
    this.accounts=data.meta.accounts || [];
    this.activeAccountIndex=data.meta.activeAccountIndex || 0;
    this._syncAccountsWithKeyring();
    this.activeAddress=this.getHdKeyring().getIdentityAddress(this.activeAccountIndex).toLowerCase();
    syncCachedFromVault(this._accountBucket(this.activeAccountIndex).smartAccountAddresses).catch(()=>{});
    syncAllAccountsMirror(this._collectAllSmartAccountsPerChain()).catch(()=>{});
    return this.getAllAccounts();
  }

  _syncAccountsWithKeyring() {
    const hd = this.getHdKeyring();
    if (!hd) return;
    const n = hd.getNumberOfAccounts() || 0;
    if (!Array.isArray(this.accounts)) this.accounts = [];
    for (let k = 0; k < n; k++) {
      if (!this.accounts.find((a) => a.index === k)) {
        this.accounts.push({ index: k, name: `Account ${k + 1}` });
      }
      this._accountBucket(k);
    }
    this.accounts = this.accounts
      .filter(
        (a) =>
          Number.isInteger(a.index) &&
          (a.imported || a.index < Math.max(n, 1))
      )
      .sort((a, b) => a.index - b.index);
    if (this.accounts.length === 0) {
      this.accounts = [{ index: 0, name: "Account 1" }];
      this._accountBucket(0);
    }
    if (
      !this.accounts.find((a) => a.index === this.activeAccountIndex)
    ) {
      this.activeAccountIndex = 0;
    }

  for (const a of this.accounts) this._accountBucket(a.index);
  }

  /* Single source of truth for "is the vault open?". True after either
     a password unlock OR a session-key auto-unlock — so callers must NOT
     use `this.password` as an unlock proxy (it's null on key unlocks).
     Keyrings are the thing actually loaded on unlock and cleared on lock. */
  isUnlocked() {
    return this.keyrings.length > 0;
  }

  lock() {
    this.keyrings = [];
    this.password = null;
    this.sessionKey = null;
  }

  async deleteVault() {
    this.lock();
    this.accounts = [];
    this.activeAccountIndex = 0;
    this.activeAddress = null;
    this.perAccount = {};
    await Promise.all([
      storageRemove([VAULT_KEY, LEGACY_META_KEY, LEGACY_SA_KEY, "addresses"]),
      clearAllCachedSmartAccounts(),
      clearAllAccountsMirror(),
      removeStorageKeysByPrefix([
        "nt_txhistory_",
        "nt_lastSeenBlock_",
        "nt_backfillCursor_",
        "nt_backfillTarget_",
        "nt_tokens_",
      ]),
    ]);
  }

  async _persistVault() {
    if (!this.password && !this.sessionKey) throw new Error("Vault is locked");
    const data = {
      keyrings: this.keyrings.map((kr) => ({
        type: kr.type,
        data: kr.serialize(),
      })),
      meta: {
        schemaVersion: SCHEMA_VERSION,
        activeAccountIndex: this.activeAccountIndex,
        accounts: this.accounts,
        activeAddress: this.activeAddress,
        perAccount: this.perAccount,
        /* Per-install device differentiator, INSIDE the GCM-authenticated
           blob so it can't be swapped via a chrome.storage edit. */
      },
    };
    let encrypted;
    if (this.sessionKey) {
      /* Session-key path: reuse the vault's salt/iter with a fresh IV so
         the derived key persisted by the popup session keeps matching
         the stored envelope across saves. */
      encrypted = await encryptVaultWithKey(this.sessionKey, data);
    } else {
      const det = await encryptVaultDetailed(this.password, data);
      encrypted = det.encrypted;
      this.sessionKey = { keyBytes: det.keyBytes, salt: det.salt, iter: det.iter };
    }
    await storageSet(VAULT_KEY, encrypted);

    /* Clear mirrors track the ACTIVE account's SAs. */
    syncCachedFromVault(
      this._accountBucket(this.activeAccountIndex).smartAccountAddresses
    ).catch(() => {});

    /* And the per-chain union across every multi-account, for the BG
       incoming-tx poller. */
    syncAllAccountsMirror(this._collectAllSmartAccountsPerChain()).catch(() => {});
  }

  _collectAllSmartAccountsPerChain() {
    const out = {};
    const buckets = this.perAccount || {};
    for (const a of Object.keys(buckets)) {
      const bucket = buckets[a];
      const map = bucket?.smartAccountAddresses || {};
      for (const [cid, addr] of Object.entries(map)) {
        if (!addr) continue;
        const k = String(cid).toLowerCase();
        if (!out[k]) out[k] = [];
        out[k].push(addr);
      }
    }
    return out;
  }

  addKeyring(type, opts = {}) {
    const Klass = KEYRING_TYPES[type];
    if (!Klass) throw new Error(`Unknown keyring type: ${type}`);
    const kr = new Klass(opts);
    this.keyrings.push(kr);
    return kr;
  }

  removeKeyring(index) {
    if (index < 0 || index >= this.keyrings.length)
      throw new Error("Invalid keyring index");
    if (index === 0 && this.keyrings[0].type === "HD Key Tree")
      throw new Error("Cannot remove the primary HD keyring");
    this.keyrings.splice(index, 1);
  }

  getKeyrings() {
    return this.keyrings;
  }

  getKeyringsByType(type) {
    return this.keyrings.filter((kr) => kr.type === type);
  }

  getKeyringForAccount(address) {
    const lower = address.toLowerCase();
    for (const kr of this.keyrings)
      if (kr.getAccounts().includes(lower)) return kr;
    return null;
  }

  getAllAccounts() {
    const accounts = [];
    for (const kr of this.keyrings)
      for (const addr of kr.getAccounts()) accounts.push(addr);
    return accounts;
  }

  getAccountsWithType() {
    const result = [];
    for (let i = 0; i < this.keyrings.length; i++) {
      const kr = this.keyrings[i];
      for (const addr of kr.getAccounts()) {
        result.push({
          address: addr,
          type: kr.type,
          keyringIndex: i,
          isActive: addr === this.activeAddress,
        });
      }
    }
    return result;
  }

  /* ── Multi-account management ───────────────────────────────────── */

  getAccountList() {
    const hd = this.getHdKeyring();
    return (this.accounts || [])
      .slice()
      .sort((a, b) => {
        const pa = a.pinned ? 0 : 1;
        const pb = b.pinned ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.index - b.index;
      })
      .map((a) => ({
        index: a.index,
        name: a.name || `Account ${a.index + 1}`,
        hidden: !!a.hidden,
        pinned: !!a.pinned,
        imported: !!a.imported,
        pending: !!a.pending,
        hdAccountIndex: Number.isInteger(a.hdAccountIndex) ? a.hdAccountIndex : null,
        importedFrom: a.importedFrom || null,
        importedChainId: a.importedChainId || null,
        transferred: a.transferred && typeof a.transferred === "object" ? { ...a.transferred } : null,
        identityAddress: hd && !a.imported ? hd.getIdentityAddress(a.index) : null,
        smartAccount: this.getSmartAccountAddress(undefined, a.index),
        isActive: a.index === this.activeAccountIndex,
      }));
  }

  /* Create a new multi-account from the same seed. Returns
     { index, address } where address is the account's identity. */
  async addAccount(name) {
    const hd = this.getHdKeyring();
    if (!hd) throw new Error("No HD keyring found");
    const identity = hd.addAccount();
    const newIndex = hd.getNumberOfAccounts() - 1;
    this.accounts.push({
      index: newIndex,
      name: name || `Account ${newIndex + 1}`,
    });
    this._accountBucket(newIndex);
    await this._persistVault();
    return { index: newIndex, address: identity };
  }

  async addHdAccount() {
    const { address } = await this.addAccount();
    return address;
  }

  async setActiveAccount(index) {
    if (!this.accounts.find((a) => a.index === index))
      throw new Error(`Account ${index} not found`);
    this.activeAccountIndex = index;
    const hd = this.getHdKeyring();
    if (hd) this.activeAddress = hd.getIdentityAddress(index).toLowerCase();
    await this._persistVault(); // also re-syncs clear mirrors to this account
    return index;
  }

  async renameAccount(index, name) {
    const a = this.accounts.find((acc) => acc.index === index);
    if (!a) throw new Error(`Account ${index} not found`);
    a.name = name;
    await this._persistVault();
    return a;
  }

  /* Hide / show an account. Hidden accounts stay derivable from the seed
     (the metadata flag only affects the UI list). Refuses to hide the
     last visible account; the caller (useAccounts) is responsible for
     switching the active account away first if needed. */
  async setAccountHidden(index, hidden) {
    const a = this.accounts.find((acc) => acc.index === index);
    if (!a) throw new Error(`Account ${index} not found`);
    if (hidden) {
      const visible = this.accounts.filter((x) => !x.hidden);
      if (visible.length <= 1)
        throw new Error("Cannot hide the only visible account");
    }
    a.hidden = !!hidden;
    await this._persistVault();
    return a;
  }

  async setAccountPinned(index, pinned) {
    const a = this.accounts.find((acc) => acc.index === index);
    if (!a) throw new Error(`Account ${index} not found`);
    a.pinned = !!pinned;
    await this._persistVault();
    return a;
  }

  getHdAccountIndex(index) { return this._resolveAccount(index); }

  /* Flip the `pending` flag on an account. Used when the receiver-side
     polling detects that the giver's transfer has landed and the
     pre-created account entry should become fully usable. */

  async importPrivateKey() {
    throw new Error("Private-key import is disabled in this native-frame wallet");
  }

  async addWatchAddress(address) {
    let watch = this.keyrings.find((kr) => kr.type === "Watch Address");
    if (!watch) {
      watch = new WatchKeyring();
      this.keyrings.push(watch);
    }
    const addr = watch.addAddress(address);
    await this._persistVault();
    return addr;
  }

  async removeAccount(address) {
    const kr = this.getKeyringForAccount(address);
    if (!kr) throw new Error("Account not found in any keyring");
    kr.removeAccount(address);
    if (this.activeAddress === address.toLowerCase()) {
      const accounts = this.getAllAccounts();
      this.activeAddress = accounts[0] || null;
    }
    await this._persistVault();
  }

  async setActiveAddress(address) {
    const lower = address.toLowerCase();
    if (!this.getAllAccounts().includes(lower))
      throw new Error("Address not found");
    this.activeAddress = lower;
    /* If this address is an HD account identity, keep activeAccountIndex
       in sync so per-account state follows the selection. */
    const hd = this.getHdKeyring();
    if (hd) {
      const idx = hd.getAccountIndexForAddress(lower);
      if (idx >= 0) this.activeAccountIndex = idx;
    }
    await this._persistVault();
  }

  async signTransaction() {
    throw new Error("Transaction signing is disabled by the native-frame account");
  }
  async signMessage() {
    throw new Error("Message signing is disabled by the native-frame account");
  }
  async signPersonalMessage() {
    throw new Error("Message signing is disabled by the native-frame account");
  }
  async signTypedData() {
    throw new Error("Typed-data signing is disabled by the native-frame account");
  }

  exportAccount() {
    throw new Error("Per-account key export is disabled in this native-frame wallet");
  }

  exportMnemonic() {
    const hd = this.keyrings.find((kr) => kr.type === "HD Key Tree");
    if (!hd) throw new Error("No HD keyring found");
    return hd.exportMnemonic();
  }

  getHdKeyring() {
    return this.keyrings.find((kr) => kr.type === "HD Key Tree") || null;
  }

  /* Back-compat alias for older callers; same few-time check. */

  /* ── Per-account-per-chain smart-account address ────────────────── */
  async setSmartAccountAddress(address, chainId, accountIndex) {
    const cid = String(chainId || this.getActiveChainId() || "").toLowerCase();
    if (!cid) throw new Error("setSmartAccountAddress: no chainId in scope");
    const b = this._accountBucket(accountIndex);
    if (address) {
      b.smartAccountAddresses[cid] = address;
    } else {
      delete b.smartAccountAddresses[cid];
    }
    await this._persistVault();
  }

  async persist() {
    await this._persistVault();
  }

  getActiveAccountDetails() {
    const hd = this.getHdKeyring();
    const idx = this.activeAccountIndex;
    const meta = (this.accounts || []).find((a) => a.index === idx);
    return {
      index: idx,
      name: meta?.name || `Account ${idx + 1}`,
      address: this.activeAddress,
      identityAddress: hd ? hd.getIdentityAddress(idx) : this.activeAddress,
      type: this.getHdKeyring() ? "HD Key Tree" : "unknown",
      smartAccount: this.getSmartAccountAddress(),
      accounts: [this.activeAddress].filter(Boolean),
    };
  }
}

export const vaultManager = new VaultManager();
