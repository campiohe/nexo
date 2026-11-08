#!/usr/bin/env bash
# Prints the Nexo server URL(s) friends (and you) should enter, and checks LiveKit's node IP.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

port="$(envget PORT 3001)"
lk_port="$(envget LIVEKIT_PORT 7880)"
node_ip="$(envget LIVEKIT_NODE_IP)"
public_url="$(envget LIVEKIT_PUBLIC_URL)"
ts_ip="$(tailnet_ip)"
mapfile -t lans < <(lan_ips)

echo "${c_b}Nexo server URLs${c_off}"
if [[ -n "$ts_ip" ]]; then
  echo "  Friends (Tailscale):   ${c_ok}http://${ts_ip}:${port}${c_off}"
else
  echo "  Friends (Tailscale):   ${c_warn}not available${c_off} — Tailscale is not installed/logged in here (see docs/SERVER.md → Tailscale)"
fi
for line in "${lans[@]}"; do
  iface="${line%% *}"; addr="${line#* }"
  if is_wsl; then
    echo "  This PC (Windows app): http://${addr}:${port}  ${c_dim}(WSL ${iface}; reachable from this Windows PC only)${c_off}"
  else
    echo "  Same network (LAN):    http://${addr}:${port}  ${c_dim}(${iface})${c_off}"
  fi
done
echo "  This machine:          http://localhost:${port}"
echo

echo "${c_b}Status${c_off}"
if curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "  Nexo server:  ${c_ok}running${c_off} on port ${port}"
else
  echo "  Nexo server:  ${c_warn}not running${c_off} (start it with: npm run server)"
fi
lk_running=0
if curl -fsS -m 2 "http://127.0.0.1:${lk_port}" >/dev/null 2>&1; then
  lk_running=1
  echo "  LiveKit:      ${c_ok}running${c_off} on port ${lk_port}"
else
  echo "  LiveKit:      ${c_warn}not running${c_off} (start it with: npm run media)"
fi
if [[ -n "$public_url" ]]; then
  echo "  LiveKit URL:  ${public_url} ${c_dim}(LIVEKIT_PUBLIC_URL)${c_off}"
else
  echo "  LiveKit URL:  ws://<the host the client used>:${lk_port} ${c_dim}(derived automatically)${c_off}"
fi
echo "  Node IP:      ${node_ip:-<auto>} ${c_dim}(LIVEKIT_NODE_IP in .env)${c_off}"

hint=0
if [[ -n "$ts_ip" && "$node_ip" != "$ts_ip" ]]; then
  hint=1
  echo
  echo "${c_warn}! LIVEKIT_NODE_IP (${node_ip:-empty}) does not match this machine's Tailscale IP (${ts_ip}).${c_off}"
  echo "  Friends may connect to chat but not to voice/video. Fix:"
  echo "    1. In .env set:  LIVEKIT_NODE_IP=${ts_ip}"
  echo "    2. Restart LiveKit:  npm run media"
elif [[ -z "$ts_ip" && -n "$node_ip" ]]; then
  if ! ip -4 -o addr show 2>/dev/null | grep -q " ${node_ip}/"; then
    hint=1
    echo
    echo "${c_warn}! LIVEKIT_NODE_IP=${node_ip} is not an address of this machine.${c_off} Is Tailscale down? (tailscale status)"
  fi
fi
if (( lk_running )) && command -v docker >/dev/null 2>&1; then
  running="$(running_node_ip || true)"
  if [[ "$running" != "$node_ip" ]]; then
    hint=1
    echo
    echo "${c_warn}! LiveKit is running with node IP '${running:-<auto>}' but .env says '${node_ip:-<auto>}'.${c_off} Restart it: npm run media"
  fi
fi
(( hint )) || true
