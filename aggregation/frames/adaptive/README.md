# Adaptive signature aggregation candidate

Status: opt-in experimental integration, disabled unless explicitly activated.
This package does not deploy an application, install a client, schedule a fork,
submit a transaction or change an existing wallet.

## Behavior

The wallet continues to submit the existing SPHINCS-G signature and dependency
declaration through `eth_sendProofWrapper`. The signing algorithm, account
authorization, factory, transaction encoding and dependency commitment are
unchanged. Adaptive batching is a client-side production policy.

The background producer selects at most 40 unique dependencies. A full batch
starts immediately. A partial batch has a minimum formation period of 500 ms;
its dispatch deadline also considers the observed proving time and the phase
of the two-second block clock. Therefore 500 ms is not a maximum queue wait or
an inclusion guarantee. The policy updates its service estimate after each job.
One persistent process produces proofs with 14 threads. The execution process
independently verifies each result, without sharing the prover's mutable arena.

The builder selects transactions covered by one prepared proof group. This keeps
ordinary raw-signature proving outside the proposal path. Removing transactions
from a prepared group can still require recursive pruning during production.
The 40-dependency production policy does not change the 256-dependency consensus
bound, the 8-MiB proof limit or gas accounting.

Before publishing a completed adaptive proof to the shared proposal cache, the
producer checks that every selected transaction is still pending. A result whose
selection changed during proving is discarded from that cache; the next cycle
builds a proof for the remaining transactions. This prevents that known stale
selection from initiating unnecessary recursive pruning on the proposal path.
Other causes of pruning, including state changes after this check, remain possible.
A ready group is retained for up to six seconds while all its transactions remain
pending, instead of immediately proving an overlapping larger selection. This
three-slot grace period is a local production policy; it changes no consensus
rule and does not guarantee inclusion. Once any member leaves the pool, the next
cycle can prepare the remaining transactions. The time bound permits reconsidering
an unproductive selection when new transactions arrive.

## Program identity and compatibility

The larger guest has a different verification key. The original native library
remains installed for historical blocks and existing signature verification.
The adaptive library is loaded separately. Before activation only the original
recursive program is accepted; after activation either recognized program can
validate a block. The specification of the block being checked controls this
decision, not the current head. Unknown keys and invalid proofs are rejected.

Activation requires chain 1337, EIP-8288 and an explicit
`config.daisugiAdaptiveAggregationTime` in a Geth-style configuration, or
`params.daisugiAdaptiveAggregationTransitionTimestamp` in a chain specification.
Both are absent by default. No timestamp has been selected by this package.

Pending recursive wrappers must use the current production guest. Generated
proof caches are cleared when that identity changes; pinned original witnesses
are retained. Pending inputs from another guest are skipped rather than composed
with the current guest. Clients holding an old recursive wrapper must rebuild it
from the original witnesses after activation. Historical block verification still
accepts the program permitted by that block's specification. Recursive composition
across guest identities is not implemented. Admission verdicts and production
caches are scoped by program identity.

The proof envelope and Lighthouse payload schema are unchanged. The optimized
guest still requires compatible execution clients on every participating node.
The October 9 packaged-client rehearsal exercised Engine/Lighthouse transport,
original and adaptive proofs, forty signed wallet transactions in one block,
restart from persisted history and finalization beyond that block. This is a
bounded integration check, not an interoperability qualification of external nodes.

## Source preparation

Start from the Nethermind revision and existing consensus overlay recorded in
`../consensus/fork/sources.lock.json`. This overlay is incremental to that source.
Apply it only to a private checkout:

```sh
python3 -m unittest discover -s aggregation/frames/adaptive -p test_apply.py
python3 aggregation/frames/adaptive/apply.py /private/nethermind --check
python3 aggregation/frames/adaptive/apply.py /private/nethermind
```

