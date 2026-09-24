# AA-PQ / Daisugi

<!-- portal-version:start -->
![version 0.1](docs/assets/portal-version.svg)
<!-- portal-version:end -->

An Ethereum-compatible testnet portal with a read-only explorer, a test ETH
faucet and an Overview with network information. The portal does not connect to
browser wallets or create or store wallet keys. Account setup and signing happen
in a compatible external wallet such as NiceTry.

The explorer shows blocks, addresses, transactions and ERC-4337 UserOperations,
including complete signatures, transaction input and decoded calldata when a
supported ABI is available. Signature sizes describe encoded bytes and bits, not
cryptographic security strength.

The network recipe in this repository runs Geth and Lighthouse through Kurtosis,
with Alto handling UserOperations through EntryPoint v0.9. The original
contract-deployment recipe uses a pinned SimpleAccount baseline. Account and
verifier implementations on a research network can differ; a portal update does
not deploy or change those contracts.

The EF deployment has been migrated from Geth to a pinned Nethermind frame-tx
prototype without resetting chain history. Build, migration and fork instructions
are in [deploy/nethermind](deploy/nethermind/README.md); the original Kurtosis
recipe below still provisions Geth. ERC-4337 remains available through Alto.

| Service | Default port |
| --- | --- |
| Portal and faucet | 3000 |
| Explorer indexer and optional shared portal UI | 3001 |
| Alto bundler | 4337 |
| Geth RPC | Assigned by Kurtosis |

## Requirements

