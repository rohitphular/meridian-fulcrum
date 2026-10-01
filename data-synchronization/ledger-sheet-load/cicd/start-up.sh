#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"

cd "$JOB_DIR"

# ── Step 1: Check env, mode and settings (cicd/check.sh, always first) ───────

source "$SCRIPT_DIR/check.sh" "$@"

# ── Step 2: Load secrets ──────────────────────────────────────────────────────

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a
# One log folder per module: py-logging names its folders after the top-level
# package (core, database, ...), which every module shares.
export MERIDIAN_LOG_ROOT="${MERIDIAN_LOG_ROOT:?MERIDIAN_LOG_ROOT must be set in $ENV_FILE}/$(basename "$JOB_DIR")"
export LSL_SCRIPT_URL="$SCRIPT_URL"
export LSL_SPREADSHEET_ID="$SPREADSHEET_ID"

# ── Step 3: Install dependencies, run job ─────────────────────────────────────
# No database: this job only calls the GAS web app, so there are no migrations.
# Credentials are never passed as arguments or environment variables.

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Running ledger-sheet-load job ($MODE_ARG)..."
JOB_ARGS=(--env "$ENV_ARG" --mode "$MODE_ARG")
if [[ $INTERACTIVE -eq 1 ]]; then
  JOB_ARGS+=(--interactive)
else
  # Unattended: the config's confirm value stands in for typing the env name;
  # the PIN (and code, unless --skip-sign-in) arrive on stdin from the pipeline.
  JOB_ARGS+=(--confirm "$CONFIRM_ARG")
  if [[ -n "$SIGN_IN_FLAG" ]]; then JOB_ARGS+=("$SIGN_IN_FLAG"); fi
fi
uv run --locked python -m core.runner "${JOB_ARGS[@]}"
