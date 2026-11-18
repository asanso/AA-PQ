# Local EIP-8288 devnet with AA-PQ

Run a disposable EIP-8288 Daisugi devnet on one Linux machine, then use the AA-PQ portal, faucet, explorer and the NiceTry wallet against it.

- The clients come from the Daisugi devnet kit in the Nethermind repository (`tools/daisugi-devnet`), started with Docker Compose or Kurtosis.
- This repository adds the AA-PQ side in `scripts/local-devnet/`.
- Everything is disposable: the mnemonic, keys and test ETH of a run are local-only. Keep the run directory outside this repository; the scripts refuse one inside it.

## Requirements

- Linux x86_64, Docker with Compose 2.24 or later, Node.js 22, `git`, `jq`, `curl`, `openssl`, `python3`.
- Chromium (branded Chrome ignores `--load-extension`).
- For the Kurtosis option: the Kurtosis CLI on a Docker host that is not a Swarm node (Kurtosis fails on a second network named `*bridge*`, such as `docker_gwbridge`) and has port 8081 free.
- About 8 cores, 16 GB RAM and 20 GB free disk.

## Revisions

| Component | Revision |
|---|---|
| Devnet kit | NethermindEth/nethermind `daisugi/devnet-handoff` `bddde6bf09` (restart handoff in `tools/daisugi-devnet/RESTART.md`) |
| Nethermind | NethermindEth/nethermind `daisugi/eip8288-lean` `af50ed19171295395ea12513f6d9464b782f4c5a` (`feature/eip8288-lean` with #15955, #15870 and #15961), native Lean backend from `Nethermind.Crypto.Lean` 0.21.0.110 (F128, ABI 21, key `PK.seed \|\| PK.root`) |
| Lighthouse | manusw7/lighthouse `daisugi/eip8288-lean` `16a05d1e17a22d132933e3ec927a6f1b9daf0b1a`: sigp/lighthouse v8.2.2 `e423a667` with the Daisugi fork (formerly this repository's patches 0001-0014, #10) |
| Lean account | `Daisugi.AggregatedFrameAccount.eip8288-lean.v2`, runtime `0x0b882e19e2b9d99498fec4d6c7df7d308c190b5e73a4ffd2542d0aef1d11b467` |

## 1. Sources and images

```bash
export WORK=~/daisugi-devnet && mkdir -p $WORK && cd $WORK
git clone --filter=blob:none --no-checkout https://github.com/NethermindEth/nethermind nethermind
git -C nethermind checkout bddde6bf093ca35712414aaede95d5b5be15a699                     # the kit
git -C nethermind worktree add ../nethermind-el af50ed19171295395ea12513f6d9464b782f4c5a  # the client
git clone https://github.com/asanso/AA-PQ AA-PQ    # then check out the commit that contains this file
for d in frontend explorer frame-account aggregation/frames/extension; do
  npm ci --prefix AA-PQ/$d --ignore-scripts --no-audit --no-fund
done

# Nethermind's stock Dockerfile restores the native Lean library from Nethermind.Crypto.Lean; no Rust.
docker build --build-arg COMMIT_HASH=af50ed19171295395ea12513f6d9464b782f4c5a -t daisugi/nethermind:af50ed1917 nethermind-el

# Lighthouse: the Daisugi fork, built with the Dockerfile EthPandaOps' image builder uses for the shared network.
git clone --filter=blob:none https://github.com/manusw7/lighthouse lighthouse
git -C lighthouse checkout 16a05d1e17a22d132933e3ec927a6f1b9daf0b1a   # daisugi/eip8288-lean
curl -fsSL https://raw.githubusercontent.com/ethpandaops/eth-client-docker-image-builder/19cae9e7f056971c530f66a4b496090ec468fb0c/lighthouse/Dockerfile \
  | docker build -f - -t daisugi/lighthouse:eip8288-lean lighthouse
```

Each image build takes about 5 minutes on 32 cores.

## 2. Start the devnet

Pick one option. Both activate EIP-8288 at epoch 3 (block 96) on a Prague genesis.

**Option A: Docker Compose.** Fixed ports: Nethermind `127.0.0.1:28545`, beacon `127.0.0.1:25052`.

```bash
cd $WORK/nethermind/tools/daisugi-devnet
export RUN=$WORK/run/devnet EL_RPC=http://127.0.0.1:28545
CHAIN_ID=7357 LOCAL=1 ./gen-genesis.sh $RUN $(( $(date +%s) + 30 )) 3
./up.sh $RUN daisugi/nethermind:af50ed1917 daisugi/lighthouse:eip8288-lean
./check.sh $RUN      # about 4 minutes; ends with PASS once finality passes the fork
```

**Option B: Kurtosis.** Uses ethpandaops' ethereum-package, chain ID 1337 and its public prefunding mnemonic: a local devnet only. The shared Daisugi network gets its own chain ID and private mnemonic from the kit's `gen-genesis.sh`, never these.

```bash
cd $WORK/nethermind/tools/daisugi-devnet
KEEP=1 PQ_SERIES=0 NETHERMIND_IMAGE=daisugi/nethermind:af50ed1917 LIGHTHOUSE_IMAGE=daisugi/lighthouse:eip8288-lean \
  kurtosis/run.sh daisugi
cd $WORK/AA-PQ
eval "$(scripts/local-devnet/kurtosis-run-dir.sh $WORK/nethermind/tools/daisugi-devnet daisugi $WORK/run/kurtosis)"
```

`run.sh` checks the fork and finality like `check.sh`. `NODES=3` starts three Nethermind + Lighthouse + validator nodes instead of one; that configuration, with a late node from the kit's `kurtosis/sync.sh`, is the tested one. `kurtosis-run-dir.sh` writes the AA-PQ run directory and exports `RUN` and `EL_RPC` for the enclave's dynamic ports. `PQ_SERIES=0` skips the kit's own transaction series.

## 3. Deploy the Lean account factory

```bash
cd $WORK/AA-PQ
node scripts/local-devnet/deploy-lean-factory.mjs $RUN $EL_RPC
```

It checks the chain against `$RUN/params.json` and compiles the factory. It also checks the account runtime hash above, deploys from the run's first prefunded account, and writes `$RUN/aa-pq/wallet-profile.json` and `network-profile.json`.

## 4. Start the portal, gateway, faucet and explorer

```bash
scripts/local-devnet/start-services.sh $RUN $EL_RPC
curl -s --cacert $RUN/aa-pq/tls/cert.pem --resolve daisugi.test:8443:127.0.0.1 https://daisugi.test:8443/api/network | jq
```

- The explorer runs on `:3005`.
- The portal runs on `:3004`, with the `/rpc` gateway and a faucet funded by the run's second account.
- An HTTPS front on `:8443` serves `daisugi.test` with a self-signed certificate, because the wallet only accepts HTTPS endpoints that aren't localhost.
- `/api/network` should show this run's chain ID, `"rpc": "available"` and a growing `blockNumber`. Its `"status": "degraded"` only means there is no ERC-4337 bundler. Logs are in `$RUN/aa-pq/logs/`.

## 5. Use the wallet

```bash
scripts/local-devnet/build-extension.sh $RUN        # writes $RUN/aa-pq/extension
chromium --user-data-dir=$(mktemp -d) --no-first-run \
  --disable-extensions-except=$RUN/aa-pq/extension --load-extension=$RUN/aa-pq/extension \
  --host-resolver-rules="MAP daisugi.test 127.0.0.1" \
  --ignore-certificate-errors-spki-list=$(cat $RUN/aa-pq/tls/spki.txt) \
  https://daisugi.test:8443/
```

1. In "Set up NiceTry", choose **Create new wallet**, then **Aggregated frames**, set a password and back up the seed phrase.
2. Copy the address from **Receive**, then fund it at `https://daisugi.test:8443/faucet`.
3. **Send** some ETH. The first send creates the account (4 frames); later sends use 3 frames.
4. The transaction, its frames and the block's proof appear in the explorer at `https://daisugi.test:8443/explorer`.

## 6. Clean up

```bash
cd $WORK/AA-PQ && scripts/local-devnet/stop-services.sh $RUN
# Option A
cd $WORK/nethermind/tools/daisugi-devnet && GENESIS_DIR=$RUN NETHERMIND_IMAGE=unused LIGHTHOUSE_IMAGE=unused \
  DEVNET_USER=$(id -u):$(id -g) docker compose --profile replay --profile sync down
# Option B
kurtosis enclave rm -f daisugi && kurtosis engine stop
rm -rf $RUN
```

## Limitations

- ERC-4337 mode is unavailable: a fresh devnet has no bundler or EntryPoint.
- Single host, x86_64 only. Client images are built locally, not published.
- The kit's PQ transaction series (`pq.sh`) needs the .NET SDK and `FX` set to the `Nethermind.Crypto.Lean` package's `testing/runtimes/linux-x64/native/fixtures` signer; the wallet path above does not depend on it.
