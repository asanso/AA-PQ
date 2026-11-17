#!/usr/bin/env bash
# Stops the services start-services.sh started for a devnet run.
# Usage: scripts/local-devnet/stop-services.sh <devnet run dir>
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PIDS=$(realpath "${1:?devnet run dir}")/aa-pq/pids

# A pid file outlives a crash or a reboot, by which time the number may belong to something else. start-services.sh
# execs each service, so a live one is a node process whose working directory is this repository; anything else is
# left alone rather than killed.
ours() {
  local pid=$1
  [[ -d /proc/$pid ]] || return 1
  [[ $(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | head -1) == *node ]] || return 1
  [[ $(readlink "/proc/$pid/cwd" 2>/dev/null) == "$REPO" ]] || return 1
}

for file in "$PIDS"/*.pid; do
  [[ -f $file ]] || continue
  pid=$(cat "$file")
  if [[ $pid =~ ^[1-9][0-9]*$ ]] && ours "$pid"; then
    kill "$pid" 2>/dev/null || true
  elif [[ -d /proc/$pid ]]; then
    echo "left pid $pid alone: not a node process of $REPO ($(basename "$file"))" >&2
  fi
  rm -f "$file"
done
echo "stopped AA-PQ services"
