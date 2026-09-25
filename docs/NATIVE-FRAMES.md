# Native frame integration

This candidate combines the pinned Nethermind frame migration, immutable
SPHINCS-G account and factory, original NiceTry interface, restricted HTTPS RPC
gateway and frame-aware explorer. It targets the experimental type-`0x06`
encoding in Nethermind `c9ad4b5dc3b6db053c3a770ead8130594eb51152` with the
Daisugi 500,000-gas validation adjustment. It is not an Ethereum mainnet release.

## Components

- `deploy/nethermind`: reproducible client patches and operator-controlled
  migration tools. Portal deployment does not run these tools or restart the node.
- `frame-account`: fixed-key account and deterministic factory. The account
  verifies the wallet's exact custom SPHINCS-G signature before authorizing
  execution and payment. Existing verifier and factory addresses are pinned.
- `native-wallet-original`: original NiceTry interface with native nonce,
  signing, simulation, submission and receipt handling. Build-time HTTPS endpoints
  are required; no localhost RPC fallback is bundled.
- `frontend/rpc-policy.mjs`: bounded JSON-RPC gateway. Native raw submission
  requires `NATIVE_FRAME_RPC_ENABLED=true`. It validates chain identity and
  accepts only the native frame envelope for raw submission. Administration,
  signing, debug calls and simulation state overrides remain unavailable publicly.
- `explorer`: complete frame and witness details, per-frame results, account
  profile provenance and a separate indexed native-frame transaction count.
  Native transactions do not increment the ERC-4337 UserOperation count.

Standalone FORS activation and owner rotation are absent from the new account.
The 40-byte current/next-owner suffix is not used. FORS internal to SPHINCS-G is
unchanged. A 6,176-byte signature length describes serialization size, not
cryptographic security strength. LeanVM aggregation is outside this candidate.

## Staging configuration

Configure only the staging portal with `NATIVE_FRAME_RPC_ENABLED=true` and set
`PUBLIC_RPC_URL` to its verified HTTPS `/rpc` endpoint. Set `PUBLIC_BUNDLER_URL`
to the same staging origin's `/bundler`; native frames do not use that bundler.
Keep private node and bundler upstream URLs on server loopback. Those internal
connections are distinct from wallet-facing endpoints and require no user tunnel.

The staging indexer needs a writable private `FRAME_INDEX_CACHE` path. Retain the
default activation block and genesis pins. An initial history scan may take time;
coverage and readiness are reported separately from the count.

Staging uses the existing chain 1337, factory and verifier. It isolates the
application release, not blockchain state. Manual wallet tests submit real
testnet transactions. Preserve the original application, production configuration,
node, bundler, consensus services and tunnel during a staging application update.

## Build and review

Run the portal checks, isolated account tests and wallet tests before promotion.
The pipeline builds a wallet against reserved `.invalid` example hosts only to
check compilation. That CI output is not a distributable wallet.

For the manual wallet build, follow `native-wallet-original/HTTPS-PREVIEW.md` with
the verified staging RPC and explorer URLs. Record the Git commit, endpoints,
signing-worker hash and archive SHA-256 with the delivered artifact. Preserve the
original UI assets and cryptographic source hashes recorded in `PROVENANCE.json`.

Before a manual send, verify the public release identity, chain ID, genesis,
contract bytecode pins, nonce retrieval, fee estimation and signed simulation.
Do not fund or broadcast test transactions as part of automated release checks.
For the manual acceptance test, inspect the transaction hash, native type,
enclosing receipt and every frame result. A successful outer receipt alone is
insufficient. Include the timestamp, complete calldata and SPHINCS witness in
the explorer review.

Main promotion, production activation and a wallet supporting both transaction
modes remain separate work. The existing Alto trace-timeout adjustment is a
container-local operational change; this candidate neither recreates Alto nor
claims to persist that adjustment in a replacement bundler image.
