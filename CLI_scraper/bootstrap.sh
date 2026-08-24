#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")" && pwd)
exec node "$PROJECT_ROOT/scripts/bootstrap.js" "$@"
