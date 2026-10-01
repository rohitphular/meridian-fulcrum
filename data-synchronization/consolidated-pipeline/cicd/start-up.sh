#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

USAGE="Usage: ./cicd/start-up.sh [--config FILE]"
usage() { echo "ERROR: $USAGE"; exit 1; }

# ── Step 1: Resolve the config ────────────────────────────────────────────────
# Relative paths are taken from the caller's directory, before changing into the module.

CONFIG_FILE="$JOB_DIR/pipeline.json"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) [[ $# -ge 2 ]] || usage; CONFIG_FILE="$2"; shift ;;
    *) usage ;;
  esac
  shift
done
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" && pwd)/$(basename "$CONFIG_FILE")"
fi

cd "$JOB_DIR"

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
