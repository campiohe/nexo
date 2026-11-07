#!/usr/bin/env bash
# Starts LiveKit (Docker) and the Nexo server. Ctrl+C stops the server; LiveKit keeps running
# in the background (stop it with: npm run media:down).
#
#   scripts/dev-up.sh            # server in watch mode (restarts on code changes)
#   scripts/dev-up.sh --prod     # server without watch mode
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$NEXO_ROOT"

mode=dev
[[ "${1:-}" == "--prod" ]] && mode=start

if [[ ! -f "$NEXO_ENV" ]]; then
  echo "${c_err}No .env found.${c_off} Create one first:"
  echo "  cp .env.example .env    # then replace the LiveKit secret (openssl rand -hex 32) in BOTH places"
  exit 1
fi
secret="$(envget LIVEKIT_API_SECRET)"
if [[ -z "$secret" || "$secret" == change-me* ]]; then
  echo "${c_err}LIVEKIT_API_SECRET in .env is still the placeholder.${c_off} Generate one with: openssl rand -hex 32"
  echo "and put it in both LIVEKIT_API_SECRET and LIVEKIT_KEYS (\"<key>: <secret>\")."
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "${c_err}Dependencies are missing.${c_off} Run: npm install"
  exit 1
fi

# Inside WSL LiveKit's auto-detected node IP is useless (10.255.255.254). If .env leaves it empty
# but Tailscale is up, advertise the tailnet IP for this run.
node_ip="$(envget LIVEKIT_NODE_IP)"
ts_ip="$(tailnet_ip)"
if [[ -z "$node_ip" && -n "$ts_ip" ]]; then
  export LIVEKIT_NODE_IP="$ts_ip"
  echo "${c_warn}LIVEKIT_NODE_IP is empty in .env; using the Tailscale IP ${ts_ip} for this run.${c_off}"
  echo "  (Set LIVEKIT_NODE_IP=${ts_ip} in .env to make it permanent.)"
fi

echo "${c_b}Starting LiveKit…${c_off}"
docker compose up -d livekit
lk_port="$(envget LIVEKIT_PORT 7880)"
for _ in $(seq 1 30); do
  curl -fsS -m 1 "http://127.0.0.1:${lk_port}" >/dev/null 2>&1 && break
  sleep 0.5
done
node --env-file=.env scripts/check-livekit.mjs || { echo "See: docker compose logs livekit"; exit 1; }

port="$(envget PORT 3001)"
if curl -fsS -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "${c_warn}A Nexo server is already running on port ${port}.${c_off}"
  scripts/urls.sh
  exit 0
fi

echo
scripts/urls.sh || true
echo
echo "${c_b}Starting the Nexo server (Ctrl+C to stop)…${c_off}"
exec npm run "$mode" -w server
