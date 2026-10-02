#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

USAGE="Usage: ./cicd/start-up.sh [--env NAME | --config FILE]"
usage() { echo "ERROR: $USAGE"; exit 1; }

# ── Step 1: Choose the config ─────────────────────────────────────────────────
# One file per environment: config/pipeline.<env>.json. Without --env or
# --config, the environments are listed from the files there and one is asked for.

CONFIG_DIR="$JOB_DIR/config"
CONFIG_FILE=""
ENV_CHOICE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) [[ $# -ge 2 && -z "$ENV_CHOICE" ]] || usage; CONFIG_FILE="$2"; shift ;;
    --env) [[ $# -ge 2 && -z "$CONFIG_FILE" ]] || usage; ENV_CHOICE="$2"; shift ;;
    "") ;;
    *) usage ;;
  esac
  shift
done

# Relative paths are taken from the caller's directory, before changing into the module.
if [[ -n "$CONFIG_FILE" && -f "$CONFIG_FILE" ]]; then
  CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" && pwd)/$(basename "$CONFIG_FILE")"
fi

cd "$JOB_DIR"

if [[ -z "$CONFIG_FILE" ]]; then
  ENVS=()
  while IFS= read -r line; do
    ENVS+=("$line")
  done < <(python3 cicd/read-stage.py --list-envs "$CONFIG_DIR")
  if [[ ${#ENVS[@]} -eq 0 ]]; then
    echo "ERROR: no config/pipeline.<env>.json files; copy config/pipeline.example.json to config/pipeline.dev.json and edit it."
    exit 1
  fi
  if [[ -z "$ENV_CHOICE" ]]; then
    echo ""
    i=1
    for env in "${ENVS[@]}"; do
      echo "  $i) $env"
      i=$((i + 1))
    done
    echo ""
    # printf, not read -p: bash only shows a read prompt on a terminal, and make pipes stdin.
    printf "Select environment: "; CHOICE=""; read -r CHOICE || true
    if [[ "$CHOICE" =~ ^[0-9]+$ && "$CHOICE" -ge 1 && "$CHOICE" -le ${#ENVS[@]} ]]; then
      ENV_CHOICE="${ENVS[$((CHOICE - 1))]}"
    else
      echo "Invalid choice '$CHOICE'."
      exit 1
    fi
  fi
  CONFIG_FILE="$CONFIG_DIR/pipeline.$ENV_CHOICE.json"
fi

SETTINGS="$(python3 cicd/read-stage.py "$CONFIG_FILE" --env)" || exit 1
ENV_ARG="$(sed -n 's/^env=//p' <<< "$SETTINGS")"

# ── Step 2: Load the log root ─────────────────────────────────────────────────
# Each stage's launcher loads its own env file and validates its own settings.

ENV_FILE="$ROOT/infrastructure/.env.$ENV_ARG"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE"
  exit 1
fi

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a
export MERIDIAN_LOG_ROOT="${MERIDIAN_LOG_ROOT:?MERIDIAN_LOG_ROOT must be set in $ENV_FILE}/$(basename "$JOB_DIR")"

# ── Step 3: Install dependencies, run the pipeline ────────────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Running pipeline ($CONFIG_FILE)..."
uv run --locked python -m core.runner --config "$CONFIG_FILE"
