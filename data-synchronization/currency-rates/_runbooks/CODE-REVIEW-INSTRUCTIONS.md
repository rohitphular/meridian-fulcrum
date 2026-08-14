# CODE-REVIEW — currency-rates

**Purpose:** Standing instruction set for reviewing the `currency-rates` data-sync job. Use this document each time you perform a code review — whether you are an LLM agent, a developer, or both working together.

**Scope:** Everything under `data-synchronization/currency-rates/` including migrations, sources, database helpers, core logic, config, and README.

---

## Step 1 — Read before reviewing

Read these documents in full before examining any code. They are the authoritative standards this module must conform to.

| Document | What it governs |
|----------|-----------------|
| `building-standards/APP-BE-PYTHON.md` | Job structure, uv deps, DB client pattern, migration pattern, runner pattern, error handling |
| `building-standards/APP-LOGGING-PATTERNS.md` | Log format, log levels, what to never log |
| `building-standards/APP-CONVENTIONS.md` | Python naming (snake_case, PascalCase, UPPER_SNAKE_CASE), PostgreSQL naming, no `__init__.py` |

Then read the module's own documentation:

- `data-synchronization/currency-rates/README.md` — source of truth for what this job is supposed to do
- `data-synchronization/currency-rates/config.yaml` — which sources are enabled
- `fulcrum/.env` — which env vars are defined

---

## Step 2 — File inventory

Confirm every file in the layout below exists on disk, and that no extra source files exist outside the layout. Flag any mismatch in either direction.

```
currency-rates/
├── README.md
├── Makefile
├── config.yaml
├── pyproject.toml
├── py_db_migrate.toml
├── py_db_schema.toml
├── start-up.sh
├── _runbooks/
│   ├── CODE-REVIEW-INSTRUCTIONS.md
│   └── USAGE-INSTRUCTIONS.md
├── core/
│   ├── config.py
│   ├── fetcher.py
│   ├── runner.py
│   └── historical.py
├── sources/
│   ├── constants.py
│   ├── fiat.py
│   └── crypto.py
├── database/
│   ├── currency_master.py
│   ├── upsert.py
│   └── models/
│       ├── currency_master.py
│       └── currency_rates.py
└── migrations/
    ├── 0001_create_currency_master.py
    └── 0002_create_currency_rates.py
```

Exclude from this check: `.venv/`, `uv.lock`, `__pycache__/`

---

## Step 3 — Dead code

For each file in scope, check:

1. **Unused imports** — every import statement must be used within the file it appears in. Flag any that are not.
2. **Unused functions** — every function defined must have at least one call site inside the module, or be a documented external entry point (`main`, `upgrade`). Flag functions with no call site and no entry-point designation.
3. **Unused variables** — local variables assigned but never read. Flag them.
4. **Unreachable code** — any code after an unconditional return, raise, exit, or equivalent. Flag it.
5. **Unused constants** — module-level constants defined but never referenced anywhere in the module. Flag them.
6. **Orphaned config keys** — every key under `sources:` in `config.yaml` must map to a `config.source_enabled("<key>")` call in `fetcher.py`. Flag any key the code never reads.
7. **Orphaned env vars** — cross-check every `os.environ[...]` and `os.environ.get(...)` in `core/config.py` against the env var table in `README.md`. Flag any read in code but absent from docs, and any listed in docs but absent from code.

---

## Step 4 — Python standards (APP-BE-PYTHON.md)

Check each item against the standard. Mark PASS or FAIL with file and line reference.

### Project setup

- [ ] `pyproject.toml` has `[tool.uv] package = false`
- [ ] No `requirements.txt` exists anywhere
- [ ] All shared libraries use `git+ssh://git@github.com/` URL format in `[tool.uv.sources]`
- [ ] No `__init__.py` files exist anywhere in the job directory
- [ ] All imports use explicit module paths (e.g. `import sources.fiat as fiat`, not `from sources import fiat`)

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

- [ ] External HTTP calls made directly via `requests` are wrapped in `try / except requests.RequestException`; calls via yfinance (`yf.download`) use `except Exception` because yfinance surfaces multiple internal exception types beyond `requests.RequestException`
- [ ] Caught exceptions log with `logger.warning` or `logger.error` and do not silently swallow
- [ ] No bare `except:` without logging

---

## Step 5 — Code quality, linting, and formatting

### Linting and formatting gate

The linter and formatter must both pass with zero findings. This is a hard gate — any finding fails the review regardless of other results.

- [ ] Linter passes with zero findings — run `uv run ruff check .` from the module root. Flag every reported violation.
- [ ] Formatter reports no changes — run `uv run ruff format --check .` from the module root. Flag any file it would rewrite.
- [ ] Linter and formatter configuration is committed — `[tool.ruff]`, `[tool.ruff.lint]`, and `[tool.ruff.format]` sections are present in `pyproject.toml`.
- [ ] Import ordering is enforced by ruff (`I` rule set enabled) — flag manually grouped or reordered imports that ruff would change.

### Code quality

- [ ] File reads in `core/historical.py` handle missing or malformed CSV content without crashing — each `open()` and CSV parse path logs a warning and continues rather than raising.
- [ ] No `except` block silently discards an error — every caught exception produces a `logger.warning` or `logger.error` entry before returning or re-raising.
- [ ] Every resource that must be released (DB client) is closed in a `finally` block — never left open on the error path.
- [ ] `uv.lock` is committed to source control and reflects the dependencies declared in `pyproject.toml`.
- [ ] No known-vulnerable or formally abandoned package appears in `pyproject.toml` dependencies.

