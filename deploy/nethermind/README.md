# Nethermind frame devnet migration

This directory builds the EIP-8141 prototype client used for the AA-PQ migration
rehearsal. It does not reset Kurtosis, deploy a new chain, or activate a fork.

## Build

```sh
bash deploy/nethermind/build.sh
```

Requires Git and Docker. Builds for the Docker host architecture from Nethermind
commit `c9ad4b5dc3b6db053c3a770ead8130594eb51152` on
`eip8141-frame-txs-devnet7`, with `tohex-prefix.patch` and `verify-500k.patch` applied. Source is retained
in a newly created temporary directory. Record the resulting image ID and
architecture for every deployment; a mutable image tag is not a deployment pin.

The patch fixes JavaScript tracer `toHex` to return `0x`-prefixed bytes, as Geth
does. Without it, Alto misclassifies an account's allowed EntryPoint prefund as
an illegal value transfer. It includes regression cases and updates affected
trace expectations. No bundler security rule is disabled. `getError()` is not
changed: Geth also returns JavaScript `undefined` for successful frames.

Run the client regression suite in the retained checkout with .NET 10:

```sh
dotnet test --project src/Nethermind/Nethermind.Evm.Test/Nethermind.Evm.Test.csproj \
  -c release -- --filter FullyQualifiedName~GethLikeJavaScriptTracerTests
```

## Preserve the existing chain

The migration target is the existing Daisugi network, not a newly generated genesis.
Keep the Geth volume, original genesis, Engine JWT, beacon database, validator
keys and slashing protection. Never start a second validator with the same keys.
Never mount Geth's database as Nethermind's database.

1. Verify the live chain ID (1337), genesis hash, finalized block, balances,
   contract code/storage and nonces. Store snapshots outside Git. Back up config
   and validator/slashing data using an application-consistent procedure.
2. Build/test the server architecture. Start Nethermind in a separate volume,
   on private ports, using the original execution genesis and JWT. Leave frame
   activation unscheduled during catch-up. Connect it to the existing Geth peer.
3. Feed the shadow node the canonical head through its authenticated Engine API
   so it can sync. It must not propose blocks or replace the live beacon yet.
   Compare finalized block hashes and state roots and retain historical receipts.
4. Verify the exact deployed Alto image/validator override with the candidate.
   Complete local AA creation, transfers, wrong-signature and used-nonce
   rejection before changing any production endpoint.
5. Briefly stop the existing validator for the final consistent handoff. Catch
   the candidate up to the exact last Geth head; verify state. Preserve both
   execution databases. Switch the existing beacon's execution endpoint and
   dependent RPCs, then restart that same validator. Ports 3000/3001 and their
   applications stay unchanged. A few missed slots are possible.
6. Require resumed head growth, finality, working bundler operations, and matching
   preserved state before scheduling frame activation. Stop and roll back the
   pre-fork handoff if any acceptance gate fails.

## Frame activation and verification

This pinned branch uses `config.eip8141PrototypeTime` in the execution genesis.
Activation is by **timestamp**, not block number. Do not use ethrex's `hegotaTime`
or the ethrex-only planner for this client. Leave all existing fork times and
genesis allocations unchanged. Choose a future timestamp on the existing
two-second slot grid, with enough lead time to install and verify the config.

Rehearsal showed the existing Lighthouse Engine V4 path continuing across this
prototype-only activation. This is not evidence of compatibility with arbitrary
later Nethermind/EIP revisions or a general Amsterdam upgrade.

Fund a disposable signer with test ETH and run:

```sh
CONFIRM_TESTNET=1337 FRAME_RPC_URL=http://127.0.0.1:28545 \
  FRAME_TEST_PRIVATE_KEY="$DISPOSABLE_SIGNER_KEY" node tests/verify-frame.mjs
WALLET_URL=http://127.0.0.1:3300 node tests/verify-aa.mjs
```

The frame test submits a type-0x06 transaction with VERIFY and SENDER frames,
checks both frame receipts and the exact 123-wei transfer, rejects duplicate and
altered-signature submissions, and waits for canonical finality. It is pinned to
the devnet7 encoding. It does not test PQ authorization. The AA test uses the
existing ERC-4337 bundler/EntryPoint path; these are different transaction formats.
The public portal's AA-only RPC allowlist is deliberately unchanged.

To generate and fund a disposable signer in memory instead of providing a key,
set `FRAME_FAUCET_URL` to the portal's `/api/faucet` endpoint. Set
`FRAME_EXPECT_UNSUPPORTED=1` for the pre-activation rejection check. Frame tests
use a private RPC or SSH tunnel; they do not widen the public RPC allowlist.

The shadow follower is `scripts/nethermind-shadow.mjs`. It uses the candidate's
authenticated Engine API without payload-building attributes, checks chain ID
and genesis, and imports intervening payloads once near the source head. It
fails closed if a block has nonempty execution requests; that case needs a
consensus-payload source rather than fabricated request data. Stop this follower
before handing control to the existing beacon.

`scripts/verify-migration-state.mjs` compares a common head and finalized hash,
EntryPoint and sampled account balances/nonces/code/storage, and old receipts.
Set `CHECK_ADDRESSES` to include the actual deployed factory. The checks sample
state and receipt availability; they are not an exhaustive database comparison.

`scripts/schedule-nethermind-frames.mjs` writes a **new** genesis config file only
after a post-migration block has finalized. It refuses existing output files,
rescheduling, a missing or mismatched original configuration SHA-256, stale heads, and timestamps less than five minutes away. It adds
only `eip8141PrototypeTime`; installing that file still requires an explicit
execution-node restart. `run-node.sh` is the Daisugi launcher retaining the
existing Engine alias, HTTP/WS/Engine host ports and private loopback bindings.
It limits the client to 2.5 CPUs and 12 GiB RAM on the four-core shared VM.

## Rollback limits

Before frame activation, return to a caught-up Geth node with the same canonical
head; never silently discard blocks produced during the handoff. Keep just one
validator running throughout. After activation, the old Geth binary is **not** a
safe rollback target: preserve history and repair forward with a compatible
client. Do not remove the activation timestamp to conceal post-fork blocks.

See [rehearsal results](../../docs/NETHERMIND-REHEARSAL.md) for the test evidence
and remaining deployment gates. This is experimental testnet software, not a
production-mainnet client recommendation.

## SPHINCS validation budget

The build includes the Daisugi testnet's 500,000-gas validation budget in both
the pool default and the fixed prefix-simulation cap. The launcher explicitly
sets the matching pool option. The budget includes witness-processing work;
changing only the pool option is insufficient. The patch includes valid and
corrupted SPHINCS witness cases and admission-boundary cases. Run the
`FrameTxValidationPrefixSimulationTests` and `FrameTxVerifyGasFilterTest` suites
in the pinned client checkout in addition to the tracer suite.

This source records the already activated testnet adjustment. Merging or deploying
the portal does not rebuild, migrate or restart the execution node. Migration
reports above describe the earlier migration; use [native frame integration](../../docs/NATIVE-FRAMES.md)
for current wallet and gateway requirements.

The scheduler's last positional argument is `ORIGINAL_CONFIG_SHA256`. Capture
this byte-level SHA-256 in the trusted migration record before editing or
copying the original genesis configuration. Supply that recorded fingerprint,
not a checksum newly calculated from an untrusted candidate. This binds all
allocations, headers and fork settings, in addition to checking the live genesis.
