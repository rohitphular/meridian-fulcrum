#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"

cd "$JOB_DIR"

# ── Step 1: Resolve env ───────────────────────────────────────────────────────

ENV_ARG="${1:-}"

if [[ -z "$ENV_ARG" ]]; then
  echo "ERROR: environment argument is required."
  echo "  Usage: ./cicd/start-up.sh dev|prod"
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
  echo "       cicd/envs.json declares: ${VALID_ENVS[*]}"
  exit 1
fi

# ── Step 2: Load secrets ──────────────────────────────────────────────────────

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ROOT/.env"; set +a

# ── Step 3: Install dependencies and run migrations ───────────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --upgrade --quiet

echo "[$ENV_ARG] Running migrations..."
uv run py-db-migrate run --db postgres

# ── Step 4: Select and run mode ───────────────────────────────────────────────

echo ""
echo "  1) Daily   — rolling last 365 days"
echo "  2) Historical — full load from local CSV files"
echo ""
printf "Select (1/2): "
read -r CHOICE
echo ""

case "$CHOICE" in
    1)
        echo "[$ENV_ARG] Running daily job..."
        uv run python -m core.runner
        ;;
    2)
        echo "[$ENV_ARG] Running historical load..."
        uv run python -m core.historical
        ;;
    *)
        echo "Invalid choice. Exiting."
        exit 1
        ;;
esac
