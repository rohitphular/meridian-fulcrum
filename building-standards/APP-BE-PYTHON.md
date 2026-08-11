# Forge Backend — Python Job Guide

> **Audience**: LLMs and developers writing or modifying Forge Python jobs.
> **Stack**: Python 3.12+ · `uv` · `py-logging` · `py-db-migrate` · `psycopg2` · `gspread`

---

## Two kinds of Python jobs

| Kind | Location | Reads from | Writes to | Auth |
|---|---|---|---|---|
| **Sheets jobs** | `expense-tracker/job/` | Google Sheets (gspread) | Google Sheets (computed_ tabs) | GCP service account |
| **Data-sync jobs** | `data-synchronization/<job>/job/` | External APIs / Google Sheets | PostgreSQL (`fulcrum_db`) | DB env vars + API keys |

Both kinds share the same structural rules: `runner.py` entry point, thin `run()` method, private `_compute` methods, `py-logging` for all log output.

---

## Dependency management — always use uv

Every Python job has a `pyproject.toml`. Never use `requirements.txt` for new jobs.

```toml
[project]
name = "my-job"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "requests>=2.32",
    "py-logging",
    "py-db-migrate",
]

[tool.uv]
package = false

[tool.uv.sources]
py-logging    = { git = "git+ssh://git@github.com/rohitphular/meridian-common-libs.git", subdirectory = "py-logging" }
py-db-migrate = { git = "git+ssh://git@github.com/rohitphular/meridian-common-libs.git", subdirectory = "py-db-migrate" }
```

Install / sync:
```bash
cd <job>/
uv sync          # creates .venv and installs all deps
uv run python runner.py
```

---

## Shared libraries — meridian-common-libs

Two libraries are mandatory in all new Python jobs. Both are consumed via uv git sources from `git+ssh://git@github.com/rohitphular/meridian-common-libs.git`.

### `py-logging`

Structured logger. Always use it — never use `print()`, `logging.basicConfig()`, or bare `logging.getLogger()`.

```python
from py_logging import get_logger
logger = get_logger(__name__)
```

Requires `MERIDIAN_LOG_ROOT` env var set to the absolute path of the logs directory. Raises `EnvironmentError` at import time if not set — do not suppress this.

Log format: `[YYYY-MM-DD HH:MM:SS UTC] [LEVEL] [module.path] message`

Log files: `$MERIDIAN_LOG_ROOT/{top_module}/{top_module}.log` — daily rotation, previous day deleted.

### `py-db-migrate`

Schema migration runner. Used for all PostgreSQL DDL — never run `CREATE TABLE` ad-hoc.

```python
from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client, ensure_schema_migration_table

config = ConnectionConfig(host=..., port=..., user=..., password=..., connect_database=...)
client = get_client(config)
```

Migration files live in `job/migrations/`. Naming: `NNNN_description.py` — four-digit zero-padded sequence, `snake_case` description.

```python
# migrations/0001_create_currency_master.py
def upgrade(client) -> None:
    with client.cursor() as cursor:
        cursor.execute("CREATE TABLE IF NOT EXISTS ...")
    client.commit()
```

---

## Sheets jobs — `expense-tracker/job/`

### Folder structure

```
expense-tracker/job/
  runner.py              ← entry point — discovers and runs jobs
  config.py              ← loads envs.json + resolves service account path
  sheets_client.py       ← thin gspread wrapper (read_sheet / write_sheet)
  requirements.txt       ← legacy; existing jobs only — new jobs use pyproject.toml
  jobs/
    __init__.py          ← ALL_JOBS registry
    base.py              ← BaseJob abstract class
    kpi_summary.py
    insights/
      job.py             ← InsightsJob
      ...
```

### Running

```bash
cd expense-tracker/job
python runner.py --env dev              # all jobs against dev sheet
python runner.py --env prod             # all jobs against prod sheet
python runner.py --env dev --job kpi_summary   # single job by name
```

Or via Makefile from the repo root:
```bash
make job-start   # interactive env selector
```

### Config and credentials

`config.py` reads two files:

| File | Location | Purpose |
|---|---|---|
| `envs.json` | `expense-tracker/cicd/envs.json` | Spreadsheet IDs per env (dev/prod) |
| Service account | `local/configs/gcp_service_account.json` | GCP credentials — **never commit** |

`local/` is gitignored at the repo root.

### Input sheets (read-only)

