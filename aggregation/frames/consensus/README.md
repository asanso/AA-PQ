# Lighthouse aggregation transport prototype

> Historical component record. Implementation boundaries and measurements below
> describe this component at the time of its tests. For the current integrated
> client, wallet and live-test status, see [Native aggregation](../../../docs/native-aggregation-development.md).

Status: inactive. The original component implementation and its checks are
documented below. The complete client source candidate, build instructions and
activation constraints are now in [fork/README.md](fork/README.md). The results
below describe the earlier component tests, not the full fork's later checks.

The prototype preserves the complete proof and dependency commitment emitted by
the pinned execution client. Cryptographic proof verification remains in
Nethermind's native leanVM verifier. The wallet's SPHINCS-G profile is unchanged.

## Pinned inputs

| Component | Revision or version |
| --- | --- |
| Lighthouse | `e423a66763bb1bd780492d635123f208d80c3538` |
| Nethermind | `4a17b571f453d112bae5175a2e4966900201deae` |
| leanVM | `854997bd156f47f1b1ce2192c4499741f29bd0df` |
| Native proof ABI | `5` |
| Rust used for these checks | `1.99.0` |
| Native test runtime | .NET 10 |

The native guest verification key is
`9370d760abb55fdf02acc7e8d40688c425815c3d25a2aea3c030b2ae1ab51ace`.
Dependencies for the Rust probe are locked in `probe/Cargo.lock`.

The Lighthouse source archive used for the checks has SHA-256
`3f3193218d8f7228889505eb508c6176ea60a964fcfb072eb248787c1e242d4c`.
Preparation scripts reject incompatible base source and conflicting local edits.
Always apply them to a private source snapshot, not an active installation.

## Implemented components

- `aggregate_payload.rs` defines an extended SSZ payload and its blinded header.
  The payload contains the unchanged Electra payload, complete proof bytes and a
  32-byte dependency commitment. Proofs must be nonempty and at most 8 MiB, matching
  the pinned execution client's bound. This bound is not a security-strength claim.
- `aggregate_json.rs` preserves `recursiveStarkProof` and
  `recursiveStarkBlockDepsHash` through the actual Lighthouse Engine JSON types.
  Both fields are mandatory in this experimental schema.
- `aggregate_block_hash.rs` reconstructs the exact Prague-based execution header
  encoding used in the test: the ordinary Prague fields, two canonical padding
  values for absent BAL/slot fields, and the recursive-proof tuple. It does not
  claim support for a BAL-enabled Amsterdam payload.
- `probe` exercises the actual Lighthouse types and execution-layer crate. It
  writes SSZ to disk, reloads it, reconstructs Engine JSON and compares all fields.
  When a matching `*-engine-context.json` is present, it also verifies the execution
  block hash using the parent beacon root and execution requests.
- `NativeTransportChecks.cs.fragment` exports payloads from the real Nethermind
  DTO and imports the reconstructed payloads in an independent test process.
  The receiving process has no signature witnesses. It checks the block proof,
  executes the block and compares the resulting state root.

Existing Electra serialization, roots, fork selection and Engine dispatch are
unchanged. Full and blinded *extended payloads* have the same root. This does not
yet establish full/blinded beacon-block compatibility.

## Reproducing component checks

Use a private workspace with this layout. `authorization` and `wallet` are the
existing sibling prototype directories; `lighthouse` is a pristine pinned checkout.

```text
frames/
  authorization/
  wallet/
  consensus/
  lighthouse/
```

From `frames/consensus`, run:

```sh
python3 test_source_tools.py ../lighthouse
python3 apply.py ../lighthouse
cargo +1.99.0 test --locked --manifest-path probe/Cargo.toml
cargo +1.99.0 build --locked --manifest-path probe/Cargo.toml
```

The probe accepts an execution payload and an output directory:

```sh
probe/target/debug/daisugi-consensus-transport-checks \
  /path/to/wallet-block-0-engine.json /path/to/roundtrip-0
```

Place `wallet-block-0-engine-context.json` beside the input to require the block
hash comparison. Its fields are `parentBeaconBlockRoot` and `executionRequests`.
Check `checkedBlockHash` in the result; transport without that context is not a
block-hash verification.

