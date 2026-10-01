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

USAGE="Usage: ./cicd/start-up.sh [--config FILE] [--stage N]
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
  STAGE_SETTINGS="$(python3 "$ROOT/data-synchronization/consolidated-pipeline/cicd/read-stage.py" "${CONFIG_FILE:-$ROOT/data-synchronization/consolidated-pipeline/pipeline.json}" "$(basename "$JOB_DIR")" "$STAGE")" || exit 1
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

# ── Step 2: Env file exists ───────────────────────────────────────────────────

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Check passed: $(basename "$JOB_DIR") $MODE_ARG"
