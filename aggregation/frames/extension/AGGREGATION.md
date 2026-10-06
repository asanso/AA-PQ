# Aggregation preview

This is a separate development variant of the unified NiceTry wallet. The
original interface, SPHINCS-G signing module and ERC-4337 implementation are
retained. Native mode uses the `Daisugi.AggregatedFrameAccount.v2` account policy,
keyed nonce zero and `eth_sendProofWrapper` transport.

The default deployment profile remains inactive. The required client fork and
aggregation factory are active on Daisugi. Explicitly configured development builds
have completed live sends from independent wallet instances. A usable build still
requires the reviewed deployment pins and the intended environment's HTTPS gateway.
See [the integration record](../../../../docs/native-aggregation-development.md)
for contract identities, verified transactions and limitations.

## Account isolation

The vault uses `nt_aggregate_vault_v1`, schema 10. Existing unified, native-frame
and ERC-4337 vaults are not imported automatically. An aggregated native account
has a different address from the earlier native account. Restoring the same seed
does not migrate funds or existing contracts.

## Building

Install the locked dependencies with `npm ci`. Supply explicit public HTTPS
endpoints and use a separate output directory:

```sh
NICETRY_RPC_URL=https://your-dev-host.example/rpc \
NICETRY_BUNDLER_URL=https://your-dev-host.example/bundler \
NICETRY_EXPLORER_URL=https://your-dev-host.example/explorer \
npm run build -- --outDir nicetry-aggregation-preview
```

This produces the inactive preview. An activated build additionally requires
`NICETRY_AGGREGATION_PROFILE=/absolute/path/to/reviewed-deployment.json` containing:
`active`, `chainId`, `genesisHash`, `factory`, `implementation`, `factoryCodeHash`,
`implementationCodeHash`, `profile` and `maxFeePerGas`. `profile` is the exact
account-domain hash, not a display name. Never substitute synthetic test addresses
or enable the profile before its contracts and client fork are verified.

The build validates pin completeness. Sending verifies the actual chain, genesis,
contract bytecode, implementation address, account bytecode and wrapper RPC method.
The signing intent binds the call, fees, nonce and account key. A durable pending
record is written before submission. An explicit validation-prefix timeout may
retry identical bytes once after a new block; ambiguous transport outcomes are
not automatically retried. There is no alternate send path if aggregation is
unavailable.

The underlying protocol remains the pinned experimental Nethermind/leanVM
commitment format. It is not interchangeable with the evolving EIP-8288 format
discussed in EIPs PR #12417. A later format change may require a coordinated
client transition and different account/wallet deployment pins.

Zero-argument viem requests include `params: []` for strict RPC gateways. Theme
initialization loads an extension-local script under the existing CSP. Neither
compatibility fix changes the signer, aggregate intent or submission protocol.

Run `npm test` for serialization, transport, encrypted-vault and existing wallet
regressions. Browser integration tests use an isolated profile, real SPHINCS-G
signatures and intercepted RPC. Their mocked receipts are not on-chain evidence.
