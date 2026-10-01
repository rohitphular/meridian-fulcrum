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
  echo "ERROR: Usage: ./cicd/start-up.sh dev|prod [sheet-rebuild|sheet-sync]"
  exit 1
fi

if [[ -z "$ENV_ARG" ]]; then
  echo "ERROR: environment argument is required."
  echo "  Usage: ./cicd/start-up.sh dev|prod [sheet-rebuild|sheet-sync]"
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

# Choose mode before anything runs; explicit mode skips the prompt.
if [[ -z "$MODE_ARG" ]]; then
  echo ""
  echo "  1) sheet-rebuild — delete the CSV-backed tabs, recreate and reload them"
  echo "  2) sheet-sync    — keep the tabs; update rows by id and add new ones"
  # printf, not read -p: bash only shows a read prompt on a terminal, and make pipes stdin.
  echo ""
  printf "Select mode (1/2): "; CHOICE=""; read -r CHOICE || true
  echo ""
  case "$CHOICE" in
    1) MODE_ARG="sheet-rebuild" ;;
    2) MODE_ARG="sheet-sync" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi
case "$MODE_ARG" in
  sheet-rebuild|sheet-sync) ;;
  *) echo "ERROR: mode must be sheet-rebuild or sheet-sync."; exit 1 ;;
esac

# ── Step 2: Read non-secrets from envs.json ───────────────────────────────────

SETTINGS=$(python3 - "$ENVS_FILE" "$ENV_ARG" <<'PYTHON'
import json
import sys
with open(sys.argv[1]) as config_file:
    settings = json.load(config_file)[sys.argv[2]]
print(settings.get("script_url", "TODO"))
print(settings.get("spreadsheet_id", "TODO"))
PYTHON
)
SCRIPT_URL="$(sed -n 1p <<< "$SETTINGS")"
SPREADSHEET_ID="$(sed -n 2p <<< "$SETTINGS")"

if [[ -z "$SCRIPT_URL" || "$SCRIPT_URL" == "TODO" || -z "$SPREADSHEET_ID" || "$SPREADSHEET_ID" == "TODO" ]]; then
  echo "ERROR: '$ENV_ARG' script_url and spreadsheet_id must be configured in cicd/envs.json."
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
export LSL_SCRIPT_URL="$SCRIPT_URL"
export LSL_SPREADSHEET_ID="$SPREADSHEET_ID"

# ── Step 4: Install dependencies, run job ─────────────────────────────────────
# No database: this job only calls the GAS web app, so there are no migrations.
# The PIN and authenticator code are asked for by the job, never passed in.

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Running ledger-sheet-load job ($MODE_ARG)..."
uv run --locked python -m core.runner --env "$ENV_ARG" --mode "$MODE_ARG"
