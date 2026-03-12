#!/usr/bin/env bash
# Load .env.local and run any openclaw command. Use this so config env vars (e.g. FIXIT_MONGO_URI) are set.
# Examples: ./run-openclaw.sh doctor   ./run-openclaw.sh gateway run --force

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f .env.local ]]; then
  set -a
  source .env.local
  set +a
fi

export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$SCRIPT_DIR/openclaw.json}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$SCRIPT_DIR/.openclaw-local}"

exec pnpm openclaw "$@"
