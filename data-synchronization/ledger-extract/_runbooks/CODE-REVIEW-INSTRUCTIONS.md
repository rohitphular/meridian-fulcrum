# CODE-REVIEW — ledger-extract

**Purpose:** Standing instruction set for reviewing the `ledger-extract` data-sync job. Use this document each time you perform a code review — whether you are an LLM agent, a developer, or both working together.

**Scope:** Everything under `data-synchronization/ledger-extract/` including migrations, transforms, database helpers, core logic, config, and runbooks.

---

## Step 1 — Read before reviewing

Read these documents in full before examining any code. They are the authoritative standards this module must conform to.

| Document | What it governs |
|----------|-----------------|
| `building-standards/APP-BE-PYTHON.md` | Job structure, uv deps, DB client pattern, migration pattern, runner pattern, error handling |
| `building-standards/APP-LOGGING-PATTERNS.md` | Log format, log levels, what to never log |
| `building-standards/APP-CONVENTIONS.md` | Python naming (snake_case, PascalCase, UPPER_SNAKE_CASE), PostgreSQL naming, no `__init__.py` |

Then read the module's own documentation:

- `data-synchronization/ledger-extract/_runbooks/USAGE-INSTRUCTIONS.md` — how to run the job and environment variables
- `data-synchronization/ledger-extract/_tasks/SETUP.md` — architecture, incremental load design, hash format, schema definitions, and build order
- `data-synchronization/ledger-extract/config.yaml` — which entities are enabled
- `fulcrum/.env` — which env vars are defined

Note: `py_db_schema.toml` references `fulcrum_db` (not `${FULCRUM_DB_NAME}`) — this is intentional; `py-db-schema` spins up an ephemeral Docker container and never connects to the live database.

---

## Step 2 — File inventory

Confirm every file in the layout below exists on disk, and that no extra source files exist outside the layout. Flag any mismatch in either direction.

```
ledger-extract/
├── .gitignore
├── config.yaml
├── pyproject.toml
├── py_db_migrate.toml
├── py_db_schema.toml
├── Makefile
├── cicd/
│   ├── envs.json
│   └── start-up.sh
├── _tasks/
│   ├── SETUP.md
│   ├── TASK-categories.md
│   ├── TASK-accounts.md
│   ├── TASK-transactions.md
│   └── TASK-subscriptions.md
├── _runbooks/
│   ├── CODE-REVIEW-INSTRUCTIONS.md
│   └── USAGE-INSTRUCTIONS.md
├── core/
│   ├── config.py
│   ├── extractor.py
│   └── runner.py
├── transforms/
│   ├── categories.py
│   ├── accounts.py
│   └── transactions.py
├── sheets/
│   ├── categories.py
│   └── accounts.py
├── database/
│   ├── models/
│   ├── ledger_data_checksums.py
│   ├── job_execution_details.py
│   ├── categories.py
│   ├── accounts.py
│   └── transactions.py
└── migrations/
    ├── 0001_create_shared_infrastructure.py
    ├── 0002_create_account_types.py
    ├── 0003_create_categories.py
    ├── 0004_create_accounts.py
    └── 0005_create_transactions.py
```

Exclude from this check: `.venv/`, `uv.lock`, `__pycache__/`, `.ruff_cache/`, `database/models/`

---

## Step 3 — Dead code

For each file in scope, check:

1. **Unused imports** — every import statement must be used within the file it appears in. Flag any that are not.
2. **Unused functions** — every function defined must have at least one call site inside the module, or be a documented external entry point (`main`, `upgrade`). Flag functions with no call site and no entry-point designation.
3. **Unused variables** — local variables assigned but never read. Flag them.
4. **Unreachable code** — any code after an unconditional return, raise, exit, or equivalent. Flag it.
5. **Unused constants** — module-level constants defined but never referenced anywhere in the module. Flag them.
6. **Orphaned config keys** — every key under `entities:` in `config.yaml` must map to an `entity_enabled("<key>", config)` call in `core/extractor.py`. Flag any key the code never reads.
7. **Orphaned env vars** — cross-check every `os.environ[...]` in `core/config.py` against the env var table in `_runbooks/USAGE-INSTRUCTIONS.md`. Flag any read in code but absent from docs, and any listed in docs but absent from code. `LE_SPREADSHEET_ID` must NOT appear in `core/config.py` as `os.environ[...]` — it is set by `start-up.sh` from `cicd/envs.json` and then read as a normal env var inside `spreadsheet_id()`.
8. **Orphaned envs.json keys** — every key declared under each environment in `cicd/envs.json` must be read by `start-up.sh`. Flag any key present in `envs.json` that `start-up.sh` never reads.

