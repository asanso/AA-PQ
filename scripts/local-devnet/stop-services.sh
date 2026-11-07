#!/usr/bin/env bash
# Stops the services start-services.sh started for a devnet run.
# Usage: scripts/local-devnet/stop-services.sh <devnet run dir>
set -euo pipefail
PIDS=$(realpath "${1:?devnet run dir}")/aa-pq/pids
for file in "$PIDS"/*.pid; do
  [[ -f $file ]] || continue
  kill "$(cat "$file")" 2>/dev/null || true
  rm -f "$file"
done
echo "stopped AA-PQ services"
