# Python Job Deployment — Guide

> **Audience**: LLMs and developers running, deploying, or scheduling Python jobs in this codebase.
> **Stack**: Python 3.12+ · `uv` · `py-db-migrate` · `psycopg2`
> **Deployment contract**: `APP-CICD-PATTERNS.md` — read that first for the general deploy pipeline, environment registry, and secret management patterns this guide builds on.

---

## How Python jobs differ from service deploys

Python jobs do not go through the `deploy.sh` pipeline. They run directly — invoked by a scheduler, cron, or manually — and are deployed by pushing code to the target host rather than through a service promotion step.

---

## Installing dependencies

```bash
cd <job-directory>
uv sync          # creates .venv and installs all deps from pyproject.toml
```

Run this once after cloning and whenever `pyproject.toml` changes.

---

## Applying migrations

Run once per environment before the first job run, and again whenever new migration files are added.

```bash
cd <job-directory>
export $(grep -v '^#' .env | xargs)
uv run py-db-migrate run --db postgres
```

`py_db_migrate.toml` at the module root holds the connection config (reads from env vars). See `APP-BE-PYTHON.md` for migration file naming and structure.

---

## Running a job

Load environment variables, then run:

```bash
# Load env vars
set -a && source .env && set +a

# Standard daily run
uv run python runner.py

# Historical / backfill run
uv run python runner.py --backfill 2024-01-01
```

---

## Environment variables

All configuration comes from env vars — never hardcoded. Required vars:

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL connection |
| `MERIDIAN_LOG_ROOT` | Absolute path for log output (required by `py-logging`) |
| Any source-specific API keys | Loaded in `config.py` via `os.environ[...]` |

Store these in a `.env` file (git-ignored) for local runs, and in the environment's secret store for production.

---

## Makefile targets

| Target | What it does |
|---|---|
| `make migrate` | Apply pending migrations for the current env |
| `make run` | Run the job (daily mode) |
| `make backfill DATE=YYYY-MM-DD` | Run in backfill mode from the given date |

---

## Scheduling (production)

Jobs are triggered by an external scheduler (cron, cloud scheduler, etc.). The scheduler command follows the same pattern as a manual run:

```bash
set -a && source /path/to/.env && set +a && cd /path/to/job && uv run python runner.py
```

No deploy script involvement — the scheduler calls the runner directly.
