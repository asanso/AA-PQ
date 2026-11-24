# SPHINCS frame account prototype

An isolated account and factory for Daisugi's native frame transaction prototype.
The account verifies the exact custom `sphincs-g` profile used by
`NiceTry-Daisugi-2.1.3-https.zip`. It does not use the withdrawn v2 verifier.

The development factory was deployed on September 25, 2026 for the separately
packaged native wallet. Its address is
`0xd07fcbdca6dea83b523faf95386cea236e32d989`; deployment transaction
`0x5433d25448efc15e51a7b274164d28053ceb3dc6a36a476257d19f693c3afbca`.
Verified addresses and bytecode hashes are recorded in `dev-network.json`.
Existing ERC-4337 factories, accounts and application services remain unchanged.

The first wallet build and local connection instructions are in
`../native-wallet-original/README.md`. The wallet build requires explicit HTTPS
RPC and explorer URLs. `dev-rpc.mjs` remains an optional host-side diagnostic gateway;
it is not the endpoint of the staging wallet.
This is an experimental development path, not a production wallet release.

## Account behavior

- The public key is fixed at construction: `pkSeed` and `pkRoot` are 16-byte
  components left-aligned in `bytes32`.
- There is no standalone FORS authorization, owner activation, owner rotation,
  initializer, upgrade function or recovery function.
- FORS inside the custom SPHINCS algorithm is unchanged. The signature remains
  6,176 bytes; this length is not a statement of cryptographic security strength.
- Native verification uses one ARBITRARY witness and the canonical transaction
  signing digest. The account approves both execution and payment after a real
  verifier result of `true`. A failed call, malformed result or `false` is rejected.
- Verification calldata is empty. Neither a current/next-owner pair nor the
  former 40-byte suffix is accepted in that frame.
- Normal empty-calldata transfers can fund the account. Ordinary calls cannot
  authorize outgoing transfers. Application calls and values belong in SENDER
  frames, following successful verification.
- Replay protection uses the execution client's native account nonce. No
  ERC-4337 EntryPoint or bundler is involved in this account path.

## Factory interface

```solidity
constructor(address verifier)
getAddress(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) returns (address)
createAccount(bytes32 pkSeed, bytes32 pkRoot, bytes32 salt) returns (address)
```

`CREATE2` binds the address to the factory, salt, public key and fixed implementation
through the creation-code hash. The implementation fixes the verifier. Anyone may
deploy an account for a public key. Repeating the same request returns the existing
account without changing it. There is no
separate initialization transaction that another caller could intercept. Each
account is a 45-byte EIP-1167 dispatcher with 64 public-key bytes appended to its
code. Those bytes cannot be updated. The factory has no implementation setter.

Creation is nonpayable. Fund the predicted address separately. A native frame
transaction may place a DEFAULT frame calling `createAccount` before its VERIFY
and SENDER frames. The sender must already hold enough test ETH to cover fees
and any value transfer. The wallet must obtain the current native nonce, including
after creation; it must not reuse its ERC-4337 nonce assumptions.

## Pinned dependencies

The verifier runtime must have this exact Keccak-256 hash:

`0x7ab53ba1ae0d906f2d144cb673fb481e04d58b22ec72a8a0ec37cc66079f3417`

This is the unchanged Daisugi verifier at
`0xf505AD2Cff58b84E145D637d99Fae0617B5685BE`. Both factory construction and account
implementation construction reject other verifier bytecode. The tests install those exact bytes
only in ephemeral test state; they do not replace the live verifier.

The native opcode adapter targets Nethermind
`c9ad4b5dc3b6db053c3a770ead8130594eb51152` with Daisugi's 500,000 validation budget.
It is not portable to standard EVM networks or a different draft opcode layout.
Solidity 0.8.28 does not emit those opcodes directly. The annotated generator in
`scripts/generate-runtime.mjs` produces `SphincsFrameRuntime.sol`; the account
implementation constructor returns that generated runtime with its fixed verifier.
Each clone reads its public key from its own code during verification.

The clone layout also keeps account creation within the separate validation-prefix
state-gas budget. The test fixtures allocate 45,000 execution gas and 450,000 state
gas to creation, 450,000 execution gas to verification, and 250,000 state gas for
an execution frame that may create a recipient account. These are tested fixture
budgets, not a replacement for wallet gas estimation. No client limit is changed.

