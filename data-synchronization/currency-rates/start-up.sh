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
echo "  1) Daily   — rolling last 365 days"
echo "  2) Historical — full load from start_date in config.yaml"
echo ""
printf "Select (1/2): "
read -r CHOICE
echo ""

case "$CHOICE" in
    1)
        echo "Running daily job..."
        uv run python -m core.runner
        ;;
    2)
        echo "Running historical load..."
        uv run python -m core.historical
        ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac
