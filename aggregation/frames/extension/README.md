# NiceTry Daisugi — native frames preview

An experimental Daisugi testnet wallet. It keeps the original NiceTry interface and
offers one transaction mode: native frame transactions (EIP-8141) whose account
verifies a leanSPHINCS signature in its VERIFY frame. Aggregated frames, ERC-4337
and the SPHINCS-G signer have been removed. Test ETH only; the code has not been
audited.

## Signature scheme

leanSPHINCS as specified by leanEthereum/leanVM `crates/lean_sphincs` at
`f7ba4999ae523b94c8d0969b32762c3effea4cbd`, the revision Nethermind pins for
EIP-8288 scheme `0x10` on Daisugi devnet-1: Keccak-256, 32-byte public keys
(`PK.seed || PK.root`), 7,740-byte signatures, at most 2^30 signatures per key.

- `lean-sphincs-wasm/` exports that crate's key generation, signing and verification
  to WebAssembly through a plain C ABI. `lean-sphincs-wasm/build.sh` rebuilds
  `src/crypto/lean-sphincs.wasm` with the pinned toolchain and `Cargo.lock`, and
  checks it byte for byte. Paths are remapped, so the binary holds no local names.
- `src/crypto/lean-sphincs-core.mjs` loads it; `src/native-frame/signer.worker.js`
  derives the key, signs a transaction digest and verifies the signature before
  returning it. Signing is deterministic and takes about 0.1 s on a recent laptop.
- Key derivation is a provisional wallet convention: no upstream specification
  defines one. `SK.seed = keccak256("daisugi:lean-sphincs:sk-seed:v1" || k)`, where
  `k` is the account's BIP-32 identity key at `m/44'/60'/{account}'` (hardened, with no
  chain or index level). The tag separates these keys from any other scheme's. A
  different future derivation would change account addresses.

## Accounts

Accounts are `LeanSphincsFrameAccount` clones from
`LeanSphincsFrameAccountFactory` (`frame-account/`): 77-byte EIP-1167 runtimes that
carry the public key and call the pinned `LeanSphincsVerifier`. The first transaction
of an account creates it in a DEFAULT frame before its VERIFY and SENDER frames.
The wallet gives the VERIFY frame 100,000 gas, the public-mempool validation limit
(`MAX_VERIFY_GAS`) of the EIP-8141 draft. On Daisugi devnet-0, with the verifier at
`0x6965C62Ad830067492f1b5528AAeF376a4AC4f76`, two wallet transactions used 84,156 and
84,377 VERIFY frame gas (blocks 42999 and 43004; the first also created the account,
53,677 gas in its DEFAULT frame). The verifier itself uses about 77,000 of that; the
account's checks, witness copy and call account for the rest. The total gas of a send
from an existing account was 322,730 with this verifier and with the earlier one: on
that network the cost of the 7,740-byte signature, not the verification, sets the
total.

The vault key stays `nt_aggregate_vault_v1`, schema 10. A vault set up for aggregated
frames or ERC-4337 is refused with a request to reset it and restore the recovery
phrase. A restored phrase yields a new leanSPHINCS account address; funds of earlier
accounts do not move.

## Building

Install the locked dependencies with `npm ci`. A build needs an active native
profile and explicit public HTTPS endpoints, and writes to a separate directory:

```sh
NICETRY_NATIVE_PROFILE=/absolute/path/to/native-deployment.json \
NICETRY_RPC_URL=https://your-dev-host.example/rpc \
NICETRY_EXPLORER_URL=https://your-dev-host.example/explorer \
npm run build -- --outDir nicetry-native-preview
```

The profile holds `active: true`, `chainId`, `genesisHash`, `eip8288Format`
(`eip8288-lean`), `maxFeePerGas`, and the addresses and runtime code hashes of the
factory, implementation and verifier (`factory`, `factoryCodeHash`,
`implementation`, `implementationCodeHash`, `verifier`, `verifierCodeHash`). The
build checks that the pins are complete; before signing, the wallet compares the
chain, genesis, contract code, the factory's implementation and verifier, and the
account code. Never enable a profile before its contracts are deployed and checked.

## Tests

`npm test` covers the WASM signer against EthLib's vectors, the key derivation,
transaction encoding and signing against known answers generated from the
contracts, the native client's submission, journal and recovery, the build profile
and the encrypted vault. `frame-account` checks the same known answers against the
deployed contracts on Anvil. Neither runs a native frame transaction: that needs the
Nethermind client.

See [HTTPS-PREVIEW.md](HTTPS-PREVIEW.md) for installation.
