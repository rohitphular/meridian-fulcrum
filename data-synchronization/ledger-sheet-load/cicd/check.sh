#!/usr/bin/env bash
# Checks this module's env, mode and settings without installing, migrating or
# writing anything. Mandatory: start-up.sh always sources it first with the same
# arguments, and the consolidated pipeline runs it for every stage before any
# stage starts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"

cd "$JOB_DIR"

# ── Step 1: Resolve env and mode ──────────────────────────────────────────────
# Default: env and mode come from the pipeline config (no prompts), so the
# consolidated-pipeline and schedulers can run the job unattended. --interactive takes them
# as arguments instead and asks for a missing mode.

USAGE="Usage: ./cicd/start-up.sh --config FILE [--stage N] [--sign-in-only|--skip-sign-in]
       ./cicd/start-up.sh --interactive dev|prod [sheet-rebuild|sheet-sync]"
usage() { echo "ERROR: $USAGE"; exit 1; }

INTERACTIVE=0
CONFIG_FILE=""
STAGE=""
ENV_ARG=""
MODE_ARG=""
CONFIRM_ARG=""
POSITIONAL=0
SIGN_IN_FLAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive) INTERACTIVE=1 ;;
    --config) [[ $# -ge 2 ]] || usage; CONFIG_FILE="$2"; shift ;;
    --stage) [[ $# -ge 2 ]] || usage; STAGE="$2"; shift ;;
    --sign-in-only|--skip-sign-in) [[ -z "$SIGN_IN_FLAG" ]] || usage; SIGN_IN_FLAG="$1" ;;
    -*) usage ;;
    *)
      POSITIONAL=$((POSITIONAL + 1))
      case "$POSITIONAL" in
        1) ENV_ARG="$1" ;;
        2) MODE_ARG="$1" ;;
        *) usage ;;
      esac ;;
  esac
  shift
done

if [[ $INTERACTIVE -eq 1 ]]; then
  [[ -z "$CONFIG_FILE" && -z "$STAGE" && -z "$SIGN_IN_FLAG" ]] || usage
  if [[ -z "$ENV_ARG" ]]; then
    echo "ERROR: environment argument is required with --interactive."
    usage
  fi
else
  if [[ $POSITIONAL -gt 0 ]]; then
    echo "ERROR: env and mode come from the pipeline config; pass --interactive to give them as arguments."
    exit 1
  fi
  if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: unattended runs need --config FILE (data-synchronization/consolidated-pipeline/config/pipeline.<env>.json); pass --interactive to give env and mode as arguments."
    exit 1
  fi
  STAGE_SETTINGS="$(python3 "$ROOT/data-synchronization/consolidated-pipeline/cicd/read-stage.py" "$CONFIG_FILE" "$(basename "$JOB_DIR")" "$STAGE")" || exit 1
  ENV_ARG="$(sed -n 's/^env=//p' <<< "$STAGE_SETTINGS")"
  MODE_ARG="$(sed -n 's/^mode=//p' <<< "$STAGE_SETTINGS")"
  CONFIRM_ARG="$(sed -n 's/^confirm=//p' <<< "$STAGE_SETTINGS")"
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

# ── Step 3: Env file exists ───────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Check passed: $(basename "$JOB_DIR") $MODE_ARG"
# Run directly (by the pipeline): tell it to collect the PIN and authenticator code.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "credentials=gas-pin-totp"
fi
