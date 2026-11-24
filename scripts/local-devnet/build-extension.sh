#!/usr/bin/env bash
# Builds the NiceTry extension for a local devnet run: the run's native leanSPHINCS frame profile and the local HTTPS
# front (https://daisugi.test:8443). Load the output directory as an unpacked extension. The run must provide that
# profile: the devnet scripts do not deploy the leanSPHINCS verifier and factory yet.
# Usage: scripts/local-devnet/build-extension.sh <devnet run dir> [native profile json] [out dir]
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
RUN=$(realpath "${1:?devnet run dir}")
PROFILE=$(realpath "${2:-$RUN/aa-pq/native-profile.json}")
OUT=$(realpath -m "${3:-$RUN/aa-pq/extension}")
ORIGIN=https://daisugi.test:8443
# The build empties its output directory: never point it at anything but an earlier extension build.
if [[ -e $OUT && ! -f $OUT/manifest.json ]]; then echo "$OUT exists and is not an extension build" >&2; exit 1; fi
cd "$REPO/aggregation/frames/extension"
NICETRY_NATIVE_PROFILE=$PROFILE NICETRY_RPC_URL=$ORIGIN/rpc \
  NICETRY_EXPLORER_URL=$ORIGIN/explorer npx vite build --logLevel warn --outDir "$OUT"
echo "unpacked extension: $OUT (chain $(jq .chainId "$PROFILE"), $(jq -r .eip8288Format "$PROFILE"))"