- Node.js 22 or later and Git
- An existing Daisugi-compatible network, RPC, EntryPoint and bundler
- A funded test account configured for the faucet
- For provisioning a new devnet: Linux, Docker and [Kurtosis](https://docs.kurtosis.com/install/) (tested with CLI 1.20.0)
- Available ports for the services being started

## Install and configure

```sh
git clone https://github.com/asanso/AA-PQ.git
cd AA-PQ
npm ci --prefix frontend
npm ci --prefix explorer
test -f .env || cp .env.example .env
```

For an existing network, configure its endpoints and addresses in `.env`. The
example file contains deliberately public development keys for a disposable
testnet. `FAUCET_PRIVATE_KEY` must be set; the frontend no longer supplies a
fallback key in its source.

| Setting | Purpose |
| --- | --- |
| `RPC_URL` | Backend RPC used for chain reads |
| `BUNDLER_URL` | Bundler upstream |
| `ENTRY_POINT` | EntryPoint deployed on this chain |
| `FAUCET_PRIVATE_KEY` | Funded server-side test account used by the faucet |
| `FAUCET_RPC_URL` | Optional separate RPC for faucet submission; defaults to `RPC_URL` |
| `EXPLORER_URL` | Native indexer API; defaults to `http://127.0.0.1:3001` |
| `FACTORY_ADDRESS` | Deployed factory used by the retained AA helper and original integration test |

The faucet RPC must support transaction submission, nonce and fee queries. The
restricted public read proxy is not a replacement for that connection. Public
endpoint metadata and the two-domain configuration are documented in
[docs/DUAL-DOMAIN.md](docs/DUAL-DOMAIN.md).

## Run against an existing network

Start the portal in one terminal:

```sh
set -a
. ./.env
set +a
HOST=127.0.0.1 PORT=3000 node frontend/server.mjs
```

If an explorer indexer is already running, set `EXPLORER_URL` to it. Otherwise,
start the indexer in a second terminal:

```sh
set -a
. ./.env
set +a
HOST=127.0.0.1 PORT=3001 PORTAL_ORIGIN=http://127.0.0.1:3000 node explorer/server.mjs
```

Open [the local portal](http://localhost:3000). Loopback binding supports local
access or an SSH port forward; an ingress on another machine needs a separately
configured connection to the service.

The legacy launcher names remain available: `scripts/run-wallet.sh` starts the
portal on port 3000 and also requires `FACTORY_ADDRESS`; `scripts/run-explorer.sh`
starts the indexer on port 3001. Both load `.env`. Set `PORTAL_ORIGIN` for the
explorer process when it should serve the shared interface.

## Navigation and usage

| Page | Local / review preview | Configured public deployment |
| --- | --- | --- |
| Overview / FAQs | `/` | `https://daisugi.fyi/` |
| Faucet | `/faucet` | `https://daisugi.fyi/faucet` |
| Explorer | `/explorer` | `https://explorer.daisugi.fyi/` |
| Transaction | `/explorer/tx/<hash>` | `https://explorer.daisugi.fyi/tx/<hash>` |

Localhost, IP addresses and review tunnels remain self-contained: navigation does
not send the user to the production domains. Old hash bookmarks are supported.
The same header, fonts and styles are used on both public hosts, and the theme
preference is shared between them.

1. Read Overview for network information and wallet setup.
2. Open Faucet, enter a recipient address and request 1 test ETH. No wallet
   connection is required.
3. Open the returned transaction link to inspect its inclusion and receipt.
4. Use Explorer to search for a block, address, transaction or UserOperation.
   A successful enclosing transaction does not by itself prove that every
   UserOperation in the bundle succeeded.
5. Inspect complete input bytes, decoded parameters, signature length and
   available execution details. Missing data is labelled rather than inferred.

The faucet serves chain 1337 only. Its API accepts up to 10 ETH per request;
the interface requests 1 ETH. The per-address cooldown is 60 seconds and is local
to the running process. Test ETH has no monetary value.

See [docs/PORTAL.md](docs/PORTAL.md) for APIs, decoding, fee calculations and
verification details. The prepared public routing requires deployment of the
updated code and the settings in [docs/DUAL-DOMAIN.md](docs/DUAL-DOMAIN.md);
a Git push alone does not configure the running services.

## Development and release pipeline

The prepared workflow uses dev, staging and main branches, with automated checks,
staging deployment after an approved merge, and manual production deployment.
It does not require another reviewer. Host provisioning, branch protection and
deployment enablement are separate setup steps.

See [docs/PIPELINE.md](docs/PIPELINE.md) for the release process, required access,
configuration, verification and rollback behavior.

## Provision a new devnet

These steps create infrastructure and deploy the repository's baseline contracts.
They are not needed when updating the portal on an already provisioned network.

### Start the network

```sh
kurtosis run --enclave aa-devnet github.com/ethpandaops/ethereum-package@c0db06b29b8266e65c9b80b64895e07058d28d0b --args-file network_params.yaml
kurtosis port print aa-devnet el-1-geth-lighthouse rpc
```

Set `RPC_URL` in `.env` to the printed address, including the `http://` prefix:

```sh
RPC_URL=http://127.0.0.1:32773
```

The actual port depends on the host. The network uses chain ID **1337**, four
validators, and two-second slots. Client images are pinned in
`network_params.yaml`, which also funds the deployment and bundler accounts.

### Compile and deploy the contracts

From the repository root:

```sh
git clone https://github.com/eth-infinitism/account-abstraction.git
git -C account-abstraction checkout 1c6b669d0eea734e09a87e095ba15e076151718a
cd account-abstraction
npx --yes yarn@1.22.22 install --frozen-lockfile
npx hardhat compile
cd ..

set -a
. ./.env
set +a
node deploy-canonical.cjs
```

Copy the printed `ENTRY_POINT` and `FACTORY_ADDRESS` values into `.env`.
The factory address is specific to your deployment. Running the deployment
script again creates another factory.

The expected EntryPoint address is
`0x433709009B8330FDa32311DF1C2AFA402eD8D009`. Keep the pinned compiler settings:
Solidity 0.8.28, Cancun, viaIR, and 1,000,000 optimizer runs. Changing the
bytecode changes its CREATE2 address.

### Start the bundler

Reload the updated configuration, then start Alto:

```sh
set -a
. ./.env
set +a
sh start-alto.sh
docker logs --tail 50 aa-devnet-alto
```

The container is named `aa-devnet-alto`. The launcher uses a pinned image and
mounts `SafeValidator.js` as a compatibility override. It does not replace an
existing container with the same name.

## Tests

Run the unit tests without creating accounts or sending transactions:

```sh
node --test tests/*.test.mjs explorer/user-operation.test.mjs
```

Browser checks should cover navigation, deep-link reloads, old bookmarks, search,
calldata decoding, mobile layouts and theme persistence across the two public
origins. Mock `POST /api/faucet` when exercising the form.

The retained `tests/verify-aa.mjs` script is a live-chain integration test for the
original AA flow. It creates a disposable account and sends test ETH. Use it only
on an appropriate test fixture whose deployed contracts match its assumptions;
it is not a read-only UI check. Historical verification results are in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Operations

Inspect an existing Kurtosis network and bundler using their actual names:

```sh
kurtosis enclave inspect aa-devnet
docker logs --tail 50 aa-devnet-alto
```

The root systemd unit templates use `/opt/kurtosis-aa-devnet`. The dedicated-host
templates in [deploy/ef](deploy/ef/README.md) use `/opt/aa-pq/app`. Reconcile paths,
users, ports and existing environment settings before selecting a template.
Enable the shared explorer UI with `PORTAL_ORIGIN` as described in
[docs/DUAL-DOMAIN.md](docs/DUAL-DOMAIN.md).

Keep an existing deployment's private environment configuration and reconcile
local source changes before replacing files. Avoid running a second process on
an occupied port. Restart the relevant service after backend or environment
changes; static assets are read from disk on each request.

Deployment troubleshooting and chain implementation notes are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development notes

Wallet signing and UserOperation submission happen outside the portal. Faucet
funding and the bundler's enclosing transactions use standard Ethereum
transactions. The UserOperation mempool is managed by Alto.

The sample funding keys are public and intended for a disposable testnet. The
portal does not hold a visitor's wallet keys. The faucet is unauthenticated; its
process-local cooldown is not a distributed abuse-prevention system.

Inter is self-hosted with its included SIL Open Font License. Third-party
attribution and network component licenses are listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