The actual Daisugi chain charges creation differently from the isolated full
prototype spec. Read-only tests of the deployed factory required a larger
creation execution budget. The wallet therefore uses 80,000 creation execution
gas and 415,000 verification execution gas for the first transaction, keeping
total prefix work at 495,100 including the ARBITRARY witness. The 450,000 creation
state budget is unchanged. Existing accounts keep 450,000 verification gas.
Both the isolated native tests and a real browser-signed `eth_call` passed with
these wallet budgets. No client configuration was changed for this adjustment.

## Verification

On Linux with Node.js 22:

```sh
npm ci --ignore-scripts
npm test
```

The command starts its own loopback Anvil process, checks the factory and ordinary
account behavior, and stops the process. It has no configurable live RPC target.
Anvil does not implement native frames; passing these tests alone does not verify
SPHINCS authorization through the native client.

The additional `tests/native-tests.cs.txt` cases extend the pinned Nethermind
`FrameTxValidationPrefixSimulationTests` fixture in a disposable test container.
They use the real factory runtime, account runtime and verifier, plus public
test-only signatures from the exact wallet module. The fixture contains no
production credentials. Never fund fixture accounts on a shared chain.

On the development host, the existing SDK image for the pinned client can run
these checks without chain-data mounts:

```sh
sudo -n python3 scripts/test-native.py
```

This runner requires the exact local image ID embedded in the script; it does not
download an unverified replacement. A separate build step restores test
dependencies and compiles the augmented fixture. Test execution then runs in a
container with networking disabled; that container is removed afterwards. The
build modifies only its own image layers. Ordinary factory tests also
check that the native fixture uses the current compiled account and factory code.

Compile settings are Solidity 0.8.28, via IR, optimizer 200, Cancun. Keep those
settings stable when comparing deterministic addresses.

## Integration

The original NiceTry interface is integrated in `../native-wallet-original`.
It uses this factory and retains the exact SPHINCS-G profile. See
`../docs/NATIVE-FRAMES.md` for public gateway configuration and staged testing.
Existing ERC-4337 accounts and balances are not migrated. Publishing this source
does not deploy contracts, change client limits or submit transactions.

## leanSPHINCS verifier (devnet-1, experimental)

`contracts/LeanSphincsVerifier.sol` verifies leanSPHINCS signatures as specified by
leanEthereum/leanVM `crates/lean_sphincs` at
`f7ba4999ae523b94c8d0969b32762c3effea4cbd`. Nethermind's lean-bindings pin the same
revision for EIP-8288 scheme `0x10` on Daisugi devnet-1, and EthLib specifies the
same scheme in Lean. It is intended for native frame accounts that verify their own
signature in a VERIFY frame.

The verifier comes in two forms:

- `contracts/LeanSphincsVerifierReference.sol`, the readable version: a direct
  mapping of the specification, with loops. It documents the computation and serves
  as a test oracle; it is not deployed.
- `contracts/LeanSphincsVerifier.sol`, generated by `scripts/generate-verifier.mjs`
  (`npm run check` fails if it is stale): the same computation in fixed memory, with
  the 64 WOTS+C chains of a layer and every Merkle level unrolled. A FORS tree folds
  its index into its leaf, `t = 1024c + s`, so its node at height `z` is `t >> z`,
  and the left or right position of a node is one shift and one mask; both follow
  SphincsVerifier_v5. The loop walks three FORS trees per iteration: that measured
  less gas than one, six, eight or all 24 trees per iteration, and unrolling all 24
  exceeds the 24,576-byte code size limit (EIP-170). Runtime: 14,000 bytes.

On Daisugi devnet-0 (chain 701563864) the generated verifier and its factory were
deployed on November 24, 2026, in blocks 42962 and 42963:

| Contract | Address |
| --- | --- |
| `LeanSphincsVerifier` | `0x6965C62Ad830067492f1b5528AAeF376a4AC4f76` |
| `LeanSphincsFrameAccountFactory` | `0x605C0B9e96313679805deF28e5CBDf11Bc6d7579` |
| Account implementation | `0x80983a0815Bd01709E14515bD02C58DB48Af184D` |

