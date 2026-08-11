#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting PostgreSQL..."
docker compose -f "$SCRIPT_DIR/postgres/docker-compose.yml" up -d
echo "  Waiting for PostgreSQL to be healthy..."
n=0
until docker inspect --format='{{.State.Health.Status}}' fulcrum-postgres 2>/dev/null | grep -q "healthy"; do
    n=$((n+1)); [ $n -le 30 ] || { echo "  ERROR: PostgreSQL failed to become healthy after 60s"; exit 1; }
    sleep 2
done
echo "  PostgreSQL is healthy"

echo "Setting up DBeaver connections..."
python3 "$SCRIPT_DIR/setup-dbeaver.py" || echo "  WARNING: DBeaver setup failed — add connections manually"

echo ""
echo "All services running."
echo "  PostgreSQL  localhost:5433"
