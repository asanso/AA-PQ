#!/usr/bin/env bash
# Checks that stop-services.sh kills this repository's services and leaves a recycled pid alone.
# Usage: scripts/local-devnet/test-stop-services.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
RUN=$(mktemp -d)
trap 'rm -rf "$RUN"' EXIT
mkdir -p "$RUN/aa-pq/pids"
fail() { echo "FAIL: $*" >&2; exit 1; }

# A service as start-services.sh leaves it: node, execed, working directory the repository.
(cd "$REPO" && exec node -e 'setTimeout(() => {}, 60000)') &
service=$!
# A stranger that happens to hold a pid file's number after a reboot.
sleep 60 &
stranger=$!
# A pid file naming a number nothing is using.
dead=$(cat /proc/sys/kernel/pid_max)

for _ in $(seq 50); do [[ -d /proc/$service/cwd ]] && break; sleep 0.1; done
echo "$service" > "$RUN/aa-pq/pids/portal.pid"
echo "$stranger" > "$RUN/aa-pq/pids/recycled.pid"
echo "$dead" > "$RUN/aa-pq/pids/stale.pid"

output=$("$HERE/stop-services.sh" "$RUN" 2>&1) || fail "stop-services.sh exited non-zero: $output"
for _ in $(seq 50); do [[ -d /proc/$service ]] || break; sleep 0.1; done

[[ -d /proc/$service ]] && fail "the repository's own service survived"
[[ -d /proc/$stranger ]] || fail "a pid that is not ours was killed"
grep -q "left pid $stranger alone" <<<"$output" || fail "no notice for the recycled pid: $output"
compgen -G "$RUN/aa-pq/pids/*.pid" >/dev/null && fail "pid files were not removed"

kill "$stranger" 2>/dev/null || true
echo "PASS: killed the repository's service, left pid $stranger and stale pid $dead alone"
