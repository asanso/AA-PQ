# NiceTry Daisugi native frames development wallet

Version **2.1.3.1**. This Chromium extension retains the NiceTry 2.1.3 interface
and replaces its ERC-4337 submission path with native frame transactions on the
Daisugi development network. It uses the original wallet's custom `sphincs-g`
signature profile and the existing compatible on-chain verifier.

This is a development build for test ETH. It is not the production wallet or an
audited release. Transaction type `0x06` follows the experimental EIP-8141
implementation running on this network; it does not imply Ethereum mainnet support.

## Install and connect

1. Extract `NiceTry-Daisugi-2.1.3.1-Native-Frames-Dev.zip` into a new directory.
2. In Chrome or Brave, open the extensions page, enable Developer mode and choose
   **Load unpacked**. Select the extracted directory containing `manifest.json`.
3. Disable the earlier minimal native-frame development extension. When testing
   dApps, enable only the NiceTry build you intend to use to avoid provider
   selection conflicts. Keep any original wallet installation and its recovery
   information available for access to its existing accounts.
4. Use the HTTPS staging build supplied for this review. It connects directly to
   the endpoint recorded in `BUILD-PROFILE.json`; no SSH tunnel is required.
   Keep the existing extension directory intact. A new unpacked directory may
   receive a different extension identity and will not inherit its stored vault.
5. Create a wallet or import a seed phrase through the original onboarding flow.
   Back up a newly generated phrase before continuing. This build uses a separate
   encrypted vault namespace and does not migrate an existing extension vault.
6. Copy the **new native account address** displayed by this build and fund it
   with test ETH through the staging portal faucet.
   The new factory produces a different address from the legacy account for the
   same seed. Importing a phrase does not move an old account's balance.
7. Use **Send**, review the recipient, amount and maximum network fee, then confirm.
   The first transaction creates the native account; subsequent transactions use
   its current native nonce. Inspect the returned transaction hash in the
   configured staging explorer.

The RPC must match chain ID 1337, the pinned genesis and the factory,
implementation and verifier code hashes. Sending fails closed if those checks do
not match. Custom RPC configuration is available in the original network settings;
an override replaces the default and does not enable a fallback network.

## Implemented behavior

- Original onboarding, encrypted vault, account switcher, asset list, token import,
  send review, dApp approval, activity view and theme controls.
- SPHINCS-G signing in a dedicated worker and verification before submission.
  The signature is 6,176 bytes; this length is not a security-strength claim.
- An arbitrary-signature witness in a native frame transaction, without an ECDSA
  transaction signature, bundler or EntryPoint submission.
- Immutable SPHINCS public keys in the new account. No standalone FORS signer,
  owner rotation, device enrollment or 40-byte current/next-owner calldata suffix.
  FORS remains an internal component of the unchanged SPHINCS algorithm.
- ETH transfers to EOAs and contracts, ERC-20 transfers and dApp contract calls.
  Recipient calldata is preserved byte for byte. The destination's own execution
  may still reject a call or transfer; the complete signed transaction is simulated
  before broadcast.
- Durable transaction-hash tracking before broadcast. Lost responses and pending
  receipts are not treated as confirmed success and are never retried automatically.
- Receipt validation includes individual frame results. Top-level receipt success
  alone does not confirm the requested transfer.

## Current limits

- Chrome/Brave unpacked extension, using the local development RPC tunnel.
- One destination call per wallet request. Direct contract creation with `to: null`
  and dApp-supplied EOA gas/fee overrides are not supported by this build.
- `personal_sign` and EIP-712 signing remain unsupported. No aggregation is added.
- Calldata is limited to 45,000 bytes by the development transport budget. The
  destination call budget is capped at 5,000,000 units for each execution/state
  allowance. The maximum network fee displayed is a conservative reserve, not the
  final charged fee. Network fees above the configured 3 gwei cap are rejected.
- A missing receipt remains unresolved. Resolve the hash on-chain before another
  send. An interrupted signing lock can take up to five minutes to expire.
- Activity scanning covers direct ETH transfers and frame results available from
  the RPC. It is not a complete internal-call tracer or token-transfer indexer.
- Legacy account ownership transfers and old balances are not migrated. Keep the
  original wallet for interacting with legacy accounts.

## Build from source

Use Node.js 22 and the included lockfile:

```sh
npm ci --ignore-scripts
npm run test:frames
NICETRY_RPC_URL=https://YOUR_STAGING_HOST/rpc \
NICETRY_EXPLORER_URL=https://YOUR_STAGING_HOST/explorer \
  npm run build -- --outDir nicetry-daisugi-https
```

Load `nicetry-daisugi-https/` as an unpacked extension. Source lineage and exact network
pins are recorded in `PROVENANCE.json` and `src/native-frame/network.json`.
Dependencies were not upgraded for this integration.

## Verification scope

Protocol and gateway tests cover encoding, signature binding, nonce handling,
calldata preservation and receipt interpretation. Isolated Chromium tests exercise
the original interface with real SPHINCS signatures and intercepted broadcasts.
They do not constitute new on-chain transactions or a security audit.

Previous live transactions are separate evidence for this account and verifier
path. A new staging build still requires its own manual wallet acceptance test. No signature-lifetime or signature-count study
was performed for this build.