---

## Step 4 — Python standards (APP-BE-PYTHON.md)

Check each item against the standard. Mark PASS or FAIL with file and line reference.

### Project setup

- [ ] `pyproject.toml` has `[tool.uv] package = false`
- [ ] No `requirements.txt` exists anywhere
- [ ] All shared libraries use `git+ssh://git@github.com/` URL format in `[tool.uv.sources]`
- [ ] `py-db-migrate` is declared with the `[postgres]` extra (`py-db-migrate[postgres]`), not bare
- [ ] No `__init__.py` files exist anywhere in the job directory — `core/`, `database/`, and `transforms/` must not contain `__init__.py`

### DB client

- [ ] No `CREATE TABLE` or DDL runs outside a migration file
- [ ] All writes use `ON CONFLICT` upsert — no truncate-and-reload patterns
- [ ] The psycopg2 connection opened in `LedgerExtractJob.__init__` is the connection used for the entire job run — confirm no second connection is opened mid-run

### Configuration

- [ ] All config reads from `os.environ[...]` — no hardcoded hostnames, passwords, or API keys in code
- [ ] Every required env var uses `os.environ["KEY"]` (raises `KeyError` if absent) — not `os.environ.get("KEY")` with a silent fallback
- [ ] `MERIDIAN_LOG_ROOT` is read at module import time in `core/config.py` to fail fast — confirm it is not suppressed or wrapped in a try/except

### Migrations

- [ ] Each migration file is named `NNNN_description.py` with a four-digit zero-padded prefix
- [ ] Each migration contains exactly one `upgrade(client) -> None` function
- [ ] `upgrade` wraps all DDL in a single `with client.cursor() as cursor:` block and calls `client.commit()` at the end
- [ ] No migration creates a table without `CREATE TABLE IF NOT EXISTS`
- [ ] Seed data INSERTs in `0002_create_account_types.py` supply `now()` explicitly for `created_at` — the column has no DEFAULT

### Type annotations

- [ ] Every function signature has a return type annotation (`-> None`, `-> dict | None`, `-> set[str]`, etc.)
- [ ] Every function parameter has a type annotation
- [ ] Local variables are NOT annotated unless the type is non-obvious from assignment

### ETL load behaviour (sync-status model)

These checks enforce the sync-status model invariants. They are the highest-risk items in any PR.

- [ ] **Zero-row guard**: if `sheets_client.read_sheet(tab)` returns 0 rows on the first batch, the entity method raises `RuntimeError` immediately — an empty first read must never proceed
- [ ] **sync_status routing**: `in-sync` rows are skipped with no DB write and no write-back; missing or unrecognised `sync_status` logs a warning and skips with no write-back; `create-pending`/`create-failed` take the INSERT path; `update-pending`/`update-failed` take the UPDATE path
- [ ] **Transform errors**: `ValueError` from `transform()` writes `create-failed`/`update-failed` + error message to the sheet and continues to the next row — it does not abort the job
- [ ] **Narrow except**: each row's DB `except` block catches only `UniqueViolation`, `ForeignKeyViolation`, `CheckViolation`, `NotNullViolation` — all other exceptions propagate and abort the job
- [ ] **Batch write-back**: write-backs are accumulated in a `list[WriteBack]` during the per-row loop and flushed in a single `batch_update_rows` call at the end of each batch — never flushed per-row
- [ ] **account_types expansion — fetchall**: `_expand_account_types` uses `cursor.fetchall()` + inner loop, not `cursor.fetchone()` — a single type token (e.g. `"asset"`) matches multiple sub-types; one join row per sub-type must be inserted
- [ ] **account_types expansion — conflict safety**: join table inserts use `ON CONFLICT DO NOTHING` — duplicate type tokens in a cell (e.g. `"asset,asset"`) must not raise a PK violation
- [ ] **account_types expansion — rowcount**: `inserted += cursor.rowcount` after each INSERT, not `inserted += 1` — `ON CONFLICT DO NOTHING` skips return rowcount 0 and must not be counted

