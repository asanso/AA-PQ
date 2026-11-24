# HTTPS review wallet

Version 3.0.0.0 · leanSPHINCS is an experimental build for a Daisugi
network with native frame transactions. It keeps the NiceTry interface and signs
with leanSPHINCS; it has no other transaction mode.

Extract the supplied runtime ZIP into a new folder. In the browser extension
manager, enable Developer mode and load that folder as an unpacked extension.
Keep your existing wallet installed. This build uses an isolated vault entry and a
leanSPHINCS account with a different address; funds do not migrate.

Create or restore a wallet, fund the address it shows with test ETH from the
development faucet, and send a small test transfer. The account is created by its
first transaction. Open the history link to check the frame results in the
development explorer.

The RPC, explorer and contract pins of a distribution are recorded in its
BUILD-PROFILE.json. Use the faucet and explorer on that same review origin. If its
temporary tunnel is recreated with a different hostname, build and distribute a new
profile. There is no loopback endpoint fallback.

An uncertain submission can remain pending; check its recorded hash before creating
another send. This is an experimental testnet review distribution; its code has not
been audited.
