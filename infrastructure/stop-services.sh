#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Stopping PostgreSQL..."
docker compose -f "$SCRIPT_DIR/postgres/docker-compose.yml" down
echo "  PostgreSQL stopped"

echo ""
echo "All services stopped."
