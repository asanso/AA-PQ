import { getAddress } from "ethers";

export class WatchKeyring {
  static type = "Watch Address";
  type = "Watch Address";

  constructor(opts = {}) {
    this._addresses = [];
    if (opts.addresses) this.deserialize(opts);
  }

  serialize() {
    return { addresses: [...this._addresses] };
  }

  deserialize(opts = {}) {
    this._addresses = (opts.addresses || []).map((a) => a.toLowerCase());
  }

  addAccounts(_n = 1) {
    return [];
  }

  addAddress(address) {
    try {
      getAddress(address);
    } catch {
      throw new Error("Invalid Ethereum address");
    }
    const lower = address.toLowerCase();
    if (this._addresses.includes(lower))
      throw new Error("Address already watched");
    this._addresses.push(lower);
    return lower;
  }

  getAccounts() {
    return [...this._addresses];
  }

  removeAccount(address) {
    const idx = this._addresses.indexOf(address.toLowerCase());
    if (idx === -1) throw new Error(`Watch address ${address} not found`);
    this._addresses.splice(idx, 1);
  }

  signTransaction() {
    throw new Error("Watch-only account cannot sign transactions");
  }
  signMessage() {
    throw new Error("Watch-only account cannot sign messages");
  }
  signPersonalMessage() {
    throw new Error("Watch-only account cannot sign");
  }
  signTypedData() {
    throw new Error("Watch-only account cannot sign");
  }
  exportAccount() {
    throw new Error("Watch-only account has no private key");
  }
}
