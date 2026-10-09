# NiceTry Daisugi — aggregation preview

Version 2.1.3.7 retains the original NiceTry interface and SPHINCS-G signer.
Native mode uses aggregated frames; ERC-4337 remains a separate setup choice.
The default deployment profile is inactive. Reviewed distributions supply explicit
chain, contract and HTTPS endpoint pins at build time.

See [AGGREGATION.md](AGGREGATION.md) for build commands and account isolation,
[HTTPS-PREVIEW.md](HTTPS-PREVIEW.md) for installation, and the
[integration record](../../../../docs/native-aggregation-development.md) for
verified live cases and remaining limitations. Runtime distributions include
BUILD-PROFILE.json with their exact source commit and target environment.

The strict-RPC positional-parameter and extension-local theme-script fixes are
retained. This release does not change error recovery, signing or the wallet UI.
