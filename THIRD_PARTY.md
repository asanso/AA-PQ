# Third-party sources

- Wallet and explorer visual inspiration: Giulio2002/pq-eth-demo,
  commit `4cc3009f63ae831dec0a26691e67f4c15fa0b9a2`.
  The interfaces here are independently implemented HTML/CSS/JavaScript, not
  a copy of that application's PQ backend or contracts.
- `SafeValidator.js` and `bundler-source/SafeValidator.ts` derive from
  https://github.com/pimlicolabs/alto/tree/v1.2.7, licensed under GNU GPL v3;
  the complete license is in `licenses/Alto-GPL-3.0.txt`. Modified 2026-09-10
  to decode the normal `simulateValidation` return, while retaining the
  trace, signature, storage, and opcode checks. The TypeScript file is the
  preferred editable source. To rebuild within Alto v1.2.7, replace
  `src/rpc/validation/SafeValidator.ts` with this file and follow Alto's
  own install/build instructions. The shipped JavaScript is the equivalent
  runtime override for the pinned Docker image, not an independent library.
- Canonical deployment salt and deterministic proxy transaction originate
  from eth-infinitism/account-abstraction (ISC) and hardhat-deploy (MIT).
  Contract source is fetched separately at the pinned revision in README.
- ethers is installed from npm, with its own MIT license in the package.
- `deploy/nethermind/tohex-prefix.patch` modifies Nethermind's JavaScript
  tracer and associated tests at commit
  `c9ad4b5dc3b6db053c3a770ead8130594eb51152` (Demerzel Solutions Limited,
  LGPL-3.0-only). The build script fetches upstream source separately, retaining
  its copyright notices and [license](https://github.com/NethermindEth/nethermind/blob/c9ad4b5dc3b6db053c3a770ead8130594eb51152/LICENSE).

No browser owner keys, credentials, chain databases, or installed dependencies
are included in this repository. The explicit devnet funding/executor keys
are intentionally public test keys, not secrets.
