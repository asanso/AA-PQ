# HTTPS review wallet

Version 2.1.3.7 is an experimental aggregation build for Daisugi chain 1337.
It retains the NiceTry interface and original SPHINCS-G signer. Native mode uses
aggregated frames; ERC-4337 remains a separate setup choice.

Extract the supplied runtime ZIP into a new folder. In the browser extension
manager, enable Developer mode and load that folder as an unpacked extension.
Keep your existing wallet installed. This variant uses an isolated vault and
an aggregation account with a different address; funds do not migrate.

During setup, select Aggregated frames to test aggregation. Fund the address
shown by this build with test ETH from the development faucet. Send a small test
transfer, then open its history link to the development explorer. The transaction
page shows frame results, the complete block proof, dependency commitment and
associated transactions. A one-transaction proof is possible when no other
aggregate transaction is selected for the same block; do not infer batch size
from signature length or wallet branding.

The RPC, bundler, explorer and contract pins are recorded in BUILD-PROFILE.json.
Use the faucet and explorer on that same review origin. If its temporary tunnel
is recreated with a different hostname, build and distribute a new profile.
There is no loopback endpoint fallback.

Live development tests confirmed one proof covering two user-operated wallets
and a separate four-account harness. Record each new test transaction hash and
check its frame results, block-proof coverage and finality. An uncertain submission
can remain pending; check its recorded hash before creating another send. Busy
recovery and sustained concurrent traffic have not been qualified in this release.
This is an experimental testnet review distribution.