To assemble the native test source, provide the unmodified original
`NativeBlockProductionTests.cs` from the pinned Nethermind revision and a new
output path under its private `Nethermind.Crypto.LeanFfi.Test` project:

```sh
python3 prepare-native.py /path/to/original/NativeBlockProductionTests.cs \
  /path/to/private-nethermind/src/Nethermind/Nethermind.Crypto.LeanFfi.Test/DaisugiPragueTransportTests.cs
```

The native test project must already have the matching native library, guest,
fixtures, restored dependencies and referenced assemblies built, following the
sibling prototype setup. `prepare-native.py` does not install these prerequisites.
Set `DAISUGI_WALLET_DIR` to a private output directory containing the public signed
fixture at `fixtures/wallet.json`, and make the pinned leanVM library available
through `LD_LIBRARY_PATH`.

Build and run only the intended producer tests from the private Nethermind root:

```sh
dotnet run --project src/Nethermind/Nethermind.Crypto.LeanFfi.Test/Nethermind.Crypto.LeanFfi.Test.csproj \
  -c release --no-restore -p:BuildProjectReferences=false \
  -p:DefineConstants=NATIVE_LEAN_TESTS -- \
  --filter 'FullyQualifiedName~DaisugiPragueTransportTests.Daisugi_wallet_rpc'
```

Round-trip the exported payloads with the Rust probe. For an independent receiver,
use a separate output directory with the encoded blocks and `roundtrip-0`,
`roundtrip-1`, and `roundtrip-empty` outputs. Its fixture preserves public genesis
runtime/configuration and sender addresses, but removes `factoryCreation` and all
transaction/signature-witness fields from `fixtures`. Run the compiled test
assembly in a fresh process with the filter
`FullyQualifiedName~DaisugiPragueTransportTests.Daisugi_engine_transport_import`.
The tests must not have network access or live RPC credentials.

## Verified results

The October 5 checks passed 19 Rust component tests, four source-preparation
checks, 12 native producer/admission tests and five native receiver tests.

Two accounts each submitted a signed first-send transaction and a subsequent
transaction through the native RPC module in memory. The resulting two blocks
contained proofs of 264,652 and 262,508 bytes. Both proofs survived Engine JSON,
SSZ disk persistence and reconstruction byte for byte. Lighthouse reconstructed
the same execution block hashes; the independent execution process reproduced
both state roots without the original signature witnesses.

A block with no dependencies also passed. Its 12-byte `NLR3` empty-set envelope
is the pinned verifier's explicit empty-claim representation, not a proof of a
signature and not an accepted substitute for a nonempty claim set.

Missing proof bytes fail decoding. Corrupted proof bytes fail native STARK
verification. An altered dependency commitment fails block-dependency validation.
The final tests retain EIP-3607 by explicitly disabling the upstream test harness's
automatic suppression of that rule. They still use synthetic genesis state,
test sealing and explicit canonical-head selection; beacon fork choice is not
exercised. No shared-chain transaction was submitted.

## Remaining integration work

1. Introduce a dedicated, disabled-by-default consensus fork and wire the extended
   payload into beacon blocks, state headers, Engine dispatch, storage and APIs.
   Preserve historical Electra fork tags, bytes, roots and signature domains.
2. Test signed full/blinded beacon blocks, validator compatibility, gossip and
   request/response transport, persistent stores and restart recovery. Validate
   complete message limits, including proof bytes.
3. Replay representative Daisugi history and cross the proposed transition using
   preserved state. Resolve the pinned execution fork's keyed-nonce encoding
   versus existing scalar-nonce native transactions before activation.
4. Measure cold and warm admission, proof generation and import against Daisugi's
   two-second slots. An earlier loaded test hit the upstream 250 ms simulation
   timeout; final warm tests do not establish cold-start availability.
5. Prepare exact client builds and a reviewed activation plan, followed by the
   gateway/factory configuration and wallet package for an authorized on-chain test.

No activation epoch/version has been selected. No full beacon-node build, live
Engine HTTP exchange, beacon-network propagation or production migration has been
verified. Existing services and chain configuration remain unchanged.
