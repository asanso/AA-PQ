# Experimental aggregated-frame wallet transport

> Historical component record. Implementation boundaries and measurements below
> describe this component at the time of its tests. For the current integrated
> client, wallet and live-test status, see [Native aggregation](../../../docs/native-aggregation-development.md).

This package extends the isolated native-aggregation prototype with immutable
clone accounts, first-send account creation and proof-wrapper RPC admission.
It is development source, not an activated network feature or a wallet release.

The client pin remains Nethermind `4a17b571f453d112bae5175a2e4966900201deae`
with its Marchhill leanVM dependency `854997bd156f47f1b1ce2192c4499741f29bd0df`.
Do not exchange its NLR3 proofs or dependency commitments with another leanVM
branch. The original NiceTry 2.1.3 SPHINCS-G signing module is unchanged.

## Components

- `account-profile.mjs` defines the account intent and generates its EVM runtime.
- `contracts/SphincsAggregateAccountFactory.sol` creates an implementation and
  deterministic, immutable 77-byte clones carrying an authorized public-key hash.
- `protocol.mjs` derives account addresses, encodes keyed-nonce frame transactions
  and packages a public key and signature for `eth_sendProofWrapper`.
- `client.mjs` exposes the existing wallet client's preparation/submission
  interface with explicit network and code pins. It requires a supplied transport,
  receipt parser and durable journal. It is not wired into the released extension.
- `prepare-fixtures.mjs` compiles the factory and signs four intents using the
  original wallet module. It generates the imported runtime library as a Solidity
  compiler input; it does not deploy contracts or persist private keys.
- `NativeWalletChecks.cs.fragment` extends the pinned native client test suite.
  It uses the earlier authorization package's test-chain helpers.
- `test.mjs` checks serialization and wallet transport behavior with mocked RPC.
  Its synthetic signature is deliberately not a cryptographic test fixture.

## Verified scope

Two independently generated keys each submit two SPHINCS-signed calls. First
sends create their account through the factory; subsequent sends use its deployed
code. Calls carry calldata and test ETH to a contract that records the input.
The real RPC module, proof-wrapper service, transaction pool, prefix simulator,
block producer, account runtime and native leanVM verifier participate.

The sequence produces two blocks, each with two transactions and one real proof.
A separate process receives encoded blocks and public genesis state, without
signature witnesses, and reproduces state. Missing/corrupt proofs are rejected.
An altered recipient with an otherwise valid dependency proof fails execution.

The factory constructor is also executed and checked against the generated
implementation runtime in an independent test. The aggregation fixtures install
the compiled factory runtime and immutable implementation address in synthetic
genesis; this is not a deployment on Daisugi.

Successful final checks: 21 JavaScript transport checks, 11 native producer/RPC
checks and four independent receiver checks. These exercise a managed RPC module,
not an HTTP listener, browser extension, Engine API or P2P connection.

## Reproduction

From the development project, with its existing dependencies installed:

```sh
node aggregation/frames/wallet/test.mjs frontend/package.json
node --experimental-vm-modules aggregation/frames/wallet/prepare-fixtures.mjs \
  "$PWD" "$PWD/frame-account/package.json" "$SIGNER_MODULE" "$OUTPUT_DIRECTORY"
```

`SIGNER_MODULE` must be the exact original ZIP module, SHA-256
`117d793ce26f1a7fe152ce23884a03cd07663758b044d397f72eff5b901584ce`.
The output directory must not exist. The compiler must be solc 0.8.28; compilation
uses via-IR, optimizer 200 and Cancun. Generated compiler input and bytecode are
review artifacts, not configuration for the current network.

For managed tests, insert both the authorization and wallet fragments into the
pinned `NativeBlockProductionTests` class. Include the EVM state and transaction
processing namespaces. Set `DAISUGI_WALLET_DIR` to the fixture/artifact root and
enable `NATIVE_LEAN_TESTS` with the pinned native library on the library path.
Run `Daisugi_wallet_rpc` first, then `Daisugi_wallet_import` in a fresh process.
The latter needs only public genesis fields and the two encoded blocks.
The private verification runner records the exact container invocation.

## Integration boundaries

- The current wallet UI, vault, signing workers, ERC-4337 mode and distribution
  remain unchanged. This adapter is not an installable wallet build.
- A future build needs a separately reviewed vault namespace/account migration,
  explicit HTTPS transport, genesis identity and deployed factory/code pins.
  No temporary test address or localhost endpoint should become a release default.
- RPC capability probing is not attestation of a remote client's software.
- The prototype's first creation advances an initially zero account nonce to
  two: CREATE2 initializes it to one, then frame execution advances it. Always
  read the pending nonce; do not infer it from the number of wallet sends.
- Admission uses upstream limits. Cold test-process startup exceeded the 250 ms
  prefix timeout in early attempts. Final tests warm EVM paths before admission;
  cold-start availability and sustained load remain unverified. No timeout or
  gas limit on a shared service was changed.
- A 30-million-gas synthetic genesis supports the factory setup test under the
  fork's state-gas schedule. Production activation and capacity need separate
  validation. Test receipt figures do not establish live gas savings.
- The account rejects a populated, otherwise valid recent-root reference in the
  tested 100,000-gas VERIFY path. Full gas-boundary and adversarial account-policy
  review remain required before activation.
- No commit, push, deployment, service restart, funding or live submission is
  part of these checks.
