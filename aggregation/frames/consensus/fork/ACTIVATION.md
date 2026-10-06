# Same-chain activation review

This is a review procedure, not an approved deployment. Source development does
not authorize a shared-service restart, fork activation, contract deployment or
live transaction. Do not reset genesis or replace the chain with a fresh network.

## Required candidate evidence

1. Record the exact client revisions, overlay hashes, compiled binary hashes,
   native ABI and guest verification key. Run positive and negative native proof
   checks and the complete Engine/beacon-block integration test.
2. Verify the current genesis, historical fork schedule, finalized beacon state,
   latest execution head and service/container identities. Confirm the execution
   genesis hash and all pre-activation fork rules remain unchanged.
3. Rehearse the existing database transition on consistent private snapshots
   before activation. Public-state decoding and synthetic database recovery are
   useful checks but do not establish full live-database migration compatibility.
4. Check disk capacity, backup consistency and restore procedures. Preserve the
   validator keys and slashing-protection database. Never run a second validator
   instance with the same keys; do not delete or replace slashing records.

## Coordinated configuration

Choose a future epoch and a unique nonzero four-byte consensus fork version only
for the reviewed activation. Compute the execution timestamp from the existing
beacon genesis time, two-second slots and 32 slots per epoch. The execution and
consensus schedules must identify the same boundary.

`prepare_activation.py` accepts a complete execution genesis JSON and a complete
beacon configuration expressed as JSON. It produces a new offline proposal and
records input hashes. It does not install or convert the proposal to deployment
YAML, contact the chain or choose an epoch/version automatically. Review those
generated files against both actual client configurations before use.

To propose preservation of current native-wallet submissions, explicitly supply
`--preserve-native-wallet`. This sets the Daisugi scalar-frame compatibility flag
and records the required operator admission limit of 500,000 gas. Check that limit
in the actual runtime configuration as well; the helper does not install it.
All validating execution clients must use the same consensus compatibility rule.
Omitting the flag retains upstream keyed-only behavior after EIP-8250. Do not
describe that stricter configuration as a transparent update for existing wallets.

Keep the existing EIP-8141 timestamp unchanged. Schedule only the reviewed
EIP-8288 prototype and its inherited requirements; do not enable unrelated
Amsterdam/BAL or Fulu/Gloas behavior. Set `MAX_PAYLOAD_SIZE` to 20 MiB on both the
beacon node and validator client. Their current network-configuration mounts are
distinct, so updating one mount does not update the other.

Upgrade the execution client, beacon node and validator client together. Preserve
the execution data volume, beacon data volume, validator keys, slashing database,
JWT secret, network identity and existing RPC/Engine routes. Load the matching
native library into Nethermind. Keep Engine authentication and exposure unchanged.

## Wallet and application activation

After the clients pass pre-activation health checks, deploy the reviewed
aggregation account/factory only under explicit transaction authorization. Record
chain ID, genesis hash, factory address, implementation address and both runtime
hashes. Verify those identities over the exact HTTPS endpoint used by the wallet.

Enable the bounded wrapper methods only in the separately reviewed application
gateway. Verify the public transport, request limits, unsupported-method behavior
and explorer's complete proof preservation. Build the original NiceTry UI against
the checked HTTPS profile; never ship a synthetic fixture profile or loopback URL
as the usable distribution. Preserve separate wallet vault namespaces and the
unchanged SPHINCS-G signing module. Retest ERC-4337 separately.

For the user's first authorized test, verify the submitted hash, native frame
encoding, account authorization, receipt/frame outcomes, dependency commitment
and the containing block's proof. Clearly distinguish a proof carried by a block
from cryptographic verification of that proof by an independent client.

## Failure handling

Before the activation boundary, compatible old binaries can only be restored with
the pre-activation schedule and a reviewed recovery procedure. After activation,
an old client cannot validate the new block format. A binary-only rollback is not
safe: stop, preserve evidence and obtain approval for the specific recovery plan.
Do not silently rewind the chain, reset data or reuse earlier release approvals.

Multi-peer propagation, external builders, Web3Signer, arbitrary historical state
replay and a complete live database migration are separate compatibility claims;
do not infer them from unit tests or a local Engine exchange.
