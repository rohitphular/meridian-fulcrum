#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"

cd "$JOB_DIR"

# ── Step 1: Resolve env ───────────────────────────────────────────────────────

ENV_ARG="${1:-}"
MODE_ARG="${2:-}"
if [[ $# -gt 2 ]]; then
  echo "ERROR: Usage: ./cicd/start-up.sh dev|prod [daily|historical]"
  exit 1
fi

if [[ -z "$ENV_ARG" ]]; then
  echo "ERROR: environment argument is required."
  echo "  Usage: ./cicd/start-up.sh dev|prod [daily|historical]"
  exit 1
fi

VALID_ENVS=()
while IFS= read -r line; do
  VALID_ENVS+=("$line")
done < <(python3 - "$ENVS_FILE" <<'PYTHON'
import json
import sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for k in d.keys():
    if not k.startswith('_'):
        print(k)
PYTHON
)

env_is_valid=0
for e in "${VALID_ENVS[@]}"; do
  if [[ "$ENV_ARG" == "$e" ]]; then env_is_valid=1; break; fi
done

if [[ $env_is_valid -eq 0 ]]; then
  echo "ERROR: unknown environment '$ENV_ARG'."
  echo "       cicd/envs.json declares: ${VALID_ENVS[*]}"
  exit 1
fi

# Choose mode before any migrations or writes; explicit mode supports schedulers.
if [[ -z "$MODE_ARG" ]]; then
  echo "  1) Daily — rolling last 365 days"
  echo "  2) Historical — full load from local CSV files"
  # printf, not read -p: bash only shows a read prompt on a terminal, and make pipes stdin.
  printf "Select (1/2): "; CHOICE=""; read -r CHOICE || true
  case "$CHOICE" in
    1) MODE_ARG="daily" ;;
    2) MODE_ARG="historical" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi
case "$MODE_ARG" in
  daily|historical) ;;
  *) echo "ERROR: mode must be daily or historical."; exit 1 ;;
esac

# ── Step 2: Load secrets ──────────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a
# Match core.config's unset-only default for the migration CLI's env interpolation.
export FULCRUM_DB_PORT="${FULCRUM_DB_PORT-5432}"

# ── Step 3: Install dependencies and run migrations ───────────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Validating job configuration..."
uv run --locked python -m core.config "$MODE_ARG"

echo "[$ENV_ARG] Running migrations..."
uv run --locked py-db-migrate run --db postgres

# ── Step 4: Run selected mode ────────────────────────────────────────────────

echo "[$ENV_ARG] Running $MODE_ARG job..."
if [[ "$MODE_ARG" == "daily" ]]; then
  uv run --locked python -m core.runner
else
  uv run --locked python -m core.historical
fi
