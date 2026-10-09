# Native aggregate account authorization

> Historical component record. Implementation boundaries and measurements below
> describe this component at the time of its tests. For the current integrated
> client, wallet and live-test status, see [Native aggregation](../../../docs/native-aggregation-development.md).

This inactive prototype connects SPHINCS-G signing, dependency-aware pool admission,
native leanVM proof production, account authorization and state execution. It uses
the pinned client and proof interface documented in `../integration/README.md`.
It does not deploy an account, update a wallet distribution or activate a fork.

The account-defined signing policy is specified in `PROFILE.md`. The signature
algorithm and original NiceTry 2.1.3 module are unchanged. `account.mjs` builds a
small experimental EVM account runtime and computes its authorization digest.
The runtime has not been audited and is not a replacement for existing accounts.

## Test scope

The producer submits two actual frame transactions to the client's pool. Each
contains DEP_VERIFY, VERIFY and SENDER frames. The pool requires verified signature
witnesses. The block producer generates one real leanVM proof covering both
dependencies. The account reconstructs each transaction's intent before APPROVE;
SENDER calls a contract with nonempty calldata and transfers test ETH in memory.

A separate process imports the encoded block with an empty witness store. It runs
the real suggested-block validator, including native proof verification, followed
by EVM processing and resulting-state checks. Missing or corrupt proofs must fail
the first stage. A changed recipient with an otherwise valid proof must fail
account authorization during processing. The proof and the account check are
both necessary.

The harness uses upstream production transaction validation, pool, EVM, proof and
block-processing modules. Genesis state is synthetic; sealing is the upstream
test sealer with a permissive seal validator. Header, transaction, uncle and proof
validation run, but this is not a consensus-layer, Engine API or P2P transport test.
The upstream test harness also disables EIP-3607 for its test accounts. No live RPC
is used, and no separate chain service is started.

Negative tests cover recipient, value, calldata, fee caps, execution/state gas,
nonce, nonce key, legacy nonce encoding, chain, sender, key substitution, frame
layout and a real signature authorizing an unrelated message.

## Reproduce

Use Linux x86-64 with AVX2, Node.js 22, Python 3.11 or later, Rust 1.99.0 and
.NET SDK 10.0.401. The project's frontend dependencies must already be installed.
Use new private output directories outside the source checkout. Preparation
refuses existing outputs or a modified upstream test file.

```sh
project=/path/to/dev-testnet
source="$project/aggregation/frames/authorization"
integration="$project/aggregation/frames/integration"
work=/path/to/new-private-build
run=/path/to/new-private-authorization-run
signer=/path/to/extracted-original-wallet/chunks/sphincs.js

python3 "$integration/prepare.py" --workspace "$work"
export CARGO_BUILD_JOBS=1 LEANVM_NUM_THREADS=2 RAYON_NUM_THREADS=2
export RUSTFLAGS='-C target-cpu=haswell'
cargo +1.99.0 build --release --locked \
  --manifest-path "$work/upstream/nethermind/tools/lean-ffi/Cargo.toml"
python3 "$source/install-client-checks.py" --nethermind "$work/upstream/nethermind"
mkdir "$run"
node --experimental-vm-modules "$source/prepare-fixtures.mjs" \
  "$project" "$signer" "$run/fixtures"

export LD_LIBRARY_PATH="$work/upstream/nethermind/tools/lean-ffi/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DOTNET_PROCESSOR_COUNT=2 DOTNET_CLI_TELEMETRY_OPTOUT=1
export DAISUGI_AUTH_DIR="$run"
dotnet run --project "$work/upstream/nethermind/src/Nethermind/Nethermind.Crypto.LeanFfi.Test/Nethermind.Crypto.LeanFfi.Test.csproj" \
  -c release -p:DefineConstants=NATIVE_LEAN_TESTS -- \
  --filter 'FullyQualifiedName~Daisugi_dependency_account&FullyQualifiedName!~imports'

python3 "$source/prepare-receiver.py" --source "$run" --output "$run/receiver"
export DAISUGI_AUTH_DIR="$run/receiver"
dotnet "$work/upstream/nethermind/src/Nethermind/artifacts/bin/Nethermind.Crypto.LeanFfi.Test/release/Nethermind.Crypto.LeanFfi.Test.dll" \
  --filter 'FullyQualifiedName~Daisugi_dependency_account_imports'
```

The original signer SHA-256 is checked before execution:
`117d793ce26f1a7fe152ce23884a03cd07663758b044d397f72eff5b901584ce`.
Only newly generated, temporary test seeds are used. No signing seed is written;
public fixtures contain transaction fields, code, messages and signatures. Treat
the native proof and block hashes as local test artifacts, not explorer links.

For strict receiver isolation, launch the second command in a separate container
with only the receiver directory mounted as `DAISUGI_AUTH_DIR`; do not mount the
producer fixtures there. Both processes need the built client and native library.
The recorded run used two CPU workers and 6 GiB RAM per SDK container, with no
published ports, shared-chain database or Docker socket mounted.

## Before activation

Remaining work includes factory/first-deployment support, extension integration,
witness transport, account-profile review, fork transition and CL/Engine API tests.
The three-frame policy assumes an existing account; it does not include a factory
creation frame. The pinned EIP-8288 prototype requires keyed nonces, so accepting
the old frame bytes in a codec is insufficient for a wallet migration.

The native proof interface is ABI 5 / NLR3 with Keccak dependency commitments.
It is distinct from the separately tested official `block-deps-hash` one-hop
format. No Solidity aggregate verifier or gas-saving claim follows from these
checks. Client proof-verification time and the prototype's gas schedule are
different quantities.