For the optimized native library, use a separate checkout of Marchhill/leanVM
at `854997bd156f47f1b1ce2192c4499741f29bd0df`, named `leanvm`, next to a copy of
`native/ffi` named `ffi`. Apply the native overlay with
`apply.py /private/native/leanvm --component leanvm`. The source and lockfile
checksums are recorded in `native/source-manifest.json`. No SPHINCS crate file
is modified. Preserve the upstream license notices.

Build the FFI with Rust 1.99.0, the checked-in lockfile, release optimization,
`RUSTFLAGS='-C target-cpu=native'`, `CARGO_PROFILE_RELEASE_LTO=thin` and
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`. Its output is named
`libnethermind_lean.so`; place a copy in the private runtime as
`libnethermind_lean_adaptive.so`. Preserve the original `libnethermind_lean.so`
there. CPU-native binaries must be rebuilt for a different CPU architecture.

Build `worker.rs` against the adaptive library with Rust 1.99.0, optimization and
an `$ORIGIN` runtime library search path. Place `daisugi-lean-worker` beside the
managed executable and both libraries. The worker uses bounded stdin/stdout
messages, has no listener, and receives public witnesses rather than private
keys. The existing `DAISUGI_BENCH_*` names are retained to match the measured
native implementation; only the child enables those optimization switches.

Build the managed client with its pinned .NET SDK and `BuildLeanFfi=false`.
No binary or generated proof is included in the proposed source package.
Resource limits must leave capacity for consensus, RPC and other services;
the worker's thread count does not override its enclosing CPU quota.

## Verification and rollout boundary

Private checks cover real native proof verification, explicit activation,
historical program acceptance, invalid proof rejection, worker recovery,
adaptive scheduling and wallet-wrapper admission through real client modules.
The wallet integration uses retained signatures and an in-memory chain with
synthetic funded state. An independent receiver processes the encoded block
without receiving the original signature witnesses. This is not a transaction
submitted to the shared Daisugi network or a browser-extension test.

The October 9 private run passed 14 adaptive integration cases, followed by the
expanded independent-receiver wallet case. All 153 proof-service regression
cases and both overlay preflight tests passed. The chain-specification suite
passed 290 of 292 cases. Its two failures also occur in the retained baseline:
the generic parameter-mapping test's `DaisugiLegacyFrames` default check and the
upstream test that assumes enabling EIP-8288 also reschedules EIP-8141. The suite
is not fully green; those expectations need an explicit resolution before release.

The follow-up queue fixes passed all 156 proof-service tests, including three
adaptive cases in `AdaptiveQueueTests.cs`. Place this test file in the private
`Nethermind.Consensus.Test/ProofAggregation` directory. Those tests isolate queue
behavior with a fixed-verdict test backend; native cryptographic validity is
covered by the separate integration checks, not by that test backend.

`AdaptiveIntegrationTests.cs` and `AdaptiveWalletTests.cs` are native integration
harnesses. Copy them into `Nethermind.Crypto.LeanFfi.Test` in the private checkout,
install both real libraries and the worker beside its test assembly, and use
`DAISUGI_ADAPTIVE_FIXTURES` for the public proof/request fixtures and
`DAISUGI_AUTH_DIR` for the authorization fixture directory. Build with
`BuildLeanFfi=false` and `DefineConstants=NATIVE_LEAN_TESTS`, then run the test
assembly with `--filter FullyQualifiedName~Adaptive`. These tests require the
separately retained fixtures; the source package is not a self-contained release
test bundle. Never replace either verification library with the startup stub.

The earlier approximately 20-signature/s result is an offline warm-prover
benchmark for 40-signature batches. It is not measured sustained throughput or
wallet-to-inclusion latency for this integration. Live measurements must report
proving, queueing and inclusion separately. Overload, cancellation and long-running
resource behavior remain experimental limitations; the worker has a bounded
request/response protocol and a 120-second timeout with process recovery.

The staging portal and production portal use the same Daisugi chain. Publishing
or deploying staging does not activate the new prover. Client activation needs
a separately reviewed rollout, compatible peer revisions, an explicit timestamp
and authorization to replace or restart shared services.
