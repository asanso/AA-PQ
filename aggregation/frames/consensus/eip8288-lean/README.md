# Daisugi Lighthouse for upstream EIP-8288 (`feature/eip8288-lean`)

Status: source package, inactive by default. It does not install clients, schedule
a fork or replace the live Daisugi deployment. The live chain keeps using
[`../fork`](../fork), which this package leaves unchanged.

## What this is

A Lighthouse patch series for the EIP-8288 format implemented upstream in Nethermind's
`feature/eip8288-lean` branch, pinned in `sources.lock.json`. **Nethermind needs no
overlay**: build that branch commit as is. The legacy Nethermind overlay in
`../fork` is for the live chain only.

The pinned Nethermind commit is **interim** (`revisionStatus` in the lock): it is
the commit this patch series was validated against, not the deployable release. It
is the merge of NethermindEth/nethermind#15721, which keeps EIP-7843 off unless it is
scheduled, so a Prague-based chain keeps the zero slot placeholder. Its Git tree
equals the PR head `b0e83c01bf` that the series was validated against. `previouslyValidated` keeps the earlier pin, `0260e692fc`, whose
EIP-8141 rules differ (see [EIP-8141 rules](#eip-8141-rules)). Its
standard artifacts don't include the native Lean library yet (see
[Fresh genesis](#fresh-genesis)). Once Nethermind takes that library from a pinned
NuGet package, a later `feature/eip8288-lean` commit replaces this pin, and the
acceptance steps below run again against it.

The series starts from `../fork`'s Lighthouse overlay (same base, Lighthouse
v8.2.2 `e423a667`, same `Daisugi` fork, SSZ tag 8) and changes it as follows.

| | `../fork` (live Daisugi) | This package |
| --- | --- | --- |
| Engine payload field | `recursiveStarkProof` + `recursiveStarkBlockDepsHash` | `starkProof` only |
| Header commitment | proof and dependency hash in the payload | derived by the EL: `keccak256(stark_proof)` and `block_deps_hash` (BLAKE2s, `eip8288/leanstark-deps` domain) |
| Proof when a block has no dependencies | 12-byte empty-set envelope | empty bytes |
| Block hash in Lighthouse | header rebuilt from the payload's proof and payload-supplied dependency hash | header rebuilt from `keccak256(starkProof)` and a dependency hash Lighthouse derives from the frame transactions (`execution_layer/src/daisugi_block_hash.rs`); an undecodable frame transaction makes the block hash check fail |
| Rebuilt payload bodies (`engine_getPayloadBodies*`) | proof carried | proof carried and checked against the stored header root |
| Aggregate-payload helpers (`aggregate_block_hash.rs`, `aggregate_json.rs`) | present | removed |
| `Dockerfile.reproducible` | upstream v8.2.2 (bullseye, no longer builds) | v8.3.2 bookworm backport, static zlib, `portable` BLS, fixed `SOURCE_DATE` |

This format is **not compatible with the live chain**. It needs a fresh EL and CL
genesis.

### EIP-8141 rules

Lighthouse decodes frame transactions in two places: the dependency hash of the block
hash check (`daisugi_block_hash.rs`) and the blob hashes of optimistic sync
(`versioned_hashes.rs`). Both follow the pinned Nethermind commit:

- `compute_sig_hash` replaces the signature bytes of empty-`msg` entries with their
  length (ethereum/EIPs#12502). A zero `data_hash` dependency resolves to this hash.
- `fees` is `[max_fee, max_priority_fee_per_gas]` (NethermindEth/nethermind#14374).

A block produced under `0260e692fc` (signature bytes elided, three fee items) does
not reproduce, and this series refuses its frame transactions.

## Source preparation

The patches in `patches/lighthouse` apply to the pinned Lighthouse source archive.
`sources.lock.json` pins the archive sha256, each patch's sha256 and the Git tree
ids before and after the series. Requirements: Python 3.12 or later and Git.

From this directory:

```sh
python3 -m unittest discover -p 'test_*.py'
revision=$(jq -r .lighthouse.revision sources.lock.json)
curl -fsSL -o lighthouse.tar.gz "https://github.com/sigp/lighthouse/archive/$revision.tar.gz"
python3 apply.py lighthouse lighthouse.tar.gz ./lighthouse --check
python3 apply.py lighthouse lighthouse.tar.gz ./lighthouse
```

`apply.py`:
- refuses an archive whose sha256 differs from the lock;
- refuses patches that differ from the lock and patches the lock doesn't list;
- refuses archive members that are absolute, contain `..` or leave the top
  directory; Git refuses patch paths outside the tree, under `.git` or through a
  symlink;
- extracts the archive into a staging directory next to the output and checks
  its tree against `pristineTree`;
- applies each patch with `git apply`, ignoring the user's and the system's Git
  configuration: no fuzz, no three-way merge, no rejects;
- checks the result against `patchedTree`, then renames the staging tree to the
  output. Any failure removes the staging directory and leaves the output absent;
- reports `already-patched` and changes nothing when the output already holds
  `patchedTree`, and refuses an output with any other content.

Tree ids are computed like `git write-tree` from the files alone (contents, the
executable bit, symlinks; no `.git`, no ignore rules, no line-ending conversion),
so `git rev-parse <commit>^{tree}` gives the same value for the commit the series
reproduces.

### Archive hash mismatch

GitHub generates source archives on request and has changed their compression
before. If `apply.py` reports `Source archive differs from sources.lock.json`,
check whether only the packaging changed:

```sh
mkdir archive-check && tar -xzf lighthouse.tar.gz -C archive-check
python3 -c 'import sys, pathlib, apply; print(apply.tree_hash(pathlib.Path(sys.argv[1])))' \
  "archive-check/lighthouse-$revision"
```

- The output equals `pristineTree`: the source is unchanged. Update
  `archiveSha256` in its own reviewed commit, with the old and new sha256.
- Any other output: the source differs. Do not update the lock.

### Provenance

- `0001` imports `../fork`'s Lighthouse overlay verbatim from AA-PQ `a4b1d73`
  (introduced by GianlucaFelli in `3bfba07`), attributed to that author.
- `0002`-`0010` are the EIP-8288 changes, with their original authors and
  messages. `sources.lock.json` maps each one to its original commit.

### Updating the series

1. Recreate the series as commits on the pinned revision: `git am --keep-cr
   patches/lighthouse/*.patch` on a checkout of `e423a667` (`--keep-cr` keeps the
   CRLF lines that `0001` carries).
2. Add or amend commits.
3. Export: `git format-patch --binary --full-index --zero-commit --no-signature
   -o patches/lighthouse <revision>..HEAD`, after removing the old files.
4. Update `sources.lock.json`: each patch's sha256 and `patchedTree`
   (`git rev-parse HEAD^{tree}`). Add a new upstream revision, its
   `archiveSha256` and `pristineTree` together.
5. Run the unit tests, `apply.py` on the archive, and the acceptance steps below.
   A source change that alters the build also changes the image hash below.

## Tests

```sh
cd lighthouse
cargo test --release --locked -p execution_layer daisugi
cargo test --release --locked -p lighthouse_network --lib daisugi
cargo test --release --locked -p execution_layer -p types
```

The `daisugi_block_hash` tests reproduce Nethermind's cross-client vector and two
real devnet blocks, one of them proof-bearing with zero `data_hash` dependencies
(`src/test_fixtures`), and check that a proof-bearing block hashed under the earlier
rule no longer reproduces. The `versioned_hashes` tests read the blob hashes of
Nethermind-encoded frame transactions.

The `beacon_chain` suite on the Daisugi fork:

```sh
FORK_NAME=daisugi cargo test --release --locked --features fork_from_env,slasher/lmdb -p beacon_chain --no-fail-fast
```

437 tests pass. Four fail with the same errors on `../fork`, so they come from the
existing overlay's test harness, not this format:
`check_all_blocks_from_altair_to_fulu`, `verify_block_for_gossip_slashing_detection`,
`rpc_blobs_with_invalid_header_signature` and
`range_sync_block_construction_fails_with_wrong_blob_count`.

## Reproducible image

```sh
cd lighthouse
docker build -f Dockerfile.reproducible --platform linux/amd64 \
  --build-arg RUST_TARGET=x86_64-unknown-linux-gnu -t lighthouse:eip8288-lean-amd64 .
docker build -f Dockerfile.reproducible --platform linux/arm64 \
  --build-arg RUST_TARGET=aarch64-unknown-linux-gnu \
  --build-arg RUST_IMAGE="rust:1.91-bookworm@sha256:20262682d0201e219012287e8c1e6a7a14b6ebd46bb2b280714f23c06678c285" \
  -t lighthouse:eip8288-lean-arm64 .
```

Build each architecture on a host of that architecture. Two `--no-cache` builds
must produce the same `/lighthouse` sha256. The image is distroless; the
entrypoint is `/lighthouse`.

`SOURCE_DATE` defaults to the commit time of the pinned Lighthouse revision, because
the source archive has no `.git` for the Makefile to read it from.

## Fresh genesis

Execution (Geth-style `genesis.json` for Nethermind `feature/eip8288-lean`):
- Prague active at genesis;
- `eip8141PrototypeTime` at genesis;
- `eip8288PrototypeTime` at the Daisugi fork boundary;
- no `osakaTime`, `amsterdamTime` or `bogotaTime`;
- no `daisugiLegacyFrames`.

Nethermind options:
- `--TxPool.FrameTxMaxVerifyGas=500000`;
- `--Blocks.SecondsPerSlot` equal to the CL slot;
- the `Eth` JSON-RPC module, for `eth_sendProofWrapper`.

Nethermind also needs its native Lean library (`libnethermind_lean.so`) next to
the binary. At the interim commit, the standard Dockerfile and release artifacts
don't include it: build it from `tools/lean-ffi` (`cargo build --release --locked`)
or with `-p:BuildLeanFfi=true`, and copy it beside the binary.

Consensus (`config.yaml`):
- Electra at genesis;
- `DAISUGI_FORK_VERSION` unique to the network;
- `DAISUGI_FORK_EPOCH` equal to the EL `eip8288PrototypeTime` boundary;
- Fulu and Gloas unscheduled: a scheduled Fulu would replace the Daisugi payload format;
- `MAX_PAYLOAD_SIZE` large enough for the proof plus transactions (20 MiB recommended).

Beacon nodes that must accept peers need `--target-peers` above 0.

## Acceptance

On a disposable network, never against the shared Daisugi endpoints:

1. Genesis: the EL genesis hash equals the CL genesis state's execution block hash, and Nethermind passes its EIP-8288 startup check.
2. Fork boundary: the last pre-fork block is `electra` with a 21-field header; the first fork block is `daisugi` with a 25-field header and an empty `starkProof`, at the timestamp equal to `eip8288PrototypeTime`.
3. Proof-bearing block: a frame transaction with leanSig and leanSTARK dependencies, submitted with `eth_sendProofWrapper`, is included with a non-empty `starkProof`. Corrupted wrappers are rejected.
4. Independent validation: an empty Nethermind and Lighthouse pair syncs over P2P to the same block hashes, state roots, receipts and proof bytes. The chain finalizes past the proof-bearing block.
5. Lighthouse and Nethermind logs show no invalid-block or Engine errors after startup.
