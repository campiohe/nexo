# Shared helpers for Nexo scripts (sourced, not executed).
# shellcheck shell=bash

NEXO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEXO_ENV="$NEXO_ROOT/.env"

# envget KEY [default] — read KEY from .env without sourcing it (values may contain spaces).
envget() {
  local key="$1" def="${2:-}" val=""
  if [[ -f "$NEXO_ENV" ]]; then
    val="$(grep -E "^[[:space:]]*${key}=" "$NEXO_ENV" | tail -n1 | sed -E "s/^[[:space:]]*${key}=//; s/[[:space:]]+#.*$//; s/^[\"']//; s/[\"']$//; s/[[:space:]]+$//")"
  fi
  printf '%s' "${val:-$def}"
}

# Tailscale IPv4 of this machine, or empty.
tailnet_ip() {
  command -v tailscale >/dev/null 2>&1 || return 0
  tailscale ip -4 2>/dev/null | head -n1
}

# "iface ip" lines for global-scope IPv4 addresses, skipping docker/bridge/tailscale/loopback.
lan_ips() {
  ip -4 -o addr show scope global 2>/dev/null \
    | awk '{ split($4, a, "/"); print $2, a[1] }' \
    | grep -Ev '^(lo|docker[0-9]*|br-[^ ]*|veth[^ ]*|tailscale[0-9]*|virbr[0-9]*|cni[^ ]*|flannel[^ ]*) ' \
    | grep -Ev ' (10\.255\.255\.254|127\.[0-9.]+)$' || true
}

is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# NODE_IP the running LiveKit container was started with ("" if none / not running).
running_node_ip() {
  local id
  id="$(cd "$NEXO_ROOT" && docker compose ps -q livekit 2>/dev/null | head -n1)"
  [[ -n "$id" ]] || return 0
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null | sed -n 's/^NODE_IP=//p'
}

if [[ -t 1 ]]; then
  c_ok=$'\e[32m' c_warn=$'\e[33m' c_err=$'\e[31m' c_dim=$'\e[2m' c_b=$'\e[1m' c_off=$'\e[0m'
else
  c_ok='' c_warn='' c_err='' c_dim='' c_b='' c_off=''
fi
