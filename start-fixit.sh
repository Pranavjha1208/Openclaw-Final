#!/bin/bash
# Start OpenClaw gateway with Fixit-only config (loads .env.local and runs gateway).
# For other commands (e.g. doctor): ./run-openclaw.sh doctor

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/run-openclaw.sh" gateway run --force "$@"
