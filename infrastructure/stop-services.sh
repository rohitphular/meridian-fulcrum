#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"

# ── Step 1: Resolve env ───────────────────────────────────────────────────────

ENV_ARG="${1:-}"

if [[ -z "$ENV_ARG" ]]; then
  echo "ERROR: environment argument is required."
  echo "  Usage: ./stop-services.sh dev|prod"
  exit 1
fi

VALID_ENVS=()
while IFS= read -r line; do
  VALID_ENVS+=("$line")
done < <(python3 -c "
import json
with open('$ENVS_FILE') as f:
    d = json.load(f)
for k in d.keys():
    if not k.startswith('_'):
        print(k)
")

env_is_valid=0
for e in "${VALID_ENVS[@]}"; do
  if [[ "$ENV_ARG" == "$e" ]]; then env_is_valid=1; break; fi
done

if [[ $env_is_valid -eq 0 ]]; then
  echo "ERROR: unknown environment '$ENV_ARG'."
  echo "       envs.json declares: ${VALID_ENVS[*]}"
  exit 1
fi

# ── Step 2: Read config from envs.json ───────────────────────────────────────

read -r POSTGRES_PORT POSTGRES_USER POSTGRES_DB CONTAINER_NAME VOLUME_PATH NETWORK_NAME < <(python3 -c "
import json
d = json.load(open('$ENVS_FILE'))['$ENV_ARG']
print(d['postgres_port'], d['postgres_user'], d['postgres_db'], d['container_name'], d['volume_path'], d['network_name'])
")

# ── Step 3: Export vars for docker-compose interpolation ─────────────────────

export FULCRUM_ENV="$ENV_ARG"
export FULCRUM_CONTAINER_NAME="$CONTAINER_NAME"
export FULCRUM_POSTGRES_PORT="$POSTGRES_PORT"
export FULCRUM_POSTGRES_USER="$POSTGRES_USER"
export FULCRUM_POSTGRES_DB="$POSTGRES_DB"
export FULCRUM_VOLUME_PATH="$VOLUME_PATH"
export FULCRUM_NETWORK_NAME="$NETWORK_NAME"

# ── Step 4: Stop PostgreSQL and remove network ────────────────────────────────

echo "[$ENV_ARG] Stopping PostgreSQL..."
docker compose -f "$SCRIPT_DIR/postgres/docker-compose.yml" down
echo "  PostgreSQL stopped."

echo "[$ENV_ARG] Removing network '$NETWORK_NAME'..."
docker network rm "$NETWORK_NAME" 2>/dev/null || echo "  Network '$NETWORK_NAME' not found or already removed."

echo ""
echo "[$ENV_ARG] All services stopped."
