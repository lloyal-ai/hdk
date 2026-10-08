#!/usr/bin/env bash
# Compatibility entry point. Synchronizes both the Developer Grant and FAQ.
# See scripts/LICENSING.md for local and cross-repository workflows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/sync-licensing.mjs" "$@"
