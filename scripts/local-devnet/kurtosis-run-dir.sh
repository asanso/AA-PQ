#!/usr/bin/env bash
# Prepares an AA-PQ run directory for an enclave started by tools/daisugi-devnet/kurtosis/run.sh (KEEP=1), and prints
# the enclave's dynamic RPC ports. The enclave prefunds accounts from ethereum-package's public mnemonic: local use only.
# Usage: eval "$(scripts/local-devnet/kurtosis-run-dir.sh <devnet kit dir> <enclave> <run dir>)"
#   <devnet kit dir>: tools/daisugi-devnet of the Nethermind checkout that started the enclave.
set -euo pipefail
KIT=$(realpath "${1:?devnet kit dir}") ENCLAVE=${2:?enclave} RUN=$(realpath -m "${3:?run dir}")
REPO=$(cd "$(dirname "$0")/../.." && pwd)
[[ "$RUN/" != "$REPO/"* ]] || { echo "put the run directory outside the repository" >&2; exit 1; }
G=$KIT/kurtosis/run/$ENCLAVE
[[ -f $G/genesis.json && -f $G/params.json ]] || { echo "no run.sh output for enclave $ENCLAVE in $G" >&2; exit 1; }
port() { kurtosis port print "$ENCLAVE" "$1" "$2" | sed 's|.*:||'; }
EL_RPC=http://127.0.0.1:$(port el-1-nethermind-lighthouse rpc)
CL_API=http://127.0.0.1:$(port cl-1-lighthouse-nethermind http)
mkdir -p "$RUN" && chmod 700 "$RUN"
(umask 077; sed -n 's/^ *preregistered_validator_keys_mnemonic: *"\(.*\)"/\1/p' "$KIT/kurtosis/network_params.yaml" > "$RUN/mnemonic")
[[ -s $RUN/mnemonic ]] || { echo "no preregistered_validator_keys_mnemonic in network_params.yaml" >&2; exit 1; }
jq --argjson chain "$(jq .config.chainId "$G/genesis.json")" '. + {chainId: $chain, slotsPerEpoch: 32, local: true}' \
  "$G/params.json" > "$RUN/params.json"
printf 'export RUN=%q EL_RPC=%q CL_API=%q\n' "$RUN" "$EL_RPC" "$CL_API"
