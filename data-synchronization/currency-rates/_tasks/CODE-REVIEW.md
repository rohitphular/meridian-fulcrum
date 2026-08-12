# CODE-REVIEW — currency-rates

**Purpose:** Standing instruction set for reviewing the `currency-rates` data-sync job. Use this document each time you perform a code review — whether you are an LLM agent, a developer, or both working together.

**Scope:** Everything under `data-synchronization/currency-rates/` including migrations, sources, database helpers, core logic, config, and README.

---

## Step 1 — Read before reviewing

Read these documents in full before examining any code. They are the authoritative standards this job must conform to.

| Document | What it governs |
|----------|-----------------|
| `building-standards/APP-BE-PYTHON.md` | Job structure, uv deps, DB client pattern, migration pattern, runner pattern, error handling |
| `building-standards/APP-LOGGING.md` | Log format, log levels, what to never log |
| `building-standards/APP-CONVENTIONS.md` | Python naming (snake_case, PascalCase, UPPER_SNAKE_CASE), PostgreSQL naming, no `__init__.py` |

Then read the job's own documentation:

- `data-synchronization/currency-rates/README.md` — the source of truth for what this job is supposed to do
- `data-synchronization/currency-rates/config.yaml` — which sources are enabled
- `fulcrum/.env` — which env vars are defined

---

## Step 2 — File inventory

Confirm every file in the layout below exists on disk, and that no extra source files exist outside the layout. Flag any mismatch in either direction.

```
currency-rates/
├── config.yaml
├── pyproject.toml
├── py_db_migrate.toml
├── start-up.sh
├── core/
│   ├── config.py
│   ├── fetcher.py
│   ├── runner.py
│   └── historical.py
├── sources/
│   ├── constants.py
│   ├── stooq.py
│   └── exchangerate.py
├── database/
│   ├── currency_master.py
│   └── upsert.py
└── migrations/
    ├── 0001_create_currency_master.py
    └── 0002_create_currency_rates.py
```

Exclude from this check: `.venv/`, `uv.lock`, `_tasks/`

---

## Step 3 — Dead code check

For each file, check:

1. **Unused imports** — every `import` and `from ... import` at the top of each file must be used somewhere in that file. Remove any that are not.
2. **Unused functions** — every function defined must be called somewhere. Trace call sites. If a function has no caller inside the job and is not an entry point (`main`, `upgrade`), flag it.
3. **Unused variables** — local variables assigned but never read. Flag and remove.
4. **Unreachable code** — any code after an unconditional `return`, `raise`, or `sys.exit`. Flag it.
5. **Constants defined but not used** — module-level `UPPER_SNAKE_CASE` constants that are never referenced.
6. **Config keys with no matching code** — check `config.yaml`. Every key under `sources:` must map to a `config.source_enabled("<key>")` call in `fetcher.py`. Flag orphaned keys.
7. **Env vars read in code but absent from README** — cross-check every `os.environ[...]` and `os.environ.get(...)` in `core/config.py` against the env var table in `README.md`. Flag any gap in either direction.

---

## Step 4 — Python standards (APP-BE-PYTHON.md)

Check each item against the standard. Mark PASS or FAIL with file and line reference.

### Project setup
- [ ] `pyproject.toml` has `[tool.uv] package = false`
- [ ] No `requirements.txt` exists anywhere
- [ ] All shared libraries use `git+ssh://git@github.com/` URL format in `[tool.uv.sources]`
- [ ] No `__init__.py` files exist anywhere in the job directory
- [ ] All imports use explicit module paths (e.g. `import sources.stooq as stooq`, not `from sources import stooq`)

### DB client
- [ ] Every function that opens a DB client wraps the work in `try / finally: client.close()`
- [ ] No `CREATE TABLE` or DDL runs outside a migration file
- [ ] All writes use `ON CONFLICT` upsert — no truncate-and-reload patterns

### Configuration
- [ ] All config reads from `os.environ[...]` — no hardcoded hostnames, passwords, or API keys in code
- [ ] Required env vars use `os.environ["KEY"]` (raises `KeyError` if absent) — not `os.environ.get("KEY")` with a silent fallback
- [ ] Optional env vars with safe defaults use `os.environ.get("KEY", default)`

### Migrations
- [ ] Each migration file is named `NNNN_description.py` with a four-digit zero-padded prefix
- [ ] Each migration contains exactly one `upgrade(client) -> None` function
- [ ] `upgrade` wraps all DDL in a single `with client.cursor() as cursor:` block and calls `client.commit()` at the end
- [ ] No migration creates a table without `CREATE TABLE IF NOT EXISTS`

### Type annotations
- [ ] Every function signature has a return type annotation (`-> None`, `-> dict[str, float]`, etc.)
- [ ] Every function parameter has a type annotation
- [ ] Local variables are NOT annotated unless the type is non-obvious from assignment

### Error handling
- [ ] External HTTP calls (including `requests.Session.get` and `requests.Session.post`) are wrapped in `try / except requests.RequestException`
- [ ] Caught exceptions log with `logger.error(f"fnname: error={e}")` and do not silently swallow
- [ ] No bare `except:` without logging

---

## Step 5 — Code quality

Check each item. Mark PASS or FAIL with file and line reference.

