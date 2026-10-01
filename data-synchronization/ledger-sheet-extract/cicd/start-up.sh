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
  echo "ERROR: Usage: ./cicd/start-up.sh dev|prod [normal-sync|hard-sync]"
  exit 1
fi

if [[ -z "$ENV_ARG" ]]; then
  echo "ERROR: environment argument is required."
  echo "  Usage: ./cicd/start-up.sh dev|prod [normal-sync|hard-sync]"
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
  echo "  1) normal-sync — skip existing in-sync records"
  echo "  2) hard-sync — include in-sync records"
  # printf, not read -p: bash only shows a read prompt on a terminal, and make pipes stdin.
  printf "Select sync mode (1/2): "; CHOICE=""; read -r CHOICE || true
  case "$CHOICE" in
    1) MODE_ARG="normal-sync" ;;
    2) MODE_ARG="hard-sync" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi
JOB_ARGS=()
case "$MODE_ARG" in
  normal-sync) ;;
  hard-sync) JOB_ARGS=(--reprocess) ;;
  *) echo "ERROR: mode must be normal-sync or hard-sync."; exit 1 ;;
esac

# ── Step 2: Read non-secrets from envs.json ───────────────────────────────────

SPREADSHEET_ID=$(python3 - "$ENVS_FILE" "$ENV_ARG" <<'PYTHON'
import json
import sys
with open(sys.argv[1]) as config_file:
    settings = json.load(config_file)[sys.argv[2]]
print(settings.get("spreadsheet_id", "TODO"))
PYTHON
)

if [[ -z "$SPREADSHEET_ID" || "$SPREADSHEET_ID" == "TODO" ]]; then
  echo "ERROR: '$ENV_ARG' spreadsheet_id is not configured in cicd/envs.json."
  exit 1
fi

# ── Step 3: Load secrets ──────────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a
export LE_SPREADSHEET_ID="$SPREADSHEET_ID"

# ── Step 4: Install dependencies, run migrations, run job ─────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Running migrations..."
uv run --locked py-db-migrate run --db postgres

echo "[$ENV_ARG] Running ledger-sheet-extract job ($MODE_ARG)..."
# ${arr[@]+...} keeps an empty array safe under nounset on macOS Bash 3.2.
uv run --locked python -m core.runner ${JOB_ARGS[@]+"${JOB_ARGS[@]}"}