---

## Step 6 — Naming conventions (APP-CONVENTIONS.md)

Check each item. Mark PASS or FAIL with file and line reference.

### Variables and functions

- [ ] All variables and function names use `snake_case`
- [ ] All private helpers use `_snake_case` (single leading underscore — no double-underscore)
- [ ] All class names use `PascalCase`

### Constants

- [ ] Public module-level constants use `UPPER_SNAKE_CASE` (e.g. `TROY_OZ_TO_GRAM`, `SYMBOLS`)
- [ ] Private module-level constants use `_UPPER_SNAKE_CASE` (e.g. `_FOREX`, `_TICKERS`, `_UPSERT_SQL`)

### File and folder names

- [ ] All `.py` file names use `snake_case`
- [ ] Folder names describe their role (`core/`, `sources/`, `database/`, `migrations/`)

### PostgreSQL (check migration files)

- [ ] Table names: plural, `snake_case` (e.g. `currency_master`, `currency_rates`)
- [ ] Column names: `snake_case`; booleans prefixed `is_`; timestamps suffixed `_at`; dates suffixed `_date`
- [ ] Primary key column: `id UUID NOT NULL DEFAULT gen_random_uuid()` — plain `id`, not entity-prefixed
- [ ] Constraint names: `{type_prefix}_{table}_{column(s)}` — e.g. `uq_cr_quote_currency_date`
- [ ] Index names: `idx_{table}_{columns}`
- [ ] View names: `v_{description}`
- [ ] Trigger names: `trg_{table}_{event}`
- [ ] Function names: `fn_{description}`

### Banned generic names

- [ ] No variable, parameter, or constant uses a banned generic name: `data`, `info`, `result`, `obj`, `temp`, `item`

---

## Step 7 — Observability

- [ ] Every file initialises the logger using: `from py_logging import get_logger` and `logger = get_logger(__name__)` — no `print()`, `logging.basicConfig()`, or bare `logging.getLogger()`
- [ ] Every log message follows the format: `fnname: key=value key=value`
- [ ] `runner.main()` and `historical.main()` each log at start (with input parameters) and at end (with output counts)
- [ ] Info-level logging is used for normal operation (start, end, counts, status)
- [ ] Warning-level logging is used for skipped items and non-fatal misses (missing file, empty API response)
- [ ] Error-level logging is used only inside `except` blocks for actual failures
- [ ] No log message contains any of: API keys, DB passwords, raw financial data, or any `.env` secret value

---

## Step 8 — Documentation accuracy

The README must be accurate enough that a reviewer can understand the job without reading code. Verify each section:

### File inventory

- Every file listed in the README project layout exists on disk.
- No source file on disk (excluding `.venv/`, `uv.lock`, `__pycache__/`) is absent from the README layout.

### Configuration

- Every env var read in `core/config.py` appears in the README env var table.
- Every entry in the README env var table is read somewhere in the code.

### Config file

- Every key the code reads from `config.yaml` appears in the README config section.
- Every key shown in the README config section exists in the actual `config.yaml`.

### Schema

- Every column listed in the README `currency_master` table exists in `migrations/0001_create_currency_master.py`.
- Every column listed in the README `currency_rates` table exists in `migrations/0002_create_currency_rates.py`.
- No column in either migration is absent from the README.
- Every constraint described in the README (unique on `quote_currency_code, rate_date`) exists in the migration.

### Data sources

- Confirm yfinance gold ticker (`GC=F`), forex pair mappings (`_FOREX` dict: ticker and multiply flag per currency), and supported fiat currency list match `sources/fiat.py`.
- Confirm yfinance crypto ticker map (`_TICKERS`) matches `sources/crypto.py`.
- Confirm `TROY_OZ_TO_GRAM` constant value matches `sources/constants.py`.
- Confirm forward-fill behaviour description (fills gaps, `forward_fill` source label, `ON CONFLICT DO NOTHING`) matches `database/upsert.py`.

### How to run

- Every command shown in the README How to run section matches what `start-up.sh` actually executes.
- Every mode option (Daily / Historical) matches the `case` block in `start-up.sh`.

---

## Step 9 — Security

- [ ] No hardcoded credentials, API keys, tokens, or passwords appear in any source file, config file, or comment.
- [ ] All secrets (`FULCRUM_DB_PASSWORD` and any API credentials) are read from environment variables — not from `config.yaml` or any file checked into source control.
- [ ] No secret value appears in any log output — check all log lines that include request headers, response bodies, config values, or DB connection strings.
- [ ] CSV row content read in `core/historical.py` is validated before being passed to `upsert_rates` — malformed or non-numeric rate values are skipped with a warning, not forwarded as-is.
- [ ] API response fields from `sources/crypto.py` are type-checked before the troy-ounce conversion — a non-numeric rate value must not cause an unhandled exception.

---

## Step 10 — Report format

Produce a findings report with this exact structure:

```
## Findings

### PASS
- List every checked item that fully complies.

### FAIL
- [file:line] Description of the violation and which step or standard it violates.

### WARNINGS
- Items that are not strict violations but reduce clarity or maintainability.
```

If there are no failures, state explicitly: "All checks passed."

Do not suggest changes beyond what the standards and this document describe. Do not refactor code that is not flagged by a specific check.
