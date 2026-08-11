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

echo ""
printf "Backfill from date (YYYY-MM-DD) or press Enter to run today: "
read -r BACKFILL_DATE

echo ""
if [ -z "$BACKFILL_DATE" ]; then
    echo "Running daily job..."
    uv run python runner.py
else
    echo "Running backfill from $BACKFILL_DATE..."
    uv run python runner.py --backfill "$BACKFILL_DATE"
fi
