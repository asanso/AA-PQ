import {NETWORK} from './network-profile.mjs';

// The signature scheme of the network's native frame accounts: how their clones carry the public key, how the
// factory creates them and what it logs. Daisugi's first network uses SPHINCS-G accounts; the devnets use
// leanSPHINCS accounts (frame-account LeanSphincsFrameAccountFactory).
export const NATIVE_ACCOUNT_SCHEMES = Object.freeze({
  'sphincs-g': Object.freeze({
    name:'SPHINCS-G', keyBytes:64,
    createAccount:'function createAccount(bytes32 pkSeed,bytes32 pkRoot,bytes32 salt)',
    accountCreated:'event AccountCreated(address indexed account,bytes32 indexed salt,bytes32 pkSeed,bytes32 pkRoot)',
  }),
  'lean-sphincs': Object.freeze({
    name:'leanSPHINCS', keyBytes:32,
    createAccount:'function createAccount(bytes32 publicKey,bytes32 salt)',
    accountCreated:'event AccountCreated(address indexed account,bytes32 indexed salt,bytes32 publicKey)',
  }),
});

export const NATIVE_ACCOUNT_SCHEME = NATIVE_ACCOUNT_SCHEMES[NETWORK.nativeAccountScheme];
