# Native aggregation development

The experimental wallet retains NiceTry's interface and original SPHINCS-G
signer. Native mode submits a keyed-nonce transaction and its signature witness
through `eth_sendProofWrapper`. The witness is outside the transaction body.
Dependency declarations bind the signing intent to the block proof; account code
checks authorization before execution. There is no alternate send path when
aggregation is unavailable.

## Activation and configuration

The coordinated Daisugi client fork is active at epoch 31290. The new factory
and account implementation have been deployed and verified. Wallet builds require
explicit chain, genesis, contract addresses, code hashes and account-domain pins
through `NICETRY_AGGREGATION_PROFILE`. The source default stays inactive.

On the development portal, `NATIVE_AGGREGATION_RPC_ENABLED=true` enables
`eth_sendProofWrapper` and `eth_getProofWrapper` on `/rpc`; the default is false.
This flag is separate from `NATIVE_FRAME_RPC_ENABLED`. Set `PUBLIC_RPC_URL` and
`PUBLIC_BUNDLER_URL` to the reviewed HTTPS origin. On the development explorer,
set `NATIVE_AGGREGATION_FACTORY` to the verified factory to index its deployments
alongside existing accounts. Debug methods remain private.

The gateway accepts one bounded chain-1337 transaction with nonce key zero,
three or four frames and one direct witness. It validates structure; the execution
client performs signature verification, account authorization and admission.

Read-only capability check:

```sh
node scripts/check-aggregation-endpoint.mjs https://your-dev-host.example/rpc
```

RPC availability alone does not prove inclusion or proof validity. An extension
installed locally still sends transactions to the shared Daisugi testnet.

## Explorer

Transaction and block pages show the complete proof, encoded size, SHA-256,
dependency commitment and associated transaction hashes. Transaction pages also
show the number of their claims included in the block commitment. Latest native
transactions identify aggregate dependency declarations.

The explorer uses its private `debug_getRawBlock` connection to check the header
hash, transaction membership and commitment to sorted, deduplicated declarations.
An empty-set envelope is explicitly distinguished from an aggregated signature
proof. Missing, pending and unavailable data remain separate states.

The explorer does not run the leanVM verifier. Structural consistency is not an
independent cryptographic verification result. Block acceptance depends on the
execution client's verifier. Encoded length does not express security strength.

## Protocol and review boundaries

The prototype pins Nethermind `4a17b571f453d112bae5175a2e4966900201deae`, leanVM
`854997bd156f47f1b1ce2192c4499741f29bd0df` and a coordinated Lighthouse overlay
based on `e423a66763bb1bd780492d635123f208d80c3538`. The account domain is
`Daisugi.AggregatedFrameAccount.v2`; this is not a change to the signing algorithm.

This commitment format differs from the evolving format in
[EIPs PR #12417](https://github.com/ethereum/EIPs/pull/12417). Later alignment
requires coordinated protocol review and historical compatibility, potentially
with different wallet/account pins. No cross-client interoperability is claimed.

Keep production and staging separate. Live tests must record the transaction,
receipt, frame results, inclusion block, complete proof and finality. Browser
tests with intercepted submissions are not on-chain evidence. Commit, push and
production deployment require separate authorization.

## Current deployment pins

| Field | Value |
| --- | --- |
| Chain ID | `1337` |
| Genesis hash | `0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55` |
| Factory | `0x4940E0D0883fa40985fEC192FdD9E11C7A34d9D0` |
| Implementation | `0x016d1A8326E714552F6517177DB55eD45a5CB6E8` |
| Factory code hash | `0x38c01ffd077a60948f3759edb91798b8faf721d1d4e4385f55df41f2ca69e537` |
| Implementation code hash | `0xd489c81ebe91f1a94a9b6caf284532fd6aaf14b95f59a1925f28cd2146ef994b` |
| Account profile | `0x117b402ba03b9d4f1e98fca8f166909baf01f391a97e5cc255eaa2cdd2c28979` |

Verify these identities against the intended RPC before producing an active
wallet build. The public HTTPS origin is environment-specific and is supplied
at build time. Temporary tunnel URLs are not permanent network configuration.

The factory's imported `AggregateAccountRuntime.sol` is generated from
`aggregation/frames/wallet/account-profile.mjs` as a compiler input by
`aggregation/frames/wallet/prepare-fixtures.mjs`; it is not a missing hand-written
contract. The reproduction instructions in that directory pin solc and settings.

## Live evidence, October 6, 2026

The shared chain finalized both cases below. Receipts, exact dependency sets,
full proof bytes and block identities were checked. Independent execution-client
native verification accepted the proofs and rejected a changed commitment.

| Case | Block | Transactions / claims | Proof bytes |
| --- | ---: | ---: | ---: |
| Four temporary accounts using the unchanged wallet signer | 1022243 | 4 / 4 | 282,396 |
| Two user-operated wallet instances | 1022591 | 2 / 2 | 263,980 |

The four-account harness submitted one combined witness wrapper to the private
RPC; it was not four simultaneous browser sessions. Its first transaction is
`0x0661d2c83ba4cff23b2709ff7823edd09fb327a0a1bf1fd7325a89fde1e7d1ae`.
The two-wallet block includes
`0x464c1568844764d789c2da824aa8435e0193ccee31082f1bbb8498ec5850e321`
and `0xd90b06ae84ea80e4f9e94246fd889504278dccbab3e3816277315319fefb5a14`.
All sixteen and seven frame results, respectively, succeeded. These observations
do not establish sustained throughput, proving-time guarantees or gas savings.

## Staging review

Build the extension in `aggregation/frames/extension` with the reviewed profile
and staging HTTPS RPC, bundler and explorer URLs. Load it into a separate folder
as an unpacked extension. Keep existing wallet storage intact. Select Aggregated
frames and fund the displayed address with test ETH from the staging faucet.
Each distribution must include its source commit and `BUILD-PROFILE.json`.

Staging uses the existing shared Daisugi chain. Promoting the portal source does
not upgrade clients or redeploy the factory. Enable `NATIVE_AGGREGATION_RPC_ENABLED`
only for the staging portal and `NATIVE_AGGREGATION_FACTORY` for its indexer.
Retain the existing native-frame flag, faucet configuration and service boundaries.
The deployment package includes both new aggregation modules automatically.

The submitted candidate leaves wallet error handling unchanged. Serialized
admission can report busy; uncertain responses may remain pending in the wallet.
Check the recorded transaction hash before sending again. Recovery under sustained
concurrency is deferred. ERC-4337 is covered by isolated regressions; no fresh
ERC-4337 live transaction is part of this staging release verification.

CI runs portal, RPC, wallet and isolated source-tool tests. Full native client
compilation, cryptographic proof generation and consensus integration are separate
retained checks and are not repeated by the Node-based portal pipeline.
