# EIP-8288 development integration

> Historical component record. Implementation boundaries and measurements below
> describe this component at the time of its tests. For the current integrated
> client, wallet and live-test status, see [Native aggregation](../../../docs/native-aggregation-development.md).

This package checks real NiceTry SPHINCS-G signatures against the upstream
leanVM dependency-proof implementations and Nethermind's block-proof validator.
It is an inactive development candidate. It does not change the Daisugi node,
fork configuration, account contracts, wallet, RPC endpoints or deployment scripts.

## Pinned implementations

| Component | Revision | Commitment and proof format |
| --- | --- | --- |
| Nethermind `feature/eip8288-lean` | `4a17b571f453d112bae5175a2e4966900201deae` | Mode 4 dependencies; Keccak-256 of canonical 96-byte triples; ABI 5 / NLR3 |
| Its native leanVM dependency | `854997bd156f47f1b1ce2192c4499741f29bd0df` in `Marchhill/leanVM` | The mixed guest pinned by the upstream native library |
| leanEthereum/leanVM `block-deps-hash` | `f33f31bf7c1191667e29a68a3acae63b9164c1c6` | BLAKE2s-256 of sorted, unique `message || public key`; proof without public-key payload |

These two proof interfaces are not interchangeable. The checks verify both and
explicitly reject a one-hop reference proof at the Nethermind interface.
Replacing only a dependency revision, hash function or guest key is insufficient.
`sources.lock.json` records immutable source revisions and archive hashes.

The wallet signature implementation is unchanged. The fixtures use its compact
H_msg SPHINCS-G profile, not the withdrawn v2 verifier. A signature is 6,176 bytes;
that length is not a statement of security strength.

## Reproduce the checks

Requirements: Linux x86-64 with AVX2, Python 3.11 or later, Node.js 22, Rust
1.99.0 and .NET SDK 10.0.401. The project frontend dependencies must already be
installed. Keep all build outputs in a new private workspace outside the checkout.
This workflow neither installs tools nor starts a node.

Set these absolute paths for your environment:

```sh
integration=/path/to/dev-testnet/aggregation/frames/integration
project=/path/to/dev-testnet
work=/path/to/new-private-check-directory
claims=/path/to/retained-wallet-claims.json
transactions=/path/to/retained-frame-transactions.json
```

The claims file contains `claims[]` with `pkSeed`, `pkRoot`, `message` and
`signature`. The key words contain 16 significant bytes followed by 16 zero bytes.
The first two retained signatures are checked. No private key or new signature
is required. The transaction fixture is an array with `raw` and `digest` fields
for at least two legacy scalar-nonce frame transactions. Do not use a key export.

```sh
python3 "$integration/prepare.py" --workspace "$work"
export CARGO_BUILD_JOBS=1 LEANVM_NUM_THREADS=2 RAYON_NUM_THREADS=2
export RUSTFLAGS='-C target-cpu=haswell'
cargo +1.99.0 build --release --locked --manifest-path "$work/build/one-hop/Cargo.toml"
cargo +1.99.0 build --release --locked --manifest-path "$work/upstream/nethermind/tools/lean-ffi/Cargo.toml"
node "$integration/prepare-fixtures.mjs" "$claims" "$project" "$work/fixtures"
cp -- "$transactions" "$work/fixtures/legacy-transactions.json"
python3 "$integration/test-one-hop.py" \
  --binary "$work/build/one-hop/target/release/daisugi-block-deps-probe" \
  --fixtures "$work/fixtures" --output "$work/one-hop-results"
python3 "$integration/test-nethermind-native.py" \
  --library "$work/upstream/nethermind/tools/lean-ffi/target/release/libnethermind_lean.so" \
  --fixtures "$work/fixtures" --one-hop-proof "$work/one-hop-results/one-hop.bin" \
  --output "$work/nethermind-results"
export DAISUGI_PROOF_DIR="$work"
export LD_LIBRARY_PATH="$work/upstream/nethermind/tools/lean-ffi/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DOTNET_PROCESSOR_COUNT=2 DOTNET_CLI_TELEMETRY_OPTOUT=1
dotnet run --project "$work/upstream/nethermind/src/Nethermind/Nethermind.Crypto.LeanFfi.Test/Nethermind.Crypto.LeanFfi.Test.csproj" \
  -c release -p:DefineConstants=NATIVE_LEAN_TESTS -- --filter 'FullyQualifiedName~Daisugi_'
```

Preparation and test output directories must not already exist. A failed run is
retained for diagnosis. The Rust CLI uses the upstream low-memory prover setup;
it does not reserve the default 640 GiB virtual-memory arena. Run proof commands
with CPU and memory limits on a shared host. The recorded run used two CPU workers,
one Cargo build job and a 10 GiB native-process address-space ceiling. Managed
checks used an isolated SDK container with two CPUs and 6 GiB RAM, no published
ports and no chain database or Docker socket mounted.

## What the checks establish

- The retained wallet signatures verify through both real native implementations.
- Both proofs bind their expected dependency commitments and reject altered
  claims, verification keys and proof bytes.
- The real upstream `BlockValidator` and native verifier accept the retained
  SPHINCS-G proof, bind it to dependency frames in the block body and reject
  tampering, including a changed body with a recomputed header commitment.
- Legacy frame serialization and the signature digest can be checked separately.

The block tests reuse upstream structural-validator doubles. Their synthetic
transactions contain dependency frames, not a complete account authorization
sequence. Passing them does not demonstrate mempool admission, EVM authorization,
state execution, Engine API interoperability or live block import.

## Remaining integration work

1. Agree the proof interface with the client implementation. The smaller
   `block-deps-hash` proof cannot be fed directly into the pinned NLR3 verifier.
2. Specify and test the account authorization digest. Embedding the canonical
   transaction digest inside its own dependency data is self-referential. The
   existing wallet account still requires its individual signature; simply adding
   a dependency frame does not remove that verification.
3. Integrate the agreed account path, wallet construction, witness transport and
   mempool/block-production checks. Test rejection of altered recipients, values,
   nonces and dependency declarations, then execute complete transactions in
   isolated state tests. Do not use an unrelated secp256k1 authorization path as
   evidence of SPHINCS-only authorization.
4. Review fork activation, existing 500,000 verification-gas behavior, Engine API
   and consensus-client compatibility before proposing any Daisugi node update.
   Historical codec compatibility alone does not establish migration safety.

No EVM aggregate-verifier gas measurement or live aggregated transaction is
produced by this package. Native verification time is not transaction gas.
