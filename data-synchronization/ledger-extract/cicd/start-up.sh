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
  echo "  Usage: ./start-up.sh dev|prod"
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

# ── Step 2: Read non-secrets from envs.json ───────────────────────────────────

SPREADSHEET_ID=$(python3 -c "
import json
d = json.load(open('$ENVS_FILE'))['$ENV_ARG']
print(d.get('spreadsheet_id', 'TODO'))
")

if [[ "$SPREADSHEET_ID" == "TODO" ]]; then
  echo "ERROR: '$ENV_ARG' spreadsheet_id is not configured in cicd/envs.json."
  exit 1
fi

export LE_SPREADSHEET_ID="$SPREADSHEET_ID"

# ── Step 3: Load secrets ──────────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a

# ── Step 4: Install dependencies, run migrations, run job ─────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --quiet

echo "[$ENV_ARG] Running migrations..."
uv run py-db-migrate run --db postgres

echo "[$ENV_ARG] Running ledger-extract job..."
uv run python -m core.runner