- [ ] File reads in `core/historical.py` handle missing or malformed CSV content without crashing — each `open()` and CSV parse path logs a warning and continues rather than raising.
- [ ] No `except` block silently discards an error — every caught exception produces a `logger.warning` or `logger.error` entry before returning or re-raising.
- [ ] `uv.lock` is committed to source control and reflects the dependencies declared in `pyproject.toml`.
- [ ] No known-vulnerable or formally abandoned package appears in `pyproject.toml` dependencies.

---

## Step 6 — Logging standards (APP-LOGGING.md)

- [ ] Every file uses `from py_logging import get_logger` and `logger = get_logger(__name__)` — no `print()`, `logging.basicConfig()`, or bare `logging.getLogger()`
- [ ] Every log message follows the format `fnname: key=value key=value`
- [ ] `runner.main()` and `historical.main()` each log at start (with input parameters) and at end (with row/record counts)
- [ ] `logger.info` — used for normal operation (start, end, counts)
- [ ] `logger.warning` — used for skipped items and non-fatal misses (missing file, empty API response)
- [ ] `logger.error` — used only inside `except` blocks
- [ ] Nothing in any log message contains: API keys, DB passwords, raw financial data, or any `.env` secret value

---

## Step 7 — Naming conventions (APP-CONVENTIONS.md)

Check each item. Mark PASS or FAIL with file and line reference.

### Python
- [ ] All variables and function names: `snake_case`
- [ ] All private helpers: `_snake_case` (single leading underscore)
- [ ] All class names: `PascalCase`
- [ ] Public module-level constants: `UPPER_SNAKE_CASE`; private module-level constants (not exported): `_UPPER_SNAKE_CASE`
- [ ] All `.py` file names: `snake_case`

### PostgreSQL (check migration files)
- [ ] Table names: plural, `snake_case` (e.g. `currency_master`, `currency_rates`)
- [ ] Column names: `snake_case`; booleans prefixed `is_`; timestamps suffixed `_at`; dates suffixed `_date`
- [ ] Primary key column: `id UUID NOT NULL DEFAULT gen_random_uuid()` — plain `id`, not entity-prefixed
- [ ] Constraint names: `{type_prefix}_{table}_{column(s)}` — e.g. `uq_cr_quote_currency_date`, `fk_cr_base_currency_code`, `chk_cr_rate_positive`
- [ ] Index names: `idx_{table}_{columns}`
- [ ] View names: `v_{description}`
- [ ] Trigger names: `trg_{table}_{event}`
- [ ] Function names: `fn_{description}`

### Banned generic names
- [ ] No variable, parameter, or constant uses a banned generic name: `data`, `info`, `result`, `obj`, `temp`, `item`

---

## Step 8 — README accuracy

The README must be accurate enough that someone (human or LLM) can understand the job without reading the code. Verify each section:

### Currencies tracked
- Cross-check the currency table (code, name, rank) against the seed data in `migrations/0001_create_currency_master.py`
- Verify crypto currencies (BTC, ETH, SOL) are listed with their ranks

### Fetch priority ordering
- Confirm the SQL order expression in README matches exactly what is in `database/currency_master.py → get_fiat_currencies`

### Data sources
- Confirm stooq URL pattern, troy-ounce-to-gram conversion factor (`31.1035`), and list of supported fiat currencies match `sources/stooq.py`
- Confirm exchangerate.fun URL and tracked crypto set (`TRACKED`) match `sources/exchangerate.py`
- Confirm `TROY_OZ_TO_GRAM` constant value matches `sources/constants.py`

### Weekend and holiday gap filling
- Confirm the description of forward-fill behaviour (fills gaps, `stooq_forward_fill` source, `ON CONFLICT DO NOTHING`) matches `database/upsert.py → forward_fill_rates`

### Database schema — `currency_master`
- Every column listed in README must exist in `migrations/0001_create_currency_master.py`
- No column in the migration is missing from the README table

### Database schema — `currency_rates`
- Every column listed in README must exist in `migrations/0002_create_currency_rates.py`
- Constraints described (unique on `quote_currency_code, rate_date`) must match the migration

### Environment variables
- Every `os.environ` read in `core/config.py` must appear in the README env var table
- Every entry in the README env var table must be read somewhere in the code

### Project layout
- Every file in the layout tree must exist on disk
- No file on disk (excluding `.venv/`, `uv.lock`, `_tasks/`) is missing from the layout

### Running section
- The command in README must match what `start-up.sh` actually does
- Mode options (Daily / Historical) must match the `case` block in `start-up.sh`

---

## Step 9 — Security

- [ ] No hardcoded credentials, API keys, tokens, or passwords appear in any source file, config file, or comment.
- [ ] All secrets (`CR_DB_PASSWORD` and any API credentials) are read from environment variables — not from `config.yaml` or any file checked into source control.
- [ ] No secret value appears in any log output — check all log lines that include request headers, response bodies, config values, or DB connection strings.
- [ ] CSV row content read in `core/historical.py` is validated before being passed to `upsert_rates` — malformed or non-numeric rate values are skipped with a warning, not forwarded as-is.
- [ ] API response fields from `sources/exchangerate.py` are type-checked before the troy-ounce conversion — a non-numeric rate value must not cause an unhandled exception.

---

## Step 10 — Report format

Produce a findings report with this structure:

```
## Findings

### PASS
- List items that fully comply

### FAIL
- [file:line] Description of the violation and which step or standard it violates

### WARNINGS
- Items that are not strict violations but reduce clarity or maintainability
```

If there are no failures, confirm explicitly: "All checks passed."

Do not suggest changes beyond what the standards and this document describe. Do not refactor code that is not flagged by a specific check.
