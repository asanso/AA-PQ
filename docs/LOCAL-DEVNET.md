# Local EIP-8288 devnet with AA-PQ

Run a disposable, fresh-genesis EIP-8288 Daisugi devnet on one Linux machine and use AA-PQ against it: portal, faucet, explorer and the NiceTry post-quantum wallet extension.

- The EL+CL devnet comes from the Daisugi devnet kit in the Nethermind repository (`tools/daisugi-devnet`, Compose or Kurtosis). This repository adds only the AA-PQ side, under `scripts/local-devnet/`.
- Chain ID `7357` below is an **example development value**, not a shared network's chain ID.
- Everything here is disposable: devnet keys, wallets and test ETH. Read [Credentials](#4-credentials) before reusing anything.

## 1. Architecture

```text
 Chromium ── NiceTry extension (SPHINCS-G signer, aggregated frames)
    │              │ HTTPS /rpc            (local front: https://daisugi.test:8443)
    │              ▼
    └────────► tls-proxy :8443 ──► AA-PQ portal :3004 ── /rpc gateway, faucet, portal pages, /explorer pages
                                        │        └──────► AA-PQ explorer indexer :3005
                                        ▼
                              Nethermind (EL) :28545 ◄── Engine API ──► Lighthouse beacon :25052 ◄── validator
```

| Component | Role |
|---|---|
| Nethermind `feature/eip8288-lean` | Execution client: EIP-8141 frame transactions, EIP-8288 proof wrappers, recursive STARK in the block body. |
| Lighthouse v8.2.2 + AA-PQ overlay | Beacon node and validator; Daisugi fork carrying the proof in execution payloads. |
| `tools/daisugi-devnet` (Nethermind repository) | Genesis, Compose and Kurtosis topologies, health checks. |
| Portal (`frontend/server.mjs`) | Portal pages, faucet, and the `/rpc` gateway that validates wallet wrappers before the node. |
| Explorer (`explorer/server.mjs`) | Indexer and API behind the portal's explorer pages. |
| Lean account factory | Deploys immutable SPHINCS-G accounts for the `eip8288-lean` format. |
| NiceTry extension | Browser wallet: onboarding, SPHINCS-G signing, 4-frame account creation, 3-frame sends. |
| `scripts/local-devnet/` | Factory deployment, service start/stop, identity checks, HTTPS front, extension build, browser test, Kurtosis run directory. |

## 2. Requirements

| Item | Tested with | Notes |
|---|---|---|
| OS | Linux x86_64 | The only validated platform. |
| Docker | 29.8.2, Compose 5.6.0 | Compose 2.24 or later. Kurtosis needs a Docker host that is not a Swarm node. |
| Node.js | 22.23.3 | CI pins 22.23.2. |
| Tools | `git`, `jq`, `curl`, `openssl`, `python3` | |
| Chromium | 156 (open-source build) | Branded Google Chrome ignores `--load-extension`. |
| Kurtosis (optional) | CLI 1.22.1 | Plus .NET SDK 10.0.300+ and Rust for the kit's `pq.sh`. |

Hardware, as measured on one host:
- **Image builds (32 cores):** about 4 to 7 min for Nethermind and 5 to 6 min for Lighthouse.
- **Running devnet:** peaks during proof-bearing blocks are Nethermind 1.9 GiB at 2.3 cores, beacon 0.7 GiB and validator 0.4 GiB. Add about 1 GiB for the AA-PQ services and Chromium.
- **Suggested minimum:** 8 cores, 16 GB RAM, 20 GB free disk.

## 3. Tested revisions

| Component | Source | Revision |
|---|---|---|
| Devnet kit | `https://github.com/NethermindEth/nethermind`, branch `daisugi/devnet-handoff` | `ff0d878dbc9b577629e9ed274b46a766873408a2` |
| Nethermind | same repository, `feature/eip8288-lean` | `0260e692fcf8e6b8bcb41289d877e0d5e380b5cd` (identical source tree) |
| Lighthouse | `https://github.com/sigp/lighthouse` | `e423a66763bb1bd780492d635123f208d80c3538` (v8.2.2), archive sha256 `3f3193218d8f7228889505eb508c6176ea60a964fcfb072eb248787c1e242d4c` |
| Lighthouse overlay | `https://github.com/asanso/AA-PQ` | `a03100abece8f8ed129c488db50ba89dde11b10a` (`aggregation/frames/consensus/eip8288-lean`) |
| Genesis generator | `ethpandaops/ethereum-genesis-generator` | `sha256:287f596b9a4ee72ae2aff194682f854650a8861542e489259adf0975cc0c9a54` |
| ethereum-package (Kurtosis) | `github.com/ethpandaops/ethereum-package` | `5795b77e65235ad223d4d3b413b2739190bf60cc` (pinned by the kit) |
| AA-PQ | this repository | the commit that contains this file |

Images are built locally (section 6); none are published. The Lighthouse binary is reproducible: `/lighthouse` must hash to `2e709e64cb111070fb4846d98f928dffd0d646904574a07478ffcb02aa390bcb`.

## 4. Credentials

| | Local devnet (this guide) | Shared network |
|---|---|---|
| Genesis | `LOCAL=1 ./gen-genesis.sh …` | `gen-genesis.sh` without `LOCAL=1` |
| Mnemonic | Random per run, written to `<run>/mnemonic` (Compose); ethereum-package's **public** mnemonic (Kurtosis) | Private: `DEVNET_MNEMONIC_FILE` with mode 0600, never a public test mnemonic; the kit refuses public ones |
| Chain ID | Any unused value; 7357 here | A new value, never 1 or 1337 |
| Validator keys | All on this host | Disjoint ranges per operator (`OPERATORS`); each operator receives only its own keystores |
| JWT secret | Created per run | Created per operator host by `up.sh` |
| AA-PQ deployer and faucet | First and second premined accounts of the run mnemonic | Dedicated keys held by the operators; `deploy-lean-factory.mjs` refuses runs without `LOCAL=1` |

Rules for every run:
- Keep the run directory **outside this repository**. It holds the mnemonic, validator keystores, the JWT secret, the AA-PQ profiles and the HTTPS key, and the scripts refuse a run directory inside the checkout.
- Nothing from a run belongs in Git. The scripts write only into the run directory.
- A public mnemonic, a run's mnemonic or any account derived from it is compromised by definition. Never fund it on a network that matters.

## 5. Get the sources

```bash
export WORK=~/daisugi-devnet && mkdir -p $WORK && cd $WORK
git clone --filter=blob:none --no-checkout https://github.com/NethermindEth/nethermind nethermind
git -C nethermind checkout ff0d878dbc9b577629e9ed274b46a766873408a2
git clone https://github.com/asanso/AA-PQ AA-PQ    # then check out the branch or commit that contains this file
cd $WORK/AA-PQ
for d in frontend explorer frame-account aggregation/frames/extension scripts/local-devnet; do
  npm ci --prefix $d --ignore-scripts --no-audit --no-fund
done
```

## 6. Build the client images

These are the kit's commands (`tools/daisugi-devnet/README.md`, section 1).

```bash
cd $WORK/nethermind
docker build -f tools/daisugi-devnet/images/nethermind.Dockerfile \
  --build-arg COMMIT_HASH=0260e692fcf8e6b8bcb41289d877e0d5e380b5cd -t daisugi/nethermind:0260e692fc .

B=tools/daisugi-devnet/build; LH=e423a66763bb1bd780492d635123f208d80c3538; mkdir -p $B
curl -fsSL -o $B/lighthouse.tar.gz https://github.com/sigp/lighthouse/archive/$LH.tar.gz
echo "3f3193218d8f7228889505eb508c6176ea60a964fcfb072eb248787c1e242d4c  $B/lighthouse.tar.gz" | sha256sum -c
tar -xzf $B/lighthouse.tar.gz -C $B
git clone -q https://github.com/asanso/AA-PQ $B/AA-PQ
git -C $B/AA-PQ fetch -q origin a03100abece8f8ed129c488db50ba89dde11b10a && git -C $B/AA-PQ checkout -q FETCH_HEAD
(cd $B/AA-PQ/aggregation/frames/consensus/eip8288-lean && python3 -m unittest discover -p 'test_*.py' \
  && python3 apply.py lighthouse ../../../../../lighthouse-$LH --check && python3 apply.py lighthouse ../../../../../lighthouse-$LH)
docker build -f $B/lighthouse-$LH/Dockerfile.reproducible --platform linux/amd64 \
  --build-arg RUST_TARGET=x86_64-unknown-linux-gnu -t daisugi/lighthouse:eip8288-lean $B/lighthouse-$LH

BIN=$(mktemp); cid=$(docker create daisugi/lighthouse:eip8288-lean); docker cp $cid:/lighthouse $BIN; docker rm $cid
sha256sum $BIN; rm $BIN   # 2e709e64cb111070fb4846d98f928dffd0d646904574a07478ffcb02aa390bcb
```

`apply.py` prints `"files": 67` and `"activated": false` for the check and the apply. `activated` refers to a live fork schedule, not to the patch.

## 7. Start the devnet (Compose)

```bash
cd $WORK/nethermind/tools/daisugi-devnet
export COMPOSE_FILE=docker-compose.yml:lighthouse-distroless.override.yml
export RUN=$WORK/run/devnet NM=daisugi/nethermind:0260e692fc LH=daisugi/lighthouse:eip8288-lean
mkdir -p $WORK/run
CHAIN_ID=7357 LOCAL=1 ./gen-genesis.sh $RUN $(( $(date +%s) + 30 )) 3
./up.sh $RUN $NM $LH
./check.sh $RUN      # about 4 min: waits for finality past the EIP-8288 fork epoch
```

- EIP-8288 activates at epoch 3, which is block 96.
- `check.sh` ends with `PASS`: EL/CL genesis match, Lean backend, 21 header fields at block 95 and 25 at block 96, no missed slots, finality.
- A few beacon and validator `ERROR/CRIT` lines at startup are connection races and don't fail `check.sh`.
- Ports: Nethermind JSON-RPC `127.0.0.1:28545`, beacon API `127.0.0.1:25052`.

For Kurtosis, see section 13.

## 8. Deploy the lean factory and write the AA-PQ profiles

```bash
cd $WORK/AA-PQ
node scripts/local-devnet/deploy-lean-factory.mjs $RUN      # optional second argument: the EL RPC URL
```

What it does:
- Checks the RPC chain and genesis against `$RUN/params.json`.
- Compiles `SphincsAggregateAccountFactory.sol` (solc 0.8.28, viaIR, optimizer 200, cancun) and checks the creation code.
- Deploys it from the run's first premined account and verifies the deployed implementation.
- Writes `$RUN/aa-pq/wallet-profile.json` (extension build) and `$RUN/aa-pq/network-profile.json` (portal and explorer).

| Item | Value |
|---|---|
| Account domain | `Daisugi.AggregatedFrameAccount.eip8288-lean.v2` = `0xf85581336272cf62a5b94ecfef7281f771727d40ba797c1780191b82537e0768` |
| Implementation runtime keccak | `0x0b882e19e2b9d99498fec4d6c7df7d308c190b5e73a4ffd2542d0aef1d11b467` (1646 bytes) |
| Factory creation code keccak | `0x20b2c6800593acfdccbd46aa34420792b734993e1ca4d4867971194f30315462` |
| Implementation address | `CREATE(factory, 1)` |
| Factory code hash | depends on the deployment (embeds `ACCOUNT_IMPL`); recorded in `wallet-profile.json` |
| Account address | `CREATE2(factory, 0x00…00, keccak256(0x3d604d80600a3d3981f3 ‖ 0x363d3d373d3d3d363d73 ‖ implementation ‖ 0x5af43d82803e903d91602b57fd5bf3 ‖ keccak256(pkRoot16 ‖ pkSeed16)))` |

A fresh devnet has no ERC-4337 or legacy native-frame contracts. The server profile therefore uses placeholder addresses for `entryPoint` and the `native*` fields.

## 9. Start the portal, gateway, faucet and explorer

```bash
scripts/local-devnet/start-services.sh $RUN        # optional second argument: the EL RPC URL
node scripts/local-devnet/verify-services.mjs $RUN  # env EL_RPC and CL_API override the Compose ports
```

`start-services.sh` starts:
- the explorer on `:3005`
- the portal on `:3004`, with the `/rpc` gateway and a faucet funded by the run's second premined account
- an HTTPS front on `:8443` for `daisugi.test`, with a self-signed certificate. The NiceTry build accepts only HTTPS endpoints that aren't localhost.

Logs and pid files are in `$RUN/aa-pq/`.

`verify-services.mjs` prints `PASS` for:
- the devnet's chain, genesis, fork and finality
- the lean contracts on chain
- the same chain ID and genesis from every portal endpoint, the gateway (HTTP and HTTPS) and the explorer
- a portal for another chain ID failing closed
- a gateway for another genesis refusing submissions

## 10. Build and use the NiceTry extension

```bash
scripts/local-devnet/build-extension.sh $RUN        # -> $RUN/aa-pq/extension
chromium --user-data-dir=$(mktemp -d) --no-first-run \
  --disable-extensions-except=$RUN/aa-pq/extension --load-extension=$RUN/aa-pq/extension \
  --host-resolver-rules="MAP daisugi.test 127.0.0.1" \
  --ignore-certificate-errors-spki-list=$(cat $RUN/aa-pq/tls/spki.txt) \
  https://daisugi.test:8443/
```

The SPKI pin trusts only this run's certificate.

1. NiceTry opens "Set up NiceTry" by itself. Choose **Create new wallet**, then **Aggregated frames**. **ERC-4337** is disabled: "ERC-4337 is not deployed on this network".
2. Set a password, reveal the seed phrase, then **Backup seed phrase** (enabled after a countdown), then **Open wallet**.
3. **Receive** shows the account address. It's counterfactual until the first send.
4. Fund it: open `https://daisugi.test:8443/faucet`, paste the address, then **Send 1 test ETH**.
5. **Send**, then **ETH**, then **Confirm**. Enter a recipient and amount, **Confirm**, review, **Confirm**.
   - The first send creates the account with 4 frames at nonce 0.
   - Later sends use 3 frames; the nonce is 2 after creation.
6. The send appears under **Transactions**, a collapsible section.

## 11. Inspect transactions, proofs and finality

```bash
TX=0x...   # from the wallet history, the explorer, or the "sends" in the browser test's JSON output
EL_RPC=${EL_RPC:-http://127.0.0.1:28545} CL_API=${CL_API:-http://127.0.0.1:25052}   # Kurtosis: set by section 13
curl -s -X POST -H 'content-type: application/json' $EL_RPC \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$TX\"]}" \
  | jq '.result | {status, blockNumber, gasUsed, frames: [.frameReceipts[]?.status]}'
curl -s $CL_API/eth/v1/beacon/states/head/finality_checkpoints | jq .data.finalized
```

- `https://daisugi.test:8443/explorer/tx/$TX` shows the frames, the gas and the block's body proof.
- The explorer decodes the proof; Nethermind verifies it.
- The kit's `proof.sh` replays proof blocks on an empty node.

## 12. Browser smoke test

```bash
jq '.chainId += 1' $RUN/aa-pq/wallet-profile.json > $RUN/aa-pq/wallet-profile-wrong-chain.json
scripts/local-devnet/build-extension.sh $RUN $RUN/aa-pq/wallet-profile-wrong-chain.json $RUN/aa-pq/extension-wrong-chain
node scripts/local-devnet/ui-e2e.mjs $RUN $RUN/aa-pq/extension $RUN/aa-pq/extension-wrong-chain
```

How it runs:
- Headless Chromium (`CHROMIUM=/path` to override), a temporary profile and a random test password.
- It drives the real extension and portal pages, and checks each on-chain result against Nethermind.
- It runs the 15 checks below, in order, and ends with a JSON summary.

**Account and sends**
1. ERC-4337 setup is unavailable on this network.
2. Onboarding creates an aggregated-frames account.
3. The faucet page shows the chain ID and funds the account.
4. The extension shows the funded balance.
5. The UI sends the 4-frame account creation. The node confirms the status, every frame, the body proof covering the transaction, the clone bytecode and the recipient balance.
6. The UI sends the 3-frame transfer, with the same node checks.
7. The explorer pages match the node.
8. A reloaded popup matches the node's balance and history.

**Failures and recovery**

9. A gateway refusing aggregation: **TRANSACTION FAILED**, nothing broadcast.
10. The next send after that failure succeeds.
11. The gateway refuses the submission itself: **TRANSACTION FAILED** with the network's reason, nothing broadcast, and the wallet stays usable.
12. The reply is lost after broadcast: the wallet resolves the send from its receipt, and the transfer happens once.
13. The submission is lost in transit: the wallet re-sends the identical signed bytes, and the transfer happens once.
14. An unreachable RPC shows the balance as unavailable, not 0.
15. An extension built for another chain refuses to prepare: **Unexpected network**.

`EL_RPC` overrides the node URL; `PORTAL_RPC` overrides the portal URL used for check 12.

## 13. Kurtosis

The kit's `kurtosis/run.sh` starts the same topology as an enclave, then runs `check.sh` and three PQ transaction series.

```bash
cd $WORK/nethermind/tools/daisugi-devnet
KEEP=1 NETHERMIND_IMAGE=$NM LIGHTHOUSE_IMAGE=$LH kurtosis/run.sh daisugi
cd $WORK/AA-PQ
eval "$(scripts/local-devnet/kurtosis-run-dir.sh $WORK/nethermind/tools/daisugi-devnet daisugi $WORK/run/kurtosis-daisugi)"
node scripts/local-devnet/deploy-lean-factory.mjs $RUN $EL_RPC
scripts/local-devnet/start-services.sh $RUN $EL_RPC
node scripts/local-devnet/verify-services.mjs $RUN
```

Sections 10 to 12 then work as written: `ui-e2e.mjs` and section 11 read `EL_RPC` and `CL_API` from this shell.

- **Run directory:** `kurtosis-run-dir.sh` writes `$RUN/params.json` with the enclave's genesis, chain ID and fork epoch. It also writes `$RUN/mnemonic`, the enclave's **public** prefunding mnemonic, and prints `RUN`, `EL_RPC` and `CL_API` for the dynamic ports.
- **Chain ID:** the kit pins chain ID 1337 (`network_id` in `kurtosis/network_params.yaml`). For another chain ID, edit that value in your checkout before `run.sh`.
- **Docker:** a host that is or was a Swarm node fails with `Expected exactly one network matching the name … 'bridge', but got 2`. Leave the Swarm, then remove the leftover `docker_gwbridge` network.

Clean up:

```bash
scripts/local-devnet/stop-services.sh $RUN
kurtosis enclave rm -f daisugi
kurtosis engine stop     # the engine also runs its own log and telemetry containers
rm -rf $RUN $WORK/nethermind/tools/daisugi-devnet/kurtosis/run/daisugi
```

## 14. Stop and clean up (Compose)

In a new shell, the defaults below match sections 5 and 7; existing values are kept.

```bash
export WORK=${WORK:-~/daisugi-devnet}; export RUN=${RUN:-$WORK/run/devnet}
export NM=${NM:-daisugi/nethermind:0260e692fc} LH=${LH:-daisugi/lighthouse:eip8288-lean}
export COMPOSE_FILE=docker-compose.yml:lighthouse-distroless.override.yml
cd $WORK/AA-PQ && scripts/local-devnet/stop-services.sh $RUN
cd $WORK/nethermind/tools/daisugi-devnet
GENESIS_DIR=$RUN VALIDATOR_DIR=$RUN/data/validators NETHERMIND_IMAGE=$NM LIGHTHOUSE_IMAGE=$LH DEVNET_USER=$(id -u):$(id -g) \
  docker compose --profile replay --profile sync down    # compose needs the variables that up.sh exports only to itself
rm -rf $RUN              # deletes the mnemonic, validator keys and chain data
```

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gen-genesis.sh`: `… exists; pick a new directory` | Run directory reused | Remove it or pick another path. |
| `check.sh` waits a long time | Finality needs about 4 min after genesis | Wait; `docker logs daisugi-beacon`. |
| Nethermind exits at `InitializeLeanBackend` | Image built without the native Lean library | Build with `images/nethermind.Dockerfile` (section 6). |
| `lighthouse: not found` at start | `COMPOSE_FILE` lacks the distroless override | Export `COMPOSE_FILE` as in section 7. |
| `Put the devnet run directory outside the repository.` | Run directory inside the AA-PQ checkout | Use a path under `$WORK`. |
| `This is a shared-network run …` | Genesis made without `LOCAL=1` | The scripts are for local runs only (section 4). |
| Extension build: `NICETRY_RPC_URL must be an explicit HTTPS /rpc endpoint` | Localhost or HTTP endpoint | Use `build-extension.sh`. |
| `ERR_CERT_AUTHORITY_INVALID` | Browser lacks the SPKI pin | Use the flag from section 10. |
| `daisugi.test` does not resolve | Host mapping missing | `--host-resolver-rules` (section 10), or `/etc/hosts`. |
| Extension does not load | Branded Chrome ignores `--load-extension` | Use Chromium, or **Load unpacked** in `chrome://extensions`. |
| Balance shows `—` and "Balance unavailable" | The wallet cannot reach the gateway | `start-services.sh`; check `$RUN/aa-pq/logs/`. |
| "A previous transaction is still unresolved" | A submission's outcome is unknown | The wallet re-sends the same signed bytes every 30 s and clears the block once the receipt arrives, the nonce is used, or the network rejects it. |
| Portal status "degraded" | No ERC-4337 bundler on a fresh devnet | Expected. |
| `Unexpected network. Sending is disabled.` | Extension built for another chain or genesis | Rebuild with the run's `wallet-profile.json`. |

## 16. Known limitations

- ERC-4337 mode is unavailable on any chain other than the live 1337 one: the bundler and EntryPoint aren't deployed on a fresh devnet.
- The wallet's network label reads "Daisugi Testnet" on every chain.
- The HTTPS front uses a self-signed certificate, trusted through a browser flag.
- Single host and x86_64 only.
- Client images aren't published; every machine builds them (section 6).
