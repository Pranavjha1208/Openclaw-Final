#!/usr/bin/env bash
# Forward the OpenClaw gateway port with ngrok. Run this after the gateway is already
# running (e.g. ./start-fixit.sh). No app code or config changes — gateway stays on
# the same port; ngrok exposes it publicly.
#
# Usage: ./start-ngrok.sh [port] [ngrok-dev-domain]
#   port defaults to 18789 (or OPENCLAW_GATEWAY_PORT if set).
#   ngrok-dev-domain: use your reserved dev domain (e.g. overfraught-uncultivable-colt.ngrok-free.dev)
#     so the tunnel uses a stable URL. Optional; omit for a random URL.
#
# Example: ./start-ngrok.sh 18789 overfraught-uncultivable-colt.ngrok-free.dev

set -e
PORT="${1:-${OPENCLAW_GATEWAY_PORT:-18789}}"
NGROK_URL="${2:-${NGROK_DEV_DOMAIN:-}}"
if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok not found. Install it: https://ngrok.com/download"
  exit 1
fi
if [[ -n "$NGROK_URL" ]]; then
  exec ngrok http --url="$NGROK_URL" "$PORT"
else
  exec ngrok http "$PORT"
fi
