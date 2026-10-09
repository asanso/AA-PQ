# Native frame aggregation: case 7 components

> Historical component record. Implementation boundaries and measurements below
> describe this component at the time of its tests. For the current integrated
> client, wallet and live-test status, see [Native aggregation](../../docs/native-aggregation-development.md).

Status: real recursive proof composition and independent verification tested.
This package does not implement EIP-8288 dependency frames, mempool networking,
block construction or aggregate authorization inside Nethermind.

The user approved starting with proofs over existing wallet signatures while
leaving dependency-mode and signing-domain decisions open. The current wallet,
account runtime, chain rules and signature algorithm are unchanged.

## Implemented behavior

The adapter uses the unchanged SPHINCS-G implementation and full recursive guest
at leanVM revision `b7b3b742af8dda100a0263b22c36e33963cc165c`.
It can:

- Check individual signatures before generating a leaf proof.
- Combine independently verified child proofs into a new proof, without raw
  signatures in the composition request.
- Select an explicitly covered subset of claims, removing overlap and omitted
  claims from the output statement.
- Verify the exact expected public-key/message set, reject unrelated XMSS or
  data-availability claims, and execute the complete native verifier checks.
- Expose a serialized, panic-contained C ABI for the standalone .NET probe.

`daisugi-frame-case7-sphincs-g-v0` identifies the adapter's JSON interface. It is
not a new signature algorithm, an EIP-assigned identifier or an activated fork.
Resource bounds are experimental: 16 output claims, four children and 1 MiB per
proof. Tested batches contain four distinct accounts. This is not a capacity
benchmark, cryptographic audit or hostile-input parser-hardening assessment.

## Verified results

On September 28, 2026, four retained public wallet signatures produced two leaf
proofs and a real recursive proof covering all four key/message pairs. A second
recursive level combined overlapping inputs and retained exactly two claims.

| Stage | Proof bytes | Proving time | In-process verification |
| --- | ---: | ---: | ---: |
| Leaf A, two signatures | 183,592 | 1,817 ms | 52 ms |
| Leaf B, two signatures | 183,816 | 1,121 ms | 38 ms |
| Combine both leaves, four claims | 204,096 | 3,922 ms | 35 ms |
| Combine overlapping proofs and retain two claims | 215,072 | 4,705 ms | 37 ms |

These are single observations with two CPU workers. Parent proving time starts
with both child proofs already available; it excludes their generation and
process initialization. The three proving phases for the four-claim result sum
to 6,860 ms. Measured subprocess wall times sum to approximately 10.32 seconds,
excluding the independent verification checks. The second-level pruning proof
is larger despite retaining fewer claims; size is not proportional to the number
of final claims alone. No gas measurement or bandwidth saving is established.

All 29 proof/CLI checks passed, including child-proof corruption, incomplete
coverage, altered messages/keys, missing/duplicate claims, truncation, trailing
bytes, invalid signatures and unsupported request profiles. Failures caused by
crashes or timeouts are explicitly not counted as successful rejection tests.

Seven standalone .NET-to-Rust checks passed. Verification of the four-account
recursive proof took 1,108.95 ms on first use and 48.39 ms on the next call.
Expected claims were reconstructed independently from the original transaction
envelopes and trusted account fixtures using the unchanged wallet codec.
Four envelope/account checks and 28 digest-tampering checks passed separately.
No new signature or private key was generated or loaded.

## Files

- `prover/src/`: Rust proof adapter and C ABI.
- `prover/leanvm-source-manifest.json`: retained hashes for 14 inspected pinned
  upstream source files. This is not an exhaustive archive manifest.
- `dotnet/`: standalone verifier-language probe; no Nethermind block processor.
- `tools/build.py`: bounded offline compilation into a new work directory.
- `tools/test-recursion.py`: real proof and rejection tests using public fixtures.
- `tools/test-dotnet.py`: offline SDK-container build and ABI tests.

## Reproduction

Use Linux with Python 3, the existing Rust 1.98.1 toolchain/cache and the exact
pinned leanVM source tree. The build has locked dependencies and makes no
network downloads. It validates the retained source manifest and creates a
symlink only inside the new build directory. The original source is not edited.

```sh
python3 tools/build.py \
  --source "$PWD" \
  --work "$RUN_ROOT/build" \
  --upstream "$LEANVM_SOURCE" \
  --manifest prover/leanvm-source-manifest.json \
  --tool-root "$RUST_TOOLS"

python3 tools/test-recursion.py \
  --binary "$RUN_ROOT/build/prover/target/release/daisugi-frame-aggregation" \
  --fixtures "$PUBLIC_FIXTURE_FILE" \
  --output "$RUN_ROOT/results"
```

`RUN_ROOT` must be a new run directory. `RUST_TOOLS` contains `cargo/` and
`rustup/`. The fixture JSON contains `claims` with the retained public fields
`pkSeed`, `pkRoot`, `message` and `signature`; this runner uses its first four
claims. Each key field uses the existing top-aligned 16-byte encoding in a
32-byte word. Keys are public; no secret seeds are required.

For the .NET check, place this package under `$RUN_ROOT/aggregation-frames` and
the independently reconstructed expected-claims request at
`$RUN_ROOT/independent-expected.json`. Then run:

```sh
python3 tools/test-dotnet.py --work "$RUN_ROOT" --image "$SDK_IMAGE_ID"
```

The SDK image must already exist locally and be identified by its immutable
`sha256:` ID. The temporary container has no network and mounts only the run
directory. It does not start a chain or access a chain database.

## Remaining integration

The proof API still receives expected claims from its caller. A production
execution-client path must derive those claims from actual transactions and
account authorization, then enforce them during pool admission and independent
block import. It must define signing-domain binding, resolve the dependency-mode
collision with POST_TX, pin guest/profile identity and implement proof transport,
fee/resource accounting, persistence and reorg handling.

The JSON interface and current claim commitment are not the EIP-8288 wire format
or dependency commitment. No case 7 end-to-end pass or live block acceptance is
claimed. Existing native and ERC-4337 flows remain unchanged.

Source remains uncommitted. Publication, live transactions and client activation
are outside this test. Detailed evidence is retained in
`.verification/case7-recursion/` in the management workspace.
