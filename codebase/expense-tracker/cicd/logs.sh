#!/usr/bin/env bash
# Open the GAS Executions page for the chosen environment in the browser.
#
# Usage:
#   ./logs.sh        — interactive: prompts for env
#   ./logs.sh <env>  — non-interactive
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENVS_FILE="$APP_DIR/cicd/envs.json"

if [[ ! -f "$ENVS_FILE" ]]; then
  echo "ERROR: $ENVS_FILE not found."
  exit 1
fi

# ── Resolve env ───────────────────────────────────────────────────────────────

ENV_ARG="${1:-}"
if [[ -z "$ENV_ARG" ]]; then
  echo ""
  echo "╔══════════════════════════════╗"
  echo "║  Expense Tracker — Logs      ║"
  echo "╚══════════════════════════════╝"
  echo ""
  echo "Select environment:"
  echo ""
  select ENV_ARG in "dev" "prod"; do
    [[ -n "$ENV_ARG" ]] && break
    echo "Invalid selection — try again."
  done
  echo ""
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

# ── Resolve script_id and open executions page ────────────────────────────────

SCRIPT_ID=$(python3 -c "
import json
d = json.load(open('$ENVS_FILE'))['$ENV_ARG']
print(d.get('script_id', 'TODO'))
")

if [[ "$SCRIPT_ID" == "TODO" ]]; then
  echo "ERROR: '$ENV_ARG' script_id is not configured in $ENVS_FILE."
  exit 1
fi

URL="https://script.google.com/home/projects/${SCRIPT_ID}/executions"
echo "Opening executions for: $ENV_ARG"
echo "  $URL"
open "$URL"
