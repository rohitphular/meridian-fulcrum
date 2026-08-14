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
├── config.yaml
├── pyproject.toml
├── py_db_migrate.toml
├── py_db_schema.toml
├── Makefile
├── start-up.sh
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
│   └── categories.py
├── database/
│   ├── models/
│   ├── hashes.py
│   ├── job_state.py
│   └── upsert.py
└── migrations/
    ├── 0001_create_account_types.py
    ├── 0002_create_category_master.py
    ├── 0003_create_category_account_type_joins.py
    ├── 0007_create_extract_hashes.py
    └── 0008_create_job_state.py
```

Exclude from this check: `.venv/`, `uv.lock`, `__pycache__/`, `database/models/`

---

## Step 3 — Dead code

For each file in scope, check:

1. **Unused imports** — every import statement must be used within the file it appears in. Flag any that are not.
2. **Unused functions** — every function defined must have at least one call site inside the module, or be a documented external entry point (`main`, `upgrade`). Flag functions with no call site and no entry-point designation.
3. **Unused variables** — local variables assigned but never read. Flag them.
4. **Unreachable code** — any code after an unconditional return, raise, exit, or equivalent. Flag it.
5. **Unused constants** — module-level constants defined but never referenced anywhere in the module. Flag them.
6. **Orphaned config keys** — every key under `entities:` in `config.yaml` must map to an `entity_enabled("<key>", config)` call in `core/extractor.py`. Flag any key the code never reads.
7. **Orphaned env vars** — cross-check every `os.environ[...]` in `core/config.py` against the env var table in `_runbooks/USAGE-INSTRUCTIONS.md`. Flag any read in code but absent from docs, and any listed in docs but absent from code.

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
- [ ] Seed data INSERTs in `0001_create_account_types.py` supply `now()` explicitly for `created_at` — the column has no DEFAULT

### Type annotations

- [ ] Every function signature has a return type annotation (`-> None`, `-> dict | None`, `-> set[str]`, etc.)
- [ ] Every function parameter has a type annotation
- [ ] Local variables are NOT annotated unless the type is non-obvious from assignment

### ETL load behaviour

These checks enforce the incremental load invariants specific to this job. They are the highest-risk items in any PR.

- [ ] **Hash — raw values**: `ordered_values` in every `transforms/*.py` uses raw sheet string variables, not typed Python values — `raw_tx_type` not `tx_type`; `raw_is_active` not `is_active` (`str(True)` is `"True"` but the sheet contains `"TRUE"`, producing a different hash on every run)
- [ ] **Hash — token normalisation**: `source_account_types` and `target_account_types` are passed through `_normalise_account_types_for_hash` before inclusion in `ordered_values`, not included raw — this ensures `"asset,investment"` and `"investment,asset"` hash-equivalent
- [ ] **Hash — column order**: `ordered_values` column order in every `transforms/*.py` exactly matches the schema order declared in the entity's task doc — any reordering silently invalidates all existing hashes
- [ ] **Zero-row guard**: if `sheets_client.read_sheet(tab)` returns 0 rows, the job raises immediately before the soft-delete pass — an empty read must never trigger a full wipe
- [ ] **Soft-delete atomicity**: the `extract_hashes` DELETE and the entity table soft-delete UPDATE are in the same transaction — `extract_hashes` must never hold a row for a soft-deleted entity row
- [ ] **Resurrection**: the new-row INSERT uses `ON CONFLICT (...) DO UPDATE SET is_deleted = FALSE, deleted_at = NULL, ...` — a row returning to the sheet after soft-delete must be fully restored, not rejected by the unique constraint
- [ ] **account_types expansion — fetchall**: `_expand_account_types` uses `cursor.fetchall()` + inner loop, not `cursor.fetchone()` — a single type token (e.g. `"asset"`) matches multiple sub-types; one join row per sub-type must be inserted
- [ ] **account_types expansion — conflict safety**: join table inserts use `ON CONFLICT DO NOTHING` — duplicate type tokens in a cell (e.g. `"asset,asset"`) must not raise a PK violation
- [ ] **account_types expansion — rowcount**: `inserted += cursor.rowcount` after each INSERT, not `inserted += 1` — `ON CONFLICT DO NOTHING` skips return rowcount 0 and must not be counted

Note: `major_category` and `minor_category` are stored and hashed as raw sheet strings (not stripped) — this is intentional so whitespace changes are detected as edits. Do not flag the absence of `.strip()` on these fields.

### Transaction boundaries

- [ ] Every per-row write (insert, update, or hash-only `last_seen_at` update) commits before the next row begins — a rollback on row N must not undo row N-1
- [ ] `hashes_db.update_last_seen` is the only function in `database/hashes.py` that calls `conn.commit()` — `insert_hash`, `update_hash`, `delete_hash`, and `get_all_keys` must not commit or rollback
- [ ] `_expand_account_types` does not call `conn.commit()` or `conn.rollback()` — it runs inside the caller's transaction
- [ ] `hashes_db.get_all_keys` is called after the per-row loop completes, not inside it — it must read the fully committed final state of `extract_hashes`

### Error handling

- [ ] Transform `ValueError` propagates uncaught from `upsert_categories` — it must abort the job (hard error policy)
- [ ] When `UPDATE ... RETURNING id` returns 0 rows (DB inconsistency), the path rolls back, logs at error level, and continues to the next row — it must not raise; the `extract_hashes` row is left intact as a diagnostic signal
- [ ] The `except Exception: conn.rollback(); raise` block re-raises every unexpected psycopg2 exception — it must not swallow it
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

- [ ] Table names: plural, `snake_case` (e.g. `category_master`, `account_types`, `extract_hashes`, `job_state`)
- [ ] Column names: `snake_case`; booleans prefixed `is_`; timestamps suffixed `_at`; FK references suffixed `_id`
- [ ] Primary key column: `id UUID NOT NULL DEFAULT gen_random_uuid()` — plain `id`, not entity-prefixed
- [ ] Constraint names follow `{type_prefix}_{table}_{column(s)}` — e.g. `pk_category_master`, `uq_category_master_nat_key`, `fk_csat_category`, `chk_cm_account_mandatory`
- [ ] No indexes defined yet — if any are added, verify they follow `idx_{table}_{columns}`

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

- Every file listed in the `_tasks/SETUP.md` project layout exists on disk.
- No source file on disk (excluding `.venv/`, `uv.lock`, `__pycache__/`, `database/models/`) is absent from the `_tasks/SETUP.md` layout.

### Configuration

- Every env var read in `core/config.py` appears in the `_runbooks/USAGE-INSTRUCTIONS.md` env var table.
- Every entry in the `_runbooks/USAGE-INSTRUCTIONS.md` env var table is read somewhere in the code.

### Config file

- Every entity key that `entity_enabled()` in `core/extractor.py` checks must appear in the `_runbooks/USAGE-INSTRUCTIONS.md` entity toggle section.
- Every key shown in the `_runbooks/USAGE-INSTRUCTIONS.md` entity toggle example must exist in the actual `config.yaml`.
- The `enabled:` values in the `_runbooks/USAGE-INSTRUCTIONS.md` example must match the actual `config.yaml` — flag any mismatch.

### Schema

- Every column listed in the `_tasks/SETUP.md` `extract_hashes` table section exists in `migrations/0007_create_extract_hashes.py`.
- Every column listed in the `_tasks/SETUP.md` `job_state` table section exists in `migrations/0008_create_job_state.py`.
- No column in either migration is absent from `_tasks/SETUP.md`.
- Every constraint described in `_tasks/SETUP.md` (primary key, unique, check, foreign key) exists in the corresponding migration file.

### How to run

- Every command shown in the `_runbooks/USAGE-INSTRUCTIONS.md` Running the job section matches what `start-up.sh` actually executes, in the same order.

---

## Step 9 — Security

- [ ] No hardcoded credentials, API keys, tokens, or passwords appear in any source file, config file, or comment.
- [ ] All secrets (`FULCRUM_DB_PASSWORD`, `LE_SERVICE_ACCOUNT_FILE` path) are read from environment variables — not from `config.yaml` or any file checked into source control.
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
