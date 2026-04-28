#!/usr/bin/env bash
set -euo pipefail

# Release every public IPv4/IPv6 attached to the Fly app so that
# `<app>.fly.dev` becomes unreachable. Ingress must go exclusively through
# the cloudflared sidecar (Cloudflare Tunnel -> Cloudflare Access).
#
# Usage:
#   scripts/fly-release-public-ips.sh                # uses app from fly.toml
#   scripts/fly-release-public-ips.sh gh-issue-agent # explicit app name

APP_NAME="${1:-}"
FLY_ARGS=()
if [ -n "$APP_NAME" ]; then
  FLY_ARGS+=(--app "$APP_NAME")
fi

if ! command -v fly >/dev/null 2>&1; then
  echo "fly CLI not found in PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found in PATH (required to parse 'fly ips list --json')" >&2
  exit 1
fi

echo "[release-ips] current public IPs:"
fly ips list "${FLY_ARGS[@]}"

# `fly ips list --json` returns objects with capitalized keys. Only dedicated
# (non-shared) IPs can be released directly; shared v4 is detached automatically
# the next time the app is deployed without [http_service] / [[services]].
mapfile -t addresses < <(
  fly ips list "${FLY_ARGS[@]}" --json \
    | jq -r '.[] | select((.Type == "v4" or .Type == "v6") and (.Region != null and .Region != "")) | .Address'
)

mapfile -t shared_addresses < <(
  fly ips list "${FLY_ARGS[@]}" --json \
    | jq -r '.[] | select(.Type == "v4" and (.Region == null or .Region == "")) | .Address'
)

if [ ${#addresses[@]} -eq 0 ]; then
  echo "[release-ips] no dedicated public IPs to release."
else
  for ip in "${addresses[@]}"; do
    echo "[release-ips] releasing $ip"
    fly ips release "$ip" "${FLY_ARGS[@]}"
  done
fi

if [ ${#shared_addresses[@]} -gt 0 ]; then
  echo
  echo "[release-ips] WARNING: shared IPv4 still attached:"
  printf '             %s\n' "${shared_addresses[@]}"
  echo "             Shared v4 cannot be released directly. It detaches"
  echo "             automatically on the next 'fly deploy' as long as"
  echo "             fly.toml has no [http_service] / [[services]] block."
fi

echo
echo "[release-ips] post-release state:"
fly ips list "${FLY_ARGS[@]}"
echo
echo "[release-ips] verify lockdown with:"
echo "  curl -I --max-time 5 https://<app>.fly.dev/"
echo "An HTTP response (any status) means ingress is still open."