### Transaction boundaries

- [ ] Every per-row write commits before the next row begins — a rollback on row N must not undo row N-1
- [ ] `_expand_account_types` does not call `conn.commit()` or `conn.rollback()` — it runs inside the caller's transaction

### Error handling

- [ ] Transform `ValueError` caught in `upsert_categories` is written back to the sheet as `create-failed` / `update-failed` with a human-readable message in `sync_notes` — the job continues to the next row (per-row error policy)
- [ ] When `UPDATE ... RETURNING id` returns 0 rows (entity missing from DB), the path falls back to `_insert_category` and continues — it must not skip the row or raise
- [ ] Both DB operation `except` blocks in `upsert_categories` catch only known psycopg2 integrity errors (`UniqueViolation`, `ForeignKeyViolation`, `CheckViolation`, `NotNullViolation`) — any other exception (connection loss, programming error) propagates uncaught and aborts the job via `runner.py`
- [ ] `core/runner.py` catches all exceptions at the top level, logs at error level, and calls `sys.exit(1)` — the process must not exit with code 0 on failure

---

## Step 5 — Code quality, linting, and formatting

### Linting and formatting gate

The linter and formatter must both pass with zero findings. This is a hard gate — any finding fails the review regardless of other results.

- [ ] Linter passes with zero findings — run `uv run ruff check .` from the module root. Flag every reported violation.
- [ ] Formatter reports no changes — run `uv run ruff format --check .` from the module root. Flag any file it would rewrite.
- [ ] Linter and formatter configuration is committed — `[tool.ruff]`, `[tool.ruff.lint]`, and `[tool.ruff.format]` sections are present in `pyproject.toml`.
- [ ] Import ordering is enforced by ruff (`I` rule set enabled) — flag manually grouped or reordered imports that ruff would change.

### Code quality

- [ ] No `except` block silently discards an error — every caught exception produces a `logger.warning` or `logger.error` entry before returning or re-raising.
- [ ] Every resource that must be released (DB cursor) is managed by a context manager (`with conn.cursor() as cursor:`) — never left open on the error path.
- [ ] `uv.lock` is committed to source control and reflects the dependencies declared in `pyproject.toml`.
- [ ] No known-vulnerable or formally abandoned package appears in `pyproject.toml` dependencies.
- [ ] No `print()` statement appears anywhere — all output goes through `py-logging`.

---

## Step 6 — Naming conventions (APP-CONVENTIONS.md)

Check each item. Mark PASS or FAIL with file and line reference.

### Variables and functions

- [ ] All variables and function names use `snake_case`
- [ ] All private helpers use `_snake_case` (single leading underscore — no double-underscore)
- [ ] All class names use `PascalCase`

### Constants

- [ ] Public module-level constants use `UPPER_SNAKE_CASE` (e.g. `_VALID_TX_TYPES` would be wrong — public constants have no leading underscore)
- [ ] Private module-level constants use `_UPPER_SNAKE_CASE` (e.g. `_VALID_TX_TYPES`, `_JOB_NAME`, `_CONFIG_PATH`)

### File and folder names

- [ ] All `.py` file names use `snake_case`
- [ ] Folder names describe their role (`core/`, `transforms/`, `database/`, `migrations/`)

### PostgreSQL (check migration files)

- [ ] Table names: plural, `snake_case` (e.g. `category_master`, `account_types`, `ledger_data_checksums`, `job_execution_details`)
- [ ] Column names: `snake_case`; booleans prefixed `is_`; timestamps suffixed `_at`; FK references suffixed `_id`
- [ ] Primary key column: `id UUID NOT NULL DEFAULT gen_random_uuid()` — plain `id`, not entity-prefixed
- [ ] Constraint names follow `{type_prefix}_{table}_{column(s)}` — e.g. `pk_category_master`, `uq_category_master_nat_key`, `fk_csat_category`, `chk_cm_account_mandatory`
- [ ] All indexes follow `idx_{table}_{purpose}` naming — the 7 partial unique indexes in `0004_create_accounts.py` for SCD current-record enforcement are named `idx_{extension_table}_current`

### Banned generic names