Never write to input sheets. They are owned by GAS.

| Sheet name | Contents |
|---|---|
| `transactions` | All transaction rows |
| `accounts` | Account definitions and balances |
| `categories` | Category tree |
| `rates` | Currency → GBP rate map |
| `subscriptions` | Subscription definitions |

### Output sheets (written by jobs)

Convention: `computed_<job_name>`.

- Row 1: column headers
- Row 2+: data rows
- First column: always `computed_at` (ISO 8601 UTC timestamp)
- Jobs clear and rewrite the full sheet on every run — no incremental updates

### SheetsClient

`sheets_client.py` wraps gspread. Use only these two methods in job files — do not import gspread directly.

#### `read_sheet(name: str) -> list[dict]`

Returns all data rows as dicts keyed by header. Returns `[]` if sheet doesn't exist. All values are strings (`numericise_ignore=['all']`) — cast in the job.

#### `write_sheet(name: str, headers: list[str], rows: list[list]) -> None`

Creates the sheet if missing. Clears and rewrites fully on every call.

### Adding a Sheets job

1. Create `jobs/<job_name>.py` — inherit `BaseJob`, set `name` and `description`, implement `run()`.
2. Register in `jobs/__init__.py`.

```python
from datetime import datetime, timezone
from jobs.base import BaseJob
from py_logging import get_logger

logger = get_logger(__name__)


class MyNewJob(BaseJob):
    name        = 'my_new_job'
    description = 'One-line description'

    OUTPUT_SHEET   = 'computed_my_new_job'
    OUTPUT_HEADERS = ['computed_at', 'col_a', 'col_b']

    def run(self) -> None:
        txs    = self.sheets.read_sheet(self.config['sheets']['transactions'])
        logger.info(f"my_new_job: input_rows={len(txs)}")
        result = self._compute(txs)
        now    = datetime.now(timezone.utc).isoformat()
        rows   = [[now, r['col_a'], r['col_b']] for r in result]
        self.sheets.write_sheet(self.OUTPUT_SHEET, self.OUTPUT_HEADERS, rows)
        logger.info(f"my_new_job: output_rows={len(rows)}")

    def _compute(self, txs: list[dict]) -> list[dict]:
        # Pure computation — no sheet I/O
        ...
```

---

## Data-sync jobs — `data-synchronization/<job>/job/`

### Folder structure

```
data-synchronization/<job>/
  _tasks/              ← design docs for this job
  pyproject.toml       ← uv deps (always — no requirements.txt)
  py_db_migrate.toml   ← migration CLI config
  runner.py            ← entry point; --backfill flag for historical runs
  config.py            ← DB config + API keys from env vars
  fetcher.py           ← <JobName>Job class
  sources/             ← one file per external data source, named after the source
    <source>.py
  database/
    upsert.py          ← PostgreSQL upsert helpers
  migrations/
    0001_<name>.py
    0002_<name>.py
```

No `__init__.py` files anywhere. Python 3.3+ namespace packages handle directory imports without them. Never add `__init__.py` as a way to make a directory importable — import explicitly by module path instead.

### Config from env vars

All configuration reads from environment variables — no hardcoded values. The `fulcrum/.env` file is the source; load it before running.

```python
# config.py
import os
from py_db_migrate.core.config import ConnectionConfig

def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["CR_DB_HOST"],
        port=int(os.environ.get("CR_DB_PORT", "5432")),
        user=os.environ["CR_DB_USER"],
        password=os.environ["CR_DB_PASSWORD"],
        connect_database=os.environ["CR_DB_NAME"],
    )
```

Raise `EnvironmentError` immediately if a required variable is absent — never silently fall back.

### Running migrations

`py_db_migrate.toml` at the job root holds the connection config (reads from env vars). Apply all pending migrations with:

```bash
cd data-synchronization/<job>
export $(grep -v '^#' ../../.env | xargs)
uv run py-db-migrate run --db postgres
```

### Runner pattern

```python
# runner.py
import argparse
from datetime import date
from py_logging import get_logger
import config
from fetcher import MyJob

logger = get_logger(__name__)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--backfill', metavar='YYYY-MM-DD')
    args = parser.parse_args()
    job = MyJob(config.db_config())
    if args.backfill:
        logger.info(f"runner: mode=backfill from_date={args.backfill}")
        job.backfill(date.fromisoformat(args.backfill))
    else:
        logger.info("runner: mode=daily")
        job.run()

if __name__ == '__main__':
    main()
```

