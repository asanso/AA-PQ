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
