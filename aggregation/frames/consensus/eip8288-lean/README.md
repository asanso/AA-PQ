# Daisugi Lighthouse for the EIP-8288 restart

The Lighthouse that runs the fresh-genesis Daisugi network lives on a fork:
[`manusw7/lighthouse` `daisugi/eip8288-lean`](https://github.com/manusw7/lighthouse/tree/daisugi/eip8288-lean),
pinned at `16a05d1e17a22d132933e3ec927a6f1b9daf0b1a`.

- Base: `sigp/lighthouse` v8.2.2 `e423a66763bb1bd780492d635123f208d80c3538`.
- The first 14 commits are this directory's former patch series 0001-0014 (#10), unchanged: 0001 imports
  [`../fork`](../fork)'s Lighthouse overlay (GianlucaFelli), 0002-0014 are the EIP-8288 changes.
- `16a05d1e1` logs a rejected Daisugi block hash at warn level.
- The branch is frozen for Daisugi: changes are appended as new commits, never rewritten, and announced to
  EthPandaOps, which builds its images from the branch.
- Build: [`docs/LOCAL-DEVNET.md`](../../../../docs/LOCAL-DEVNET.md), step 1. Not compatible with the live chain
  ([`../fork`](../fork)): it needs a fresh EL and CL genesis.

## Deviations from EIP-8288

Two choices follow Nethermind `feature/eip8288-lean` (#15829), not a settled EIP-8288:

- `DEPS_HASH` is Keccak-256; the EIP leaves it TBD.
- The generic leanSTARK scheme `0x11` is accepted beside leanSPHINCS `0x10`. Its entries are hashed in a second
  list under the `eip8288/leanstark-deps` domain.

The engine payload carries `starkProof` only. The header commits to `keccak256(stark_proof)` and to a dependency
hash that Lighthouse derives from the frame transactions, and Lighthouse checks the block hash on every Daisugi
block it executes (gossip, lookup, range sync, local publish): a mismatch rejects the block whatever the EL answers.

## EIP-8141 rules

Lighthouse decodes frame transactions for the dependency hash (`execution_layer/src/daisugi_block_hash.rs`) and
for optimistic sync blob hashes (`versioned_hashes.rs`), following the pinned Nethermind commit:

- `compute_sig_hash` replaces the signature bytes of empty-`msg` entries with their length (ethereum/EIPs#12502).
  A zero `data_hash` dependency resolves to this hash.
- `fees` is `[max_fee, max_priority_fee_per_gas]` (NethermindEth/nethermind#14374).

## Tests

From a checkout of the fork:

```sh
cargo test --release --locked -p execution_layer daisugi
cargo test --release --locked -p lighthouse_network --lib daisugi
cargo test --release --locked -p execution_layer -p types
cargo test --release --locked -p beacon_chain --test beacon_chain_tests daisugi
FORK_NAME=daisugi cargo test --release --locked --features fork_from_env,slasher/lmdb -p beacon_chain --no-fail-fast
```

The last suite passes 438 tests. Four fail with the same errors on [`../fork`](../fork), so they come from the
inherited overlay's test harness: `check_all_blocks_from_altair_to_fulu`,
`verify_block_for_gossip_slashing_detection`, `rpc_blobs_with_invalid_header_signature` and
`range_sync_block_construction_fails_with_wrong_blob_count`.
