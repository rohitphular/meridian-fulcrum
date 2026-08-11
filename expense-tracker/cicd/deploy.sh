#!/usr/bin/env bash
# Deploy expense-tracker backend to GAS.
# Pushes .gs source to the GAS draft and promotes it to a new live version.
# Git operations are NOT performed here — commit and push manually.
#
# Usage:
#   ./deploy.sh              — interactive: prompts for env + description
#   ./deploy.sh <env>        — prompts for description only
#   ./deploy.sh <env> <msg>  — fully non-interactive
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENVS_FILE="$APP_DIR/cicd/envs.json"
CLASP_FILE="$APP_DIR/api/.clasp.json"
SCRIPT_ID_PLACEHOLDER='${SCRIPT_ID_PLACEHOLDER}'

if [[ ! -f "$ENVS_FILE" ]]; then
  echo "ERROR: $ENVS_FILE not found."
  exit 1
fi

# ── Step 1: Resolve env ───────────────────────────────────────────────────────

ENV_ARG="${1:-}"

if [[ -z "$ENV_ARG" ]]; then
  echo ""
  echo "╔══════════════════════════════╗"
  echo "║   Expense Tracker Deploy     ║"
  echo "╚══════════════════════════════╝"
  echo ""
  echo "Select environment (mandatory):"
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

# ── Step 2: Resolve description ───────────────────────────────────────────────

MSG="${2:-}"
if [[ -z "$MSG" && -z "${1:-}" ]]; then
  read -rp "Deploy description (leave blank for default): " MSG
  echo ""
fi
MSG="${MSG:-expense-tracker: code pushed}"

# ── Step 3: Resolve IDs from envs.json ───────────────────────────────────────

SCRIPT_ID=$(python3 -c "
import json
d = json.load(open('$ENVS_FILE'))['$ENV_ARG']
print(d.get('script_id', 'TODO'))
")
DEPLOYMENT_ID=$(python3 -c "
import json
d = json.load(open('$ENVS_FILE'))['$ENV_ARG']
print(d.get('deployment_id', 'TODO'))
")

if [[ "$SCRIPT_ID" == "TODO" || "$DEPLOYMENT_ID" == "TODO" ]]; then
  echo "ERROR: '$ENV_ARG' environment is not fully configured in $ENVS_FILE."
  echo "  script_id:     $SCRIPT_ID"
  echo "  deployment_id: $DEPLOYMENT_ID"
  exit 1
fi

echo "Deploying to: $ENV_ARG"
echo "  scriptId:      $SCRIPT_ID"
echo "  deploymentId:  $DEPLOYMENT_ID"
echo ""

# ── Step 4: EXIT trap — always restores .clasp.json placeholder ───────────────

restore_placeholder() {
  python3 - <<PY
import json
p = "$CLASP_FILE"
d = json.load(open(p))
d["scriptId"] = "$SCRIPT_ID_PLACEHOLDER"
with open(p, "w") as f:
    json.dump(d, f, indent=2)
PY
  echo "api/.clasp.json restored to placeholder."
}
trap restore_placeholder EXIT

# ── Step 5: Inject real scriptId ──────────────────────────────────────────────

python3 - <<PY
import json
p = "$CLASP_FILE"
d = json.load(open(p))
d["scriptId"] = "$SCRIPT_ID"
with open(p, "w") as f:
    json.dump(d, f, indent=2)
PY

# ── Step 6: Push and deploy ───────────────────────────────────────────────────

echo "Pushing to GAS draft ($ENV_ARG)..."
cd "$APP_DIR/api"
clasp push --force
echo "Deploying new version on $ENV_ARG..."
clasp deploy --deploymentId "$DEPLOYMENT_ID" --description "$MSG"

echo "✓ Done."
# EXIT trap fires here → api/.clasp.json restored to placeholder.
