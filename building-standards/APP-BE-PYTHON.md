# Python Module Guide

> **Audience**: LLMs and developers writing Python modules and jobs in this codebase.
> **Stack**: Python 3.12+ · `uv` · `py-logging` · `py-db-migrate` · `psycopg2`
> **Architecture contract**: `APP-BE-PATTERNS.md` — read that first for the language-agnostic module structure, domain quartet, CRUD rules, and validation ordering this guide implements in Python.

---

## Dependency management — always use uv

Every Python module has a `pyproject.toml`. Never use `requirements.txt` for new modules.

```toml
[project]
name = "my-module"
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
cd <module>/
uv sync          # creates .venv and installs all deps
uv run python runner.py
```

---

## Shared libraries — meridian-common-libs

Two libraries are mandatory in all new Python modules. Both are consumed via uv git sources from `git+ssh://git@github.com/rohitphular/meridian-common-libs.git`.

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

Migration files live in `migrations/`. Naming: `NNNN_description.py` — four-digit zero-padded sequence, `snake_case` description.

```python
# migrations/0001_create_records.py
def upgrade(client) -> None:
    with client.cursor() as cursor:
        cursor.execute("CREATE TABLE IF NOT EXISTS ...")
    client.commit()
```

---

## Python job — folder structure

```
<module>/
  _tasks/              ← design and task docs for this module
  pyproject.toml       ← uv deps (always — no requirements.txt)
  py_db_migrate.toml   ← migration CLI config
  runner.py            ← entry point
  config.py            ← DB config + external API keys from env vars
  fetcher.py           ← main job class
  sources/             ← one file per external data source, named after the source
    <source_a>.py
    <source_b>.py
  database/
    upsert.py          ← PostgreSQL upsert helpers
  migrations/
    0001_<name>.py
    0002_<name>.py
```

No `__init__.py` files anywhere. Python 3.3+ namespace packages handle directory imports without them. Never add `__init__.py` as a way to make a directory importable — import explicitly by module path instead.

---

## Config from env vars

All configuration reads from environment variables — no hardcoded values.

```python
# config.py
import os
from py_db_migrate.core.config import ConnectionConfig

def db_config() -> ConnectionConfig:
    return ConnectionConfig(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "5432")),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        connect_database=os.environ["DB_NAME"],
    )
```

Raise `EnvironmentError` immediately if a required variable is absent — never silently fall back.

---

## Running migrations

`py_db_migrate.toml` at the module root holds the connection config (reads from env vars). Apply all pending migrations with:

```bash
cd <module>/
export $(grep -v '^#' .env | xargs)
uv run py-db-migrate run --db postgres
```

---

## Runner pattern

```python
# runner.py
import argparse
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
        job.backfill(args.backfill)
    else:
        logger.info("runner: mode=daily")
        job.run()

if __name__ == '__main__':
    main()
```

---

## Job class pattern

```python
# fetcher.py
import sources.source_a as source_a
import sources.source_b as source_b
from database.upsert import upsert_records
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

    def backfill(self, from_date: str) -> None:
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

## Coding rules

### Data handling

- External data source values may be untyped — always cast explicitly: `float(row['amount'])`, `int(row['count'])`.
- Missing or empty values: always `row.get('field') or default`.
- Date strings: `datetime.fromisoformat(row['date_field'])`.
- PostgreSQL `NUMERIC` values come back as `Decimal` — convert to `float` only at display time, not in computation.

### Logging

Use `py-logging` exclusively. Format: `fnname: key=value key=value`.

```python
logger.info(f"run: input_rows={len(rows)} date={today}")
logger.warning(f"run: skipped_rows={skipped} reason=missing_value")
logger.error(f"run: error={e}")
```

Log at the start of `run()` with input counts, at the end with output counts. Never log:
- API keys, DB passwords, or any secret loaded from env
- Raw sensitive row data
- Any value from `.env` that is a secret

### Keep `run()` thin

`run()` orchestrates: read → compute → write. All computation lives in private `_methods` — pure functions with no I/O. This makes jobs testable without a real external connection.

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

## Common pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| `print()` instead of `logger` | Logs go nowhere useful; no timestamps; no rotation | Always use `from py_logging import get_logger` |
| `MERIDIAN_LOG_ROOT` not set | `EnvironmentError` at import | Set the env var before running; never catch and suppress |
| Not casting external string values | `'42.50' + 10 = '42.5010'` | Always cast: `float(row['amount'])` |
| Putting computation in `run()` | Untestable | Private `_methods` for all computation |
| Hardcoding DB credentials | Secrets in git | Always read from env vars; raise `EnvironmentError` if absent |
| No `finally` on DB connection | Connection leak under exceptions | Always `try/finally: client.close()` |
| Not using `pyproject.toml` | Bypasses uv | All modules use `pyproject.toml` with uv sources |
