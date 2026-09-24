# EF Nethermind migration — 24 September 2026

## Migration

Migrated the single execution node on `cryptography-daisugi` alongside the
existing Geth node. Lighthouse beacon/validator, Alto, portal and explorer were
retained. No new Kurtosis network or genesis was created.

- Chain: 1337.
- Genesis: `0x3f08ccf3cbc9a60e7a328a3260f2fccf1ee2e8e36e647f030f77b8122cd83e55`.
- Nethermind source: `c9ad4b5dc3b6db053c3a770ead8130594eb51152` plus the
  repository's `tohex-prefix.patch`.
- Tested amd64 server image ID:
  `sha256:7a0912e609db8c05d560ea7c4f3f4a2d620dfbf0135cadc8d0d5bb6f3b9f384a`.
- Handoff block: **519010**,
  `0x2c43a62f2cca814ee824408dcce5de747211e6eb3c57057ea3f52cf0d5693128`.
- Handoff state root:
  `0x28aedbd4f0d432cc8755ffcd702718946e4853eb1cc51dc8ee1624727502f3ca`.
- Post-handoff finality verified at **519051**,
  `0x7740180cc2cbb471917dec5057e7ce0f1833831b6f7acaca51a9cc3fe4c556f4`.

Nethermind snap-synced from Geth into a separate volume, downloaded historical
headers/bodies/receipts, then followed every intervening payload. The candidate
matched the exact stopped Geth head with Engine status VALID. State comparisons
covered EntryPoint, the actual factory and recent AA accounts, including
balances, nonces, code and slots 0/1. Three historical receipts, drawn from 90
UserOperation events, matched. This is sampled state/receipt coverage, not an
exhaustive database comparison.

The validator was briefly paused for the final consistent handoff and slashing
database backup, then the same container resumed. The live execution IP/alias
and private RPC port 32773 stayed the same. Portal 3000 and explorer 3001 were
not restarted or replaced; Alto remained running.

## Live AA acceptance

`tests/verify-aa.mjs` passed through the existing public portal after migration:

- Account: `0xbd5ff16760258eCcA26b2c83B4C0d9B6501beE42`.
- Creation transaction:
  `0x5895db0fc879998f516bee326cd9f8f1110f21ab60cfacbc4e1e0ac4b2c1a247`.
- Transfer transaction:
  `0x868bdafbbe94bf25d2697c8afe1de90f90bdf90283a82968c717bc3440708e6e`.
- Correct EntryPoint `handleOps`, successful UserOperation events, exact recipient
  balance increase, wrong-signature rejection and used-nonce rejection.
- Ordinary raw-transaction submission remains blocked by the portal proxy.

These are disposable testnet accounts, not a test of every external PQ wallet.

## Frame schedule

After migration and post-handoff finality, installed a config adding only
`eip8141PrototypeTime = 1790274781`: **18:33:01 UTC / 20:33:01 Zurich**.
Pre-activation signed frame submission was rejected both before and after
installing the scheduled config. Post-activation verification is recorded below
when completed.

## Preserved data and operational boundaries

Deployment files: `/opt/aa-pq/migration-nethermind-20260924`.
Live container: `aa-pq-nethermind`.
Live database volume: `aa-pq-nethermind-data-20260924`.
Config: `genesis-frames.json` in the deployment directory.

The original Geth container and database are stopped and preserved. An additional
Geth archive and consistent validator-key/slashing archive are in the root-only
`backup` directory. They must never be committed. The retained stopped
Nethermind containers share the live database volume: they are **not** separate
database backups and must not be started concurrently. Automatic restart was
disabled on the superseded execution containers.

The old Geth data stops at the handoff block. Even before activation, rollback
would require catching up, not discarding newer blocks. After activation, the
old binary cannot safely follow the new rules. Keep the chain history and repair
forward with a compatible client.

The public portal, RPC allowlist and external-wallet interface are unchanged.
Native frame submission is verified through a private RPC/Teleport tunnel;
enabling the execution fork does not convert ERC-4337 UserOperations into frames
or add frame support to NiceTry or the explorer UI.
