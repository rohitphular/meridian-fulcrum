#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENVS_FILE="$SCRIPT_DIR/envs.json"
# Where the caller ran from: a relative --config path is taken from there.
CALLER_DIR="${CALLER_DIR:-$PWD}"

cd "$JOB_DIR"

# ── Step 1: Check env, mode and settings (cicd/check.sh, always first) ───────

source "$SCRIPT_DIR/check.sh" "$@"

# ── Step 2: Load secrets ──────────────────────────────────────────────────────

echo "[$ENV_ARG] Loading env vars..."
set -a; source "$ENV_FILE"; set +a
# This module never signs in to the GAS backend: keep the stored PIN and secret out of it.
unset MERIDIAN_FULCRUM_PIN MERIDIAN_FULCRUM_SECRET
# One log folder per module: py-logging names its folders after the top-level
# package (core, database, ...), which every module shares.
export MERIDIAN_LOG_ROOT="${MERIDIAN_LOG_ROOT:?MERIDIAN_LOG_ROOT must be set in $ENV_FILE}/$(basename "$JOB_DIR")"
# Match core.config's unset-only default for the migration CLI's env interpolation.
export FULCRUM_DB_PORT="${FULCRUM_DB_PORT-5432}"

# ── Step 3: Install dependencies and run migrations ───────────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Validating job configuration..."
uv run --locked python -m core.config "$MODE_ARG"

echo "[$ENV_ARG] Running migrations..."
uv run --locked py-db-migrate run --db postgres

# ── Step 4: Run selected mode ────────────────────────────────────────────────

echo "[$ENV_ARG] Running $MODE_ARG job..."
if [[ "$MODE_ARG" == "daily" ]]; then
  # exec: a signal sent to this launcher (kill, a scheduler) reaches the job itself.
  exec uv run --locked python -m core.runner
else
  exec uv run --locked python -m core.historical
fi
