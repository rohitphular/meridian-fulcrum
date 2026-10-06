#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
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

# ── Step 3: Install dependencies, run ledger migrations, run job ─────────────────────

echo "[$ENV_ARG] Installing dependencies..."
uv sync --locked --quiet

echo "[$ENV_ARG] Running migrations..."
uv run --locked py-db-migrate run --db postgres

echo "[$ENV_ARG] Running ledger-database-load job ($MODE_ARG)..."
# ${arr[@]+...} keeps an empty array safe under nounset on macOS Bash 3.2.
# exec: a signal sent to this launcher (kill, a scheduler) reaches the job itself.
exec uv run --locked python -m core.runner ${JOB_ARGS[@]+"${JOB_ARGS[@]}"}