### Job class pattern

```python
# fetcher.py
import sources.frankfurter as frankfurter   # explicit module import — no __init__.py
import sources.coingecko as coingecko
from database.upsert import upsert_rates
from py_db_migrate.core.config import ConnectionConfig
from py_db_migrate.adapters.postgres import get_client
from py_logging import get_logger

logger = get_logger(__name__)


class MyJob:
    def __init__(self, db: ConnectionConfig) -> None:
        self._db = db

    def run(self) -> None:
        client = get_client(self._db)
        try:
            data = self._fetch()
            self._upsert(client, data)
            logger.info(f"job: rows={len(data)}")
        finally:
            client.close()

    def backfill(self, from_date) -> None:
        client = get_client(self._db)
        try:
            ...
        finally:
            client.close()

    def _fetch(self): ...
    def _upsert(self, client, data): ...
```

Always close the client in a `finally` block. Use `upsert` patterns with `ON CONFLICT` — never truncate-and-reload PostgreSQL tables.

---

## Coding rules — all Python jobs

### Data handling

- Sheet values are always strings — cast explicitly: `float(row['amount'])`, `int(row['count'])`.
- Missing or empty values: always `row.get('field') or default`.
- Dates from sheets: `datetime.fromisoformat(row['date_field'])`.
- PostgreSQL `NUMERIC` values come back as `Decimal` — convert to `float` only at display time, not in computation.

### Currency / amounts

- All monetary totals must convert to the quote currency (GBP default).
- Use `tx['fx_rate']` (the rate recorded on the transaction) for historical conversion — never live rates.
- Transactions without a matching rate: exclude from totals and log the skip with `logger.warn`.

### Logging

Use `py-logging` exclusively. Format: `fnname: key=value key=value`.

```python
logger.info(f"run: input_rows={len(txs)} date={today}")
logger.warning(f"run: skipped_rows={skipped} reason=missing_rate")
logger.error(f"run: {e}")
```

Log at the start of `run()` with input counts, at the end with output counts. Never log:
- Raw transaction data or account names
- Balances, PINs, API keys, or session objects
- Any value from `.env` that is a secret

### Keep `run()` thin

`run()` orchestrates: read → compute → write. All computation lives in private `_methods` — pure functions with no I/O. This makes jobs testable without a real Sheets or DB connection.

### No side effects on input data

Never write to `transactions`, `accounts`, `categories`, `rates`, or `subscriptions` sheets. If a job needs to update a GAS-owned entity, raise it as a design question — it likely belongs in a GAS action instead.

### Error handling

Jobs catch all exceptions, log them, and exit with code 1. The runner should not suppress exceptions mid-job — let them bubble to the runner's top-level handler.

```python
# In runner.py
try:
    job.run()
except Exception as e:
    logger.error(f"runner: job_failed error={e}")
    sys.exit(1)
```

---

## GAS integration — `getComputedData` action

The GAS router exposes `getComputedData` — reads any `computed_*` sheet and returns rows as JSON. The frontend calls this for computed results instead of computing locally.

```
GET /exec?action=getComputedData&sheet=computed_kpi_summary&pin=...
→ { ok: true, data: [{ computed_at: '...', ... }] }
```

GAS does no computation here — it reads and returns verbatim.

---

## Common pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| `print()` instead of `logger` | Logs go nowhere useful; no timestamps; no rotation | Always use `from py_logging import get_logger` |
| `MERIDIAN_LOG_ROOT` not set | `EnvironmentError` at import | Set the env var before running; never catch and suppress |
| Not casting sheet string values | `'42.50' + 10 = '42.5010'` | Always cast: `float(row['amount'])` |
| Using live rates for historical amounts | Amounts change retroactively | Use `tx['fx_rate']` from the transaction row |
| Writing to input sheets | GAS data gets corrupted | Only write to `computed_*` sheets or PostgreSQL |
| Putting computation in `run()` | Untestable | Private `_methods` for all computation |
| No `computed_at` column | Can't tell when data was last refreshed | Always include it as the first column |
| Hardcoding DB credentials | Secrets in git | Always read from env vars; raise `EnvironmentError` if absent |
| No `finally` on DB connection | Connection leak under exceptions | Always `try/finally: client.close()` |
| `requirements.txt` in a new job | Bypasses uv | New jobs always use `pyproject.toml` with uv sources |
