#!/usr/bin/env bash
# Starts the AA-PQ explorer (3005), portal with RPC gateway and faucet (3004) and the local HTTPS front (8443)
# for a daisugi-devnet run whose lean factory deploy-lean-factory.mjs deployed.
# Usage: scripts/local-devnet/start-services.sh <devnet run dir> [el rpc url]
# Logs and pids: <run dir>/aa-pq/{logs,pids}. Stop with stop-services.sh.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
RUN=$(realpath "${1:?devnet run dir}")
EL_RPC=${2:-http://127.0.0.1:28545}
OUT=$RUN/aa-pq
PROFILE=$OUT/network-profile.json
[[ -f $PROFILE && -f $OUT/wallet-profile.json ]] || { echo "run deploy-lean-factory.mjs first" >&2; exit 1; }
mkdir -p "$OUT/logs" "$OUT/pids" "$OUT/tls"
for file in "$OUT"/pids/*.pid; do
  [[ -f $file ]] && kill -0 "$(cat "$file")" 2>/dev/null && { echo "services already running; run stop-services.sh first" >&2; exit 1; }
done
FACTORY=$(jq -r .factory "$OUT/wallet-profile.json")

# Self-signed certificate for the local HTTPS front (daisugi.test only), renewed when it expires within a day.
if [[ ! -f $OUT/tls/cert.pem ]] || ! openssl x509 -in "$OUT/tls/cert.pem" -noout -checkend 86400 >/dev/null; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=daisugi.test" -addext "subjectAltName=DNS:daisugi.test" \
    -keyout "$OUT/tls/key.pem" -out "$OUT/tls/cert.pem" 2>/dev/null
fi
# Chromium trusts exactly this certificate with --ignore-certificate-errors-spki-list=$(cat spki.txt).
openssl x509 -in "$OUT/tls/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64 > "$OUT/tls/spki.txt"

# The faucet signs with the run's second premined account. Only the portal gets the key, through its environment, never argv.
FAUCET_PRIVATE_KEY=$(cd "$REPO/frontend" && node -e "const e=require('ethers');const fs=require('fs');console.log(e.HDNodeWallet.fromPhrase(fs.readFileSync(process.argv[1],'utf8').trim(),undefined,\"m/44'/60'/0'/0/1\").privateKey)" "$RUN/mnemonic")

start() { # name, then env assignments and the command
  local name=$1; shift
  (cd "$REPO" && exec nohup env "$@" > "$OUT/logs/$name.log" 2>&1) &
  echo $! > "$OUT/pids/$name.pid"
}
start explorer HOST=127.0.0.1 PORT=3005 RPC_URL="$EL_RPC" DAISUGI_NETWORK_PROFILE="$PROFILE" \
  PORTAL_ORIGIN=http://127.0.0.1:3004 FRAME_INDEX_CACHE="$OUT/frame-index.json" NATIVE_AGGREGATION_FACTORY="$FACTORY" \
  node explorer/server.mjs
FAUCET_PRIVATE_KEY=$FAUCET_PRIVATE_KEY start portal HOST=127.0.0.1 PORT=3004 RPC_URL="$EL_RPC" FAUCET_RPC_URL="$EL_RPC" DAISUGI_NETWORK_PROFILE="$PROFILE" \
  BUNDLER_URL=http://127.0.0.1:9 EXPLORER_URL=http://127.0.0.1:3005 NATIVE_AGGREGATION_RPC_ENABLED=true \
  PUBLIC_SITE_URL=https://daisugi.test:8443 PUBLIC_EXPLORER_URL=https://daisugi.test:8443 \
  PUBLIC_RPC_URL=https://daisugi.test:8443/rpc THEME_COOKIE_DOMAIN=daisugi.test \
  node frontend/server.mjs
start tls node scripts/local-devnet/tls-proxy.mjs "$OUT/tls/cert.pem" "$OUT/tls/key.pem" 8443 http://127.0.0.1:3004

TLS=(--cacert "$OUT/tls/cert.pem" --resolve daisugi.test:8443:127.0.0.1)
for url in http://127.0.0.1:3005/api/overview http://127.0.0.1:3004/api/config https://daisugi.test:8443/site-config.js; do
  for _ in $(seq 60); do curl -sf "${TLS[@]}" -o /dev/null "$url" && break; sleep 1; done
  curl -sf "${TLS[@]}" -o /dev/null "$url" || { echo "not ready: $url (see $OUT/logs)" >&2; exit 1; }
done
echo "explorer http://127.0.0.1:3005  portal http://127.0.0.1:3004  https://daisugi.test:8443 (via 127.0.0.1:8443)"
