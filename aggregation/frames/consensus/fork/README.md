# Daisugi consensus-fork candidate

Status: these pinned overlays are active on the Daisugi testnet. This source
package preserves inactive configuration defaults and does not itself install
clients, schedule a fork or deploy contracts. See the
[current integration record](../../../../docs/native-aggregation-development.md)
for the activation and verified live transactions. The instructions below are
for reproducing and reviewing the client source, not replaying an activation.

## Protocol boundary

The explicit `Daisugi` Lighthouse fork extends Electra with the complete
`recursiveStarkProof` and `recursiveStarkBlockDepsHash` in execution payloads and
payload headers. Full and blinded beacon blocks commit to the same payload root.
The consensus fork uses SSZ tag 8, appended without changing historical tags, and
has an independently configured epoch and version. Both are unset by default.
Fulu and Gloas must remain disabled for this candidate.

Nethermind verifies the block's exact required dependency set with the pinned
native leanVM verifier and SPHINCS-G guest. Lighthouse preserves the proof through
Engine JSON, SSZ, storage and block processing. It does not replace verification
with a trusted cache or perform STARK verification itself. The wallet signer and
guest verification key are unchanged; revision pins are in `sources.lock.json`.

The execution overlay preserves proof-bearing payload-body responses. The Engine
REST SSZ body format cannot represent these fields and explicitly rejects them;
the supported path uses Engine JSON. The overlay also prevents the new prototype
label from rescheduling the chain's existing EIP-8141 activation.

## Private source preparation

Use separate pristine source snapshots at the revisions in `sources.lock.json`.
Keep the following layout so the probe's path dependencies resolve:

```text
fork/
  lighthouse/       # pinned upstream source plus this overlay
  nethermind/       # pinned upstream source plus this overlay
  overlays/
  probe/
  tests/
```

Run from this directory:

```sh
python3 -m unittest test_apply.py test_activation.py
python3 apply.py lighthouse ./lighthouse --check
python3 apply.py nethermind ./nethermind --check
python3 apply.py lighthouse ./lighthouse
python3 apply.py nethermind ./nethermind
cargo +1.99.0 build --locked --release --manifest-path lighthouse/Cargo.toml -p lighthouse
cargo +1.99.0 test --locked --manifest-path probe/Cargo.toml -- --test-threads=1
dotnet restore nethermind/src/Nethermind/Nethermind.Runner/Nethermind.Runner.csproj --locked-mode
dotnet publish nethermind/src/Nethermind/Nethermind.Runner/Nethermind.Runner.csproj \
  -c release -r linux-x64 --no-restore --self-contained false -o .private/nethermind
```

The overlay tool verifies all anchors and file hashes before writing. Conflicting
edits abort the operation; reapplying matching source is safe. It never runs Git.
Build prerequisites include the upstream C/C++ toolchain, OpenSSL development
files, libclang, protoc, Rust 1.99.0 and the pinned .NET SDK. Use resource limits on
a shared host. Build the matching `tools/lean-ffi` library and preserve its guest
identity; publishing the managed executable does not supply that library.

## Verification layers

The Rust probe covers fork dispatch, historical SSZ compatibility, signed and
blinded blocks, state transition, disk recovery, execution hashes and complete
proof transport. Retained fixtures are required through
`DAISUGI_TRANSPORT_FIXTURES`, `DAISUGI_BODY_FIXTURES` and `DAISUGI_PUBLIC_STATE`.
Tests that require these inputs must not be reported as executed without them.

`tests/` adds real Engine handler and payload-body checks to the existing native
transport harness. Assemble the five files with `prepare_native.py`, using the
pinned unmodified `NativeBlockProductionTests.cs` and a private test project as
its two arguments. Use only synthetic
accounts and private test directories. `DAISUGI_WALLET_DIR` selects public signed
fixtures and output; `LD_LIBRARY_PATH` selects the pinned native library. Receiver
checks must run without the original signature witnesses. An accepted mock payload
is not evidence of native proof verification.

`beacon_engine_check` connects the real Lighthouse beacon-chain harness to the
private HTTP Engine harness. Its genesis, deterministic validator keys and test
sealing are test-only. It must never target a shared Engine endpoint. The actual
node deployment, validator services and public wallet route are separate checks.

After compiling the native test project with `NATIVE_LEAN_TESTS`, start its
`Daisugi_http_beacon_engine_cycle` test in a disposable network namespace with
`DAISUGI_WALLET_DIR` pointing to the signed public fixtures. It listens on loopback
port 8188 by default. Run `probe/target/debug/beacon_engine_check
http://127.0.0.1:8188` while that test is active. For a container, set
`DAISUGI_PRIVATE_ENGINE_BIND=http://+:8188/` inside the container and publish only
an ephemeral host-loopback port. The HTTP test endpoint has no authentication and
must never be exposed publicly. Both processes must exit successfully; retain
`beacon-engine.json` and the final JSON client result. Failure of either process
is a failed integration check, even if preceding component tests passed.

## Activation constraints

Read [ACTIVATION.md](ACTIVATION.md) before proposing a rollout. No activation
version, epoch, deployed factory or public wallet profile is selected here.
Upstream EIP-8250 behavior rejects scalar-nonce native submissions after activation.
The explicit `config.daisugiLegacyFrames: true` setting in a Geth-style genesis
(or `params.daisugiLegacyFrames` in a Parity-style chain spec) retains that format
on chain 1337. It is disabled by default and takes effect only after EIP-8141.
It preserves the signed envelope and the existing 500,000-gas verification-prefix
budget. The operator must also retain `TxPool.FrameTxMaxVerifyGas=500000`; increasing
only that operator limit does not change the simulation cap. No configuration is
installed by this source package.

Scalar nonces and keyed `[0]` consume the same account nonce. The compatibility
profile does not transform signed transactions, skip SPHINCS verification or bypass
the block proof required by aggregated transactions. An existing native account
continues using its existing factory, runtime and individual signature. The new
aggregation account remains a separate, explicitly deployed account type.
ERC-4337 retains its EntryPoint submission path.

Proof-bearing RLP headers require a zero placeholder before the proof when the
slot-number extension is inactive. Header validation accepts that exact placeholder
only with EIP-8288 and a proof field; nonzero slot numbers remain invalid. This
preserves the bytes and hash when a valid block is decoded from persistent storage.

The consensus transport budget must accommodate proofs: the prepared setting is
20 MiB, with an 8 MiB proof bound. A 12-byte empty-set envelope means no required
claims; it cannot replace a proof for transactions that require authorization.
Background proving can require several slots. A two-second slot is not a promise
of a two-second proof or immediate inclusion.

Local admission timeouts remain bounded by the existing execution-client policy.
The wallet may retry the same signed wrapper once after observing a later block;
it stops if the chain does not progress, the session locks or preparation expires.
An `already known` response alone is not evidence of acceptance or inclusion.

`tests/DaisugiPragueTransportTests.Compatibility.cs` covers current-wallet creation
and transfers, mixed blocks, independent import, malformed proofs, signature
tampering, shared nonce replay protection and a real EntryPoint UserOperation.
Set `DAISUGI_COMPATIBILITY_DIR` to the retained public fixtures `legacy-wallet.json`,
`nonce-fixtures.json`, `aa-fixture.json` and `live-genesis-public.json`; set
`DAISUGI_WALLET_DIR` to the aggregation fixtures. The tests use synthetic state and
test sealing. They do not submit transactions to Daisugi or establish multi-peer
interoperability. A cold admission timeout remains possible under the unchanged
250 ms deadline; the regression records one identical-byte retry on a later head.
