const accountIdentityPath = account => "m/44'/60'/"+account+"'/0'/0'";
import { HDNodeWallet } from "ethers/wallet";
import { Mnemonic } from "ethers/wallet";









export class HdKeyring {
  static type = "HD Key Tree";
  type = "HD Key Tree";

  constructor(opts = {}) {
    this._accounts = []; // [{ accountIndex, identityAddress }]
    this._mnemonic = null;
    this._root = null;
    this._numberOfAccounts = 0;

    if (opts.mnemonic) this.deserialize(opts);
  }

  serialize() {
    // numberOfAccounts records how many multi-accounts exist so
    // deserialize() can re-derive their identity addresses.
    return {
      mnemonic: this._mnemonic,
      numberOfAccounts: this._numberOfAccounts,
    };
  }

  deserialize(opts = {}) {
    if (opts.mnemonic) {
      this._mnemonic = opts.mnemonic;
      this._buildRoot();
    }
    if (opts.numberOfAccounts) {
      this._accounts = [];
      this._numberOfAccounts = 0;
      this.addAccounts(opts.numberOfAccounts);
    }
  }

  _buildRoot() {
    if (!this._mnemonic) throw new Error("HdKeyring: no mnemonic");
    // Root from the bare BIP-39 seed (no passphrase): the wallet is
    // recovered from the seed phrase alone.
    this._root = HDNodeWallet.fromSeed(
      Mnemonic.fromPhrase(this._mnemonic).computeSeed()
    );
  }

  generateMnemonic() {
    // 12 words / 128-bit entropy (user's choice). The spec
    // (docs/nicetry_scheme.md Stage 1) suggests 24 words / 256-bit;
    // import still accepts either length since BIP-39 supports both.
    const entropy = new Uint8Array(16);
    crypto.getRandomValues(entropy);
    const hex =
      "0x" +
      Array.from(entropy, (b) => b.toString(16).padStart(2, "0")).join("");
    this._mnemonic = Mnemonic.fromEntropy(hex).phrase;
    this._buildRoot();
    return this._mnemonic;
  }

  /* Add `n` new multi-accounts. Each account's identity is a stable,
     chain-independent label (accountIdentityPath — sentinel chain 0').
     Returns the newly added identity addresses (lower-cased). */
  addAccounts(n = 1) {
    if (!this._root)
      throw new Error(
        "No HD root available. Generate or import a mnemonic first."
      );

    const added = [];
    for (let i = 0; i < n; i++) {
      const accountIndex = this._numberOfAccounts;
      const child = this._root.derivePath(accountIdentityPath(accountIndex));
      const entry = {
        accountIndex,
        identityAddress: child.address,
      };
      this._accounts.push(entry);
      added.push(entry.identityAddress.toLowerCase());
      this._numberOfAccounts++;
    }
    return added;
  }

  /* Single multi-account convenience. Returns its identity address. */
  addAccount() {
    return this.addAccounts(1)[0];
  }

  getAccounts() {
    return this._accounts.map((a) => a.identityAddress.toLowerCase());
  }

  getAccountIndexForAddress(address) {
    const lower = address.toLowerCase();
    const e = this._accounts.find(
      (a) => a.identityAddress.toLowerCase() === lower
    );
    return e ? e.accountIndex : -1;
  }

  getIdentityAddress(accountIndex = 0) {
    const e = this._accounts.find((a) => a.accountIndex === accountIndex);
    if (e) return e.identityAddress;
    // Derive on demand if not materialised yet (chain-independent label).
    if (!this._root) throw new Error("No HD root");
    return this._root.derivePath(accountIdentityPath(accountIndex)).address;
  }

  removeAccount(address) {
    const lower = address.toLowerCase();
    const idx = this._accounts.findIndex(
      (a) => a.identityAddress.toLowerCase() === lower
    );
    if (idx === -1)
      throw new Error(`Address ${address} not found in this keyring`);
    this._accounts.splice(idx, 1);
  }

  signTransaction() {
    throw new Error("Transaction signing is disabled for the SPHINCS identity key");
  }
  signMessage() {
    throw new Error("Message signing is disabled for the SPHINCS identity key");
  }
  signPersonalMessage() {
    throw new Error("Message signing is disabled for the SPHINCS identity key");
  }
  signTypedData() {
    throw new Error("Typed-data signing is disabled for the SPHINCS identity key");
  }

  exportMnemonic() {
    return this._mnemonic;
  }


  getKeyAtIndex(index,account=0,chainId=0) {
    if(index!==0 || Number(chainId)!==0) throw Error('Native accounts use one stable SPHINCS identity key.');
    if(!this._root)throw Error('No HD root');
    const path=accountIdentityPath(account),child=this._root.derivePath(path);
    return {index,account,path,address:child.address,privateKey:child.privateKey};
  }




  getRoot() {
    return this._root;
  }

  getMnemonic() {
    return this._mnemonic;
  }

  getNumberOfAccounts() {
    return this._numberOfAccounts;
  }
}