On that chain's execution client the verifier used 76,505 execution gas for EthLib's
`verify_valid_known_answer` vector (opcode trace of an `eth_call`). The VERIFY frames
of two wallet transactions through an account of this factory used 84,156 and 84,377
gas (blocks 42999 and 43004). An earlier factory,
pinned to an earlier build of the readable verifier (runtime hash
`0x266de5694a20b5d57385fced6614f5afd1e6fc0613e1c29c057bd2933bd4519a`), stays deployed;
accounts it created keep working with that verifier. The same public key has a
different account address under each factory.

`LeanSphincsFrameAccountFactory` and `LeanSphincsFrameAccount` follow the SPHINCS-G
account above, with these differences:

- each clone carries the 32-byte public key `PK.seed || PK.root`, so its code is
  77 bytes; `createAccount(bytes32 publicKey, bytes32 salt)` and
  `getAddress(bytes32 publicKey, bytes32 salt)` take that key;
- the account runtime, `LeanSphincsFrameRuntime.sol`, comes from the same generator
  and checks the same frame conditions, but requires a 7,740-byte witness and calls
  `verify(bytes32,bytes32,bytes)` (selector `0xde12c640`);
- the account and the factory pin the verifier runtime hash
  `0xcb1899cf8beccc7a966a04de3bdff0f24a4b32d6368fcfbb8c4d139b10b17aa9`, which
  covers the compiled source with its metadata. Any change to the verifier source
  changes it, and the factory test then reports the mismatch.

Anvil does not implement native frames. The factory tests cover deployment, the
pinned runtimes, address derivation and plain calls; verification through a native
VERIFY frame still has to be tested on the client.

`scripts/deploy-lean-sphincs.mjs` deploys the verifier and then the factory, at the
addresses the deployer's next two nonces give, and checks the verifier runtime hash,
the factory's pins and the implementation runtime. It writes the wallet's native
frame profile and prints the matching portal profile fields
(`nativeAccountScheme: "lean-sphincs"` and the `native*` contracts). On a host
without the compiler, deploy from an artifacts file written with
`--write-artifacts`, resolving ethers through `--ethers <package.json>`. `--dry-run`
estimates without sending. The key file is read, never printed, and an existing
output file is never overwritten.

- Parameters: Keccak-256 truncated to 16 bytes; a three-layer hypertree of heights
  8, 8 and 10 (bottom first) of WOTS+C keys (w = 2, 64 chains, target sum 128);
  FORS with 24 trees of height 10. Upstream states a limit of 2^30 signatures per
  key for 127-bit SUF security in the random-oracle model.
- Interface: `verify(bytes32 publicKey, bytes32 message, bytes signature)` returns
  `true` or `false`. `publicKey` is `PK.seed || PK.root`. A signature that is not
  exactly 7,740 bytes reverts with `InvalidSignatureLength`.
- Scope: verification only. Key generation and signing remain the upstream crate's.

`tests/fixtures/leansphincs-ethlib` vendors EthLib's `tests/cryptography/sphincs`
vectors (CC0-1.0) at commit `a2a9e655f965dbadf33b3acfbc645696078fc75d`, as leanVM
vendors them at the pinned revision; `SHA256SUMS` is EthLib's own.
`tests/leansphincs-reference.mjs` is a line-by-line JavaScript port of the upstream
`verify`, used only as a test oracle. The tests check:

- the vendored vectors against `SHA256SUMS`;
- every EthLib `verify` vector, on the JavaScript reference and on both contracts;
- the EthLib `sign` outputs under the `key_gen` public keys;
- single-bit changes across every signature field, the public key and the message,
  on both contracts;
- execution gas of the valid vectors and the size of the generated runtime;
- the account and factory, as listed above.

To run the contract tests off Linux, set `ANVIL` to an Anvil 1.7.1 binary.

Measured on Anvil 1.7.1 (Cancun, Solidity 0.8.28 via IR, optimizer 200), excluding
the 21,000 base cost and the calldata of an external call: about 77,000 execution
gas per valid verification for the generated verifier, about 174,000 for the
readable version.

This code has not been audited and has not been reviewed by a third party. Do not
use it with real funds.
