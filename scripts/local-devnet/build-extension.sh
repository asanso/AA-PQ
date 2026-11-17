#!/usr/bin/env bash
# Builds the NiceTry extension for a local devnet run: the run's eip8288-lean wallet profile and the local HTTPS
# front (https://daisugi.test:8443). Load the output directory as an unpacked extension.
# Usage: scripts/local-devnet/build-extension.sh <devnet run dir> [wallet profile json] [out dir]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
RUN=$(realpath "${1:?devnet run dir}")
PROFILE=$(realpath "${2:-$RUN/aa-pq/wallet-profile.json}")
OUT=$(realpath -m "${3:-$RUN/aa-pq/extension}")
ORIGIN=https://daisugi.test:8443
# The build empties its output directory: never point it at anything but an earlier extension build.
if [[ -e $OUT && ! -f $OUT/manifest.json ]]; then echo "$OUT exists and is not an extension build" >&2; exit 1; fi
cd "$REPO/aggregation/frames/extension"
NICETRY_AGGREGATION_PROFILE=$PROFILE NICETRY_RPC_URL=$ORIGIN/rpc NICETRY_BUNDLER_URL=$ORIGIN/bundler \
  NICETRY_EXPLORER_URL=$ORIGIN/explorer npx vite build --logLevel warn --outDir "$OUT"
echo "unpacked extension: $OUT (chain $(jq .chainId "$PROFILE"), $(jq -r .eip8288Format "$PROFILE"))"