- [ ] No variable, parameter, or constant uses a banned generic name: `data`, `info`, `result`, `obj`, `temp`, `item`

---

## Step 7 — Observability

- [ ] Every file that logs initialises the logger using: `from py_logging import get_logger` and `logger = get_logger(__name__)` — no `print()`, `logging.basicConfig()`, or bare `logging.getLogger()`
- [ ] Every log message follows the format: `fnname: key=value key=value`
- [ ] `runner.main()` logs at start (`runner: start`) and at end (`runner: complete`) with status
- [ ] Info-level logging is used for normal operation — unchanged row, inserted row, updated row, soft-deleted row, early-exit no-changes
- [ ] Warning-level logging is used for skipped items and non-fatal misses — duplicate natural key, unknown account type token
- [ ] Error-level logging is used only inside error handlers for actual failures — RETURNING 0 rows, job_failed
- [ ] No log message contains any of: DB passwords, spreadsheet IDs, service account key path contents, or any `.env` secret value

---

## Step 8 — Documentation accuracy

The `_runbooks/USAGE-INSTRUCTIONS.md` must be accurate enough that a reviewer can understand the job without reading code. Verify each section:

### File inventory

- Every file listed in the `_tasks/SETUP.md` project layout exists on disk. Files annotated with `(not yet built)` are exempt from this check.
- No source file on disk (excluding `.venv/`, `uv.lock`, `__pycache__/`, `.ruff_cache/`, `database/models/`) is absent from the `_tasks/SETUP.md` layout.

### Environment config (cicd/envs.json)

- `cicd/envs.json` exists and contains a `dev` and `prod` entry, each with a `spreadsheet_id` key.
- Neither `dev` nor `prod` `spreadsheet_id` value is `"TODO"` — flag if placeholder not replaced.
- The `_runbooks/USAGE-INSTRUCTIONS.md` contains an "Environment config" section describing `cicd/envs.json`.
- `LE_SPREADSHEET_ID` does NOT appear in the env var table in `_runbooks/USAGE-INSTRUCTIONS.md` — it is not a secret and is not set in `.env`.

### Configuration

- Every env var read in `core/config.py` appears in the `_runbooks/USAGE-INSTRUCTIONS.md` env var table.
- Every entry in the `_runbooks/USAGE-INSTRUCTIONS.md` env var table is read somewhere in the code.

### Config file

- Every entity key that `entity_enabled()` in `core/extractor.py` checks must appear in the `_runbooks/USAGE-INSTRUCTIONS.md` entity toggle section.
- Every key shown in the `_runbooks/USAGE-INSTRUCTIONS.md` entity toggle example must exist in the actual `config.yaml`.
- The `enabled:` values in the `_runbooks/USAGE-INSTRUCTIONS.md` example must match the actual `config.yaml` — flag any mismatch.

### Schema

- Every column listed in the `_tasks/SETUP.md` `ledger_data_checksums` table section exists in `migrations/0001_create_shared_infrastructure.py`.
- Every column listed in the `_tasks/SETUP.md` `job_execution_details` table section exists in `migrations/0001_create_shared_infrastructure.py`.
- No column in either migration is absent from `_tasks/SETUP.md`.
- Every constraint described in `_tasks/SETUP.md` (primary key, unique, check, foreign key) exists in the corresponding migration file.

### How to run

- Every command shown in the `_runbooks/USAGE-INSTRUCTIONS.md` Running the job section matches what `cicd/start-up.sh` actually executes, in the same order.

---

## Step 9 — Security

- [ ] No hardcoded credentials, API keys, tokens, or passwords appear in any source file, config file, or comment.
- [ ] All secrets (`FULCRUM_DB_PASSWORD`, `LE_SERVICE_ACCOUNT_FILE` path) are read from environment variables — not from `config.yaml`, `cicd/envs.json`, or any file checked into source control.
- [ ] `cicd/envs.json` contains only non-secrets — spreadsheet IDs are public URL components and safe to commit; no passwords, tokens, or key file contents appear in it.
- [ ] No secret value appears in any log output — check all log lines that include DB connection details, spreadsheet identifiers, or config values.
- [ ] Sheet row content passed to `transform()` is validated before any DB write — invalid rows raise and abort rather than writing partial data.

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
