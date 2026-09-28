# HTTPS wallet build

Distributable builds require both `NICETRY_RPC_URL` and `NICETRY_EXPLORER_URL`.
Use the exact verified HTTPS staging URLs and a separate output directory:

```sh
NICETRY_RPC_URL=https://YOUR_STAGING_HOST/rpc \
NICETRY_EXPLORER_URL=https://YOUR_STAGING_HOST/explorer \
  npm run build -- --outDir nicetry-daisugi-https
```

The build fails if either endpoint is missing, uses HTTP or includes credentials.
There is no loopback RPC default or fallback. The extension can still connect to
local dApps through its content scripts; those permissions are not RPC endpoints.
An explicit custom RPC saved in an existing vault overrides the build default;
clear it in Network settings to use the staged endpoint.

Before distribution, verify `/api/config` reports `nativeFrameSubmissionEnabled`,
then verify chain ID, genesis and pinned factory, implementation and verifier code
hashes. The wallet checks those pins before preparing a transaction. The build
changes transport and explorer links, not the cryptographic profile or accounts.

Staging and production use the same Daisugi testnet. A transaction sent through
staging changes that shared chain. No separate blockchain is created by this
profile. The temporary review hostname may change if its tunnel is restarted;
a changed hostname requires an explicit replacement build or custom RPC setting.

Retain existing extension directories and recovery information. This build does
not migrate another extension's encrypted vault or legacy ERC-4337 balances.
