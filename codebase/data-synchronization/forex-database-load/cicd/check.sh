#!/usr/bin/env bash
# Checks this module's env, mode and settings without installing, migrating or
# writing anything. Mandatory: start-up.sh always sources it first with the same
# arguments, and the consolidated pipeline runs it for every stage before any
# stage starts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"
# Where the caller ran from: a relative --config path is taken from there.
CALLER_DIR="${CALLER_DIR:-$PWD}"

cd "$JOB_DIR"

# ── Step 1: Resolve env and mode ──────────────────────────────────────────────
# Default: env and mode come from the pipeline config (no prompts), so the
# consolidated-pipeline and schedulers can run the job unattended. --interactive takes them
# as arguments instead and asks for a missing mode.

USAGE="Usage: ./cicd/start-up.sh --config FILE [--stage N]
       ./cicd/start-up.sh --interactive dev|prod [daily|historical]"
usage() { echo "ERROR: $USAGE"; exit 1; }

INTERACTIVE=0
CONFIG_FILE=""
STAGE=""
ENV_ARG=""
MODE_ARG=""
CONFIRM_ARG=""
POSITIONAL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive) INTERACTIVE=1 ;;
    --config) [[ $# -ge 2 ]] || usage; CONFIG_FILE="$2"; shift ;;
    --stage) [[ $# -ge 2 ]] || usage; STAGE="$2"; shift ;;
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
  [[ -z "$CONFIG_FILE" && -z "$STAGE" ]] || usage
  if [[ -z "$ENV_ARG" ]]; then
    echo "ERROR: environment argument is required with --interactive."
    usage
  fi
else
  if [[ $POSITIONAL -gt 0 ]]; then
    echo "ERROR: env and mode come from the pipeline config; pass --interactive to give them as arguments."
    exit 1
  fi
  if [[ -n "$CONFIG_FILE" && "$CONFIG_FILE" != /* ]]; then
    CONFIG_FILE="$CALLER_DIR/$CONFIG_FILE"
  fi
  if [[ -z "$CONFIG_FILE" ]]; then
    echo "ERROR: unattended runs need --config FILE (codebase/data-synchronization/consolidated-pipeline/config/pipeline.<env>.json); pass --interactive to give env and mode as arguments."
    exit 1
  fi
  STAGE_SETTINGS="$(python3 "$ROOT/codebase/data-synchronization/consolidated-pipeline/cicd/read-stage.py" "$CONFIG_FILE" "$(basename "$JOB_DIR")" "$STAGE")" || exit 1
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

# Checked first: under bash 3.2 (macOS) with set -u an empty array is "unbound".
if [[ ${#VALID_ENVS[@]} -eq 0 ]]; then
  echo "ERROR: cicd/envs.json declares no environments."
  exit 1
fi

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
  echo "  3) Publish to Sheet — latest rates to the app's rates tab"
  # printf, not read -p: bash only shows a read prompt on a terminal, and make pipes stdin.
  printf "Select (1/2/3): "; CHOICE=""; read -r CHOICE || true
  case "$CHOICE" in
    1) MODE_ARG="daily" ;;
    2) MODE_ARG="historical" ;;
    3) MODE_ARG="publish-sheet" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi
case "$MODE_ARG" in
  daily|historical|publish-sheet) ;;
  *) echo "ERROR: mode must be daily, historical or publish-sheet."; exit 1 ;;
esac

# ── Step 2: Env file exists ───────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

# publish-sheet writes the app's rates tab: it needs the environment's spreadsheet
# (cicd/envs.json) and a service-account key path in the env file.
SPREADSHEET_ID=""
if [[ "$MODE_ARG" == "publish-sheet" ]]; then
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
  if ! grep -Eq '^FDL_SERVICE_ACCOUNT_FILE=.+' "$ENV_FILE"; then
    echo "ERROR: FDL_SERVICE_ACCOUNT_FILE is not set in $ENV_FILE (path to the service-account JSON key shared with the spreadsheet as Editor)."
    exit 1
  fi
fi

echo "[$ENV_ARG] Check passed: $(basename "$JOB_DIR") $MODE_ARG"
