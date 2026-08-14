#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$SCRIPT_DIR"

echo "Loading env vars..."
set -a; source "$ROOT/.env"; set +a

echo "Installing dependencies..."
uv sync --quiet

echo "Running migrations..."
uv run py-db-migrate run --db postgres

echo "Running ledger-extract job..."
uv run python -m core.runner
