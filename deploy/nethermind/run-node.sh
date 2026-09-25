#!/usr/bin/env bash
set -euo pipefail
: "${AA_NETHERMIND_IMAGE:?Set the tested immutable image ID or digest}"
: "${AA_GENESIS_FILE:?Set the original genesis file path}"
: "${AA_JWT_VOLUME:?Set the existing Engine JWT Docker volume}"
: "${AA_DATA_VOLUME:?Set the separate, synced Nethermind data volume}"
: "${AA_DOCKER_NETWORK:?Set the existing devnet Docker network}"
: "${AA_EXECUTION_IP:?Set the execution IP after the old node releases it}"
: "${AA_RPC_PORT:?Set the existing private RPC host port}"
case "$AA_NETHERMIND_IMAGE" in sha256:*|*@sha256:*) ;; *) echo 'Image must be pinned by digest' >&2; exit 1 ;; esac
test -f "$AA_GENESIS_FILE"
docker volume inspect "$AA_DATA_VOLUME" "$AA_JWT_VOLUME" >/dev/null
docker run -d --name aa-pq-nethermind --restart unless-stopped --stop-timeout 60 \
  --cpus 2.5 --memory 12g --memory-swap 12g \
  --network "$AA_DOCKER_NETWORK" --ip "$AA_EXECUTION_IP" \
  --network-alias el-1-geth-lighthouse \
  -p "127.0.0.1:${AA_RPC_PORT}:8545" -p 127.0.0.1:32772:8546 \
  -p 127.0.0.1:32771:8551 \
  -v "$AA_GENESIS_FILE:/config/genesis.json:ro" \
  -v "$AA_JWT_VOLUME:/jwt:ro" -v "$AA_DATA_VOLUME:/data" \
  "$AA_NETHERMIND_IMAGE" --config none \
  --Init.ChainSpecPath /config/genesis.json --Init.BaseDbPath /data \
  --Init.DiscoveryEnabled false --Init.PeerManagerEnabled false \
  --Sync.SnapSync false --Network.EnableExternalIpResolution false \
  --JsonRpc.Enabled true --JsonRpc.Host 0.0.0.0 --JsonRpc.WebSocketsPort 8546 \
  --JsonRpc.EnabledModules Eth,Net,Web3,Debug,Admin,Trace,TxPool \
  --JsonRpc.EngineHost 0.0.0.0 --JsonRpc.EnginePort 8551 \
  --JsonRpc.JwtSecretFile /jwt/jwtsecret --Blocks.SecondsPerSlot 2 \
  --TxPool.FrameTxMaxVerifyGas 500000 \
  --Pruning.Mode None --FlatDb.Enabled false
