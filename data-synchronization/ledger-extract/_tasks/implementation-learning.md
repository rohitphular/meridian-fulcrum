# Implementation Learnings — ledger-extract

Hard-won knowledge from the categories implementation. Each item below describes something that went wrong, was non-obvious, or required a design decision. Read this document before planning any new entity task.

---

## 1. Migration safety

### 1.1 Always cross-check FK column names against the creating migration

Migration 0004 (accounts) declared `FOREIGN KEY (account_type, sub_type) REFERENCES account_types(account_type, sub_type)`. Migration 0002 had already renamed that column to `account_subtype`. The job failed at startup with `column "sub_type" referenced in foreign key constraint does not exist`.

**Rule:** Before writing any `FOREIGN KEY ... REFERENCES`, open the migration that creates the referenced table and read the exact column name. Do not rely on the task doc — task docs can be out of date.

### 1.2 TASK-accounts.md still uses the old `sub_type` column name

TASK-accounts.md uses `sub_type` in Q3, Q11, Q28, the sheet schema table, and the `account_types` schema section. Migration 0002 renamed this column to `account_subtype`. Before implementing accounts, update every occurrence of `sub_type` in TASK-accounts.md to `account_subtype`, and verify the accounts migration uses `account_subtype` throughout.

### 1.3 CHECK constraint values must match exactly

Migration 0004 had `'in_active'` where it should have been `'inactive'`. This does not fail loudly — rows with `record_status = 'inactive'` silently violate the check and are rejected. Spell out every enum value and compare it against the sheet values and the categories/accounts task docs before committing the migration.

### 1.4 Always use `CREATE TABLE IF NOT EXISTS`

Every migration must use `CREATE TABLE IF NOT EXISTS`. Plain `CREATE TABLE` fails on re-run if the table already exists, blocking migration from recovering cleanly.

---

## 2. Batch read pattern (all entities)

### 2.1 Use the batch loop, not a single read

`read_sheet` accepts a range and enforces a maximum of 1000 rows. Never call it without an end bound. The extractor loop pattern is:

```python
row_start = 1
while True:
    rows = sheets_client.read_sheet(tab, row_start, row_start + _BATCH_SIZE - 1)
    # zero-row guard here (see 2.2)
    if not rows:
        break
    process(rows, row_start)
    if len(rows) < _BATCH_SIZE:
        break
    row_start += _BATCH_SIZE
```

### 2.2 Zero-row guard goes on the first batch, not after all batches

If the first batch returns 0 rows, raise immediately — an empty first read must never silently proceed. If a later batch returns 0 rows, that is normal EOF and the loop should break.

```python
first_batch = True
while True:
    rows = ...
    if first_batch:
        if len(rows) == 0:
            raise RuntimeError(f"{entity}: zero rows returned from sheet — aborting to prevent full wipe")
        first_batch = False
    if not rows:
        break
    ...
```

### 2.3 `read_sheet` raises `APIError` on quota/network failure — do not suppress

An early implementation returned `[]` on `APIError`. This silently terminated the batch loop mid-stream, leaving unprocessed rows with no error. `read_sheet` now raises on `APIError`. Do not add a `try/except` around `read_sheet` that swallows or converts the error to an empty list.

---

## 3. Batch write-back pattern (sync_status entities)

### 3.1 Accumulate first, flush once per batch

Per-row `batch_update_rows` calls hit 429 quota limits within a single batch at realistic sheet sizes. The correct pattern: accumulate a `list[WriteBack]` during the per-row loop, then call `sheets_client.batch_update_rows` once at the end of the batch. Categories established this pattern in `sheets/categories.py`.

### 3.2 `sheets/<entity>.py` module structure

Every sync_status entity needs a `sheets/<entity>.py` with:

```python
_SYNC_STATUS_COL = <1-indexed column number of sync_status in the sheet>

WriteBack = tuple[int, int, list]   # type alias — must be public (no leading underscore)

def write_back(sheet_row_num: int, sync_status: str, sync_date_time: str, sync_notes: str) -> WriteBack:
    return (sheet_row_num, _SYNC_STATUS_COL, [sync_status, sync_date_time, sync_notes])

def flush(sheets_client: SheetsClient, sheet_name: str, write_backs: list[WriteBack]) -> None:
    if write_backs:
        sheets_client.batch_update_rows(sheet_name, write_backs)
```

`WriteBack` must not have a leading underscore — it is imported by `database/<entity>.py` and private types cannot be accessed cross-module.

### 3.3 Verify `_SYNC_STATUS_COL` against the actual sheet

`batch_update_rows` takes a 1-indexed column number. Count the columns in the sheet schema and confirm the column number before writing the constant. Writing to the wrong column silently corrupts adjacent data.

### 3.4 `sheet_row_num` calculation

Data row 1 (first row after header) is sheet row 2 (header is row 1). The formula is:

```python
sheet_row_num = row_start + row_index + 1
```

where `row_start` is the 1-indexed data row number of the first row in the batch (1 for the first batch), and `row_index` is the 0-indexed position within the batch.

### 3.5 `SheetsClient` must be `is_readonly=False` for sync_status entities

Any entity that writes sync columns back to the sheet must initialise `SheetsClient` with `is_readonly=False`. The extractor in `core/extractor.py` already does this. Do not change it to readonly for entities that write back.

---

## 4. Error handling

### 4.1 Never catch bare `Exception` in DB operation blocks

Both the create and update blocks had `except Exception as e: conn.rollback(); ...`. A dead database connection (`OperationalError`) was being caught, written back to the sheet as `create-failed`, and execution continued. The job appeared to complete while silently failing every remaining row.

Narrow the catch to only the psycopg2 integrity errors you expect:

```python
except (
    pg_errors.UniqueViolation,
    pg_errors.ForeignKeyViolation,
    pg_errors.CheckViolation,
    pg_errors.NotNullViolation,
) as e:
    conn.rollback()
    ...
```

Anything outside this set propagates to `runner.py` which logs at error level and exits with code 1.

### 4.2 Transform `ValueError` is per-row, not a job abort

`ValueError` raised by `transforms/<entity>.py` is caught individually per row, written back to the sheet with a human-readable `sync_notes` message, and the job continues to the next row. This must be in a separate `try/except ValueError` block around the `transform()` call — before the DB operation block. It must not be combined into the DB exception catch.

### 4.3 `_to_sync_notes` — every sync_status entity needs one

Raw psycopg2 error messages are not user-readable. Each entity's `database/<entity>.py` must define `_to_sync_notes(e: Exception) -> str` that maps known error types to plain sentences. Copy the pattern from `database/categories.py` and adjust the FK/unique violation descriptions for the entity's actual schema. Fallback generic message at the end.

---

## 5. Sheets client and library upgrades

### 5.1 Stale `uv.lock` SHA causes `AttributeError` at runtime

If `py-google-workspace` has a new method (e.g., `batch_update_rows`) but `uv.lock` still pins an older commit SHA, the job runs the old library and raises `'SheetsClient' object has no attribute '...'`. Fix: push the common-libs changes, then run `make upgrade-libs` (or `make run` which calls it automatically).

### 5.2 `make run` upgrades libs; direct `uv run` does not

`make run ENV=dev` calls `upgrade-libs` before running the job. Running `uv run python -m core.runner` directly skips the upgrade step and may execute stale library code. Always use `make run` for integration testing, not `uv run` directly.

### 5.3 `_with_retry` is built into `SheetsClient` — callers add nothing

All `SheetsClient` methods already wrap API calls with `_with_retry` (exponential backoff on 429). Do not add retry logic in `core/extractor.py` or `database/<entity>.py` calls to the sheets client.

---

## 6. Join table pattern (`account_types` expansion)

Applies to any entity that stores comma-separated account subtype tokens (categories uses `source_account_types` and `target_account_types`; accounts does not have join tables of this kind but the pattern is reusable).

### 6.1 Use `fetchall()` + inner loop, never `fetchone()`

A single token like `"asset"` can match multiple rows in `account_types` (e.g., `asset/current`, `asset/savings`, `asset/cash`). Using `fetchone()` inserts only the first match and silently drops the rest.

### 6.2 `ON CONFLICT DO NOTHING` on join table inserts

A cell with `"asset,asset"` (duplicate token) must not raise a primary key violation. All join table inserts use `ON CONFLICT DO NOTHING`.

### 6.3 `inserted += cursor.rowcount`, not `inserted += 1`

`ON CONFLICT DO NOTHING` skips return `rowcount = 0`. Counting `+= 1` unconditionally overcounts. Use `+= cursor.rowcount` so deduped inserts are not included.

### 6.4 Delete-then-rebuild on update

On update, delete all existing join rows for the entity first (`DELETE FROM ... WHERE category_id = %s`), then re-insert from the current raw field values. Do not diff or merge. This runs inside the caller's transaction — do not commit or rollback inside the expand helper.

---

## 7. Code quality — project-wide rules

### 7.1 No fallback values anywhere

`|| 0`, `|| ''`, `|| null`, `?? ''`, `?? []`, `?? {}`, `.get("key", "")`, `.get("key", False)`, `isNaN(v) ? 0 : v` — all banned in both FE and BE code. Config reads that should fail fast on missing keys must use `config["key"]`, not `config.get("key", default)`.

`entity_enabled` was changed from three chained `.get()` calls to `config["entities"][entity]["enabled"]`. Any entity that adds a new config key must follow the same pattern.

### 7.2 Constants at module level, not inside functions

`_ACTIONABLE`, `_VALID_SYNC_STATUSES`, `_SHEET_NAME`, `_SYNC_STATUS_COL` — all must be module-level private constants, not re-created inside a function on every call.

### 7.3 `filter(Boolean)` and `isNaN()` are banned

Use `.filter(s => s !== '')` and `Number.isFinite(v)` respectively.

### 7.4 Public type aliases for cross-module use

Type aliases used in more than one file must have no leading underscore. `WriteBack` (not `_WriteBack`) in `sheets/<entity>.py` is the established pattern.

---

## 8. All entities use the sync_status model — there is no hash model

Every entity (categories, accounts, transactions, subscriptions) uses sync_status. There is no hash comparison model, no `ledger_data_checksums` table involvement, and no soft-delete pass.

**What this means for every entity:**

- No `row_hash`, `is_deleted`, or `deleted_at` columns in any entity table. `record_status` is the sole status field, mirrored verbatim from the sheet on every insert/update.
- Deletion is handled by GAS: when a user deletes a record via the app, GAS sets `record_status = 'deleted'` and `sync_status = 'update-pending'`. The extract job picks it up via the normal update path and writes `record_status = 'deleted'` to the DB.
- Every entity needs a `sheets/<entity>.py` module with `_SYNC_STATUS_COL`, `WriteBack`, `write_back()`, and `flush()`.
- Every entity's `transforms/<entity>.py` produces a typed dict only — no hash computation.
- Every entity's `database/<entity>.py` writes back sync columns; it does not interact with `ledger_data_checksums`.

**Do not build `database/ledger_data_checksums.py`.** The `ledger_data_checksums` table in migration 0001 and the hash model sections in SETUP.md describe the original design that was superseded before any entity was implemented. The categories implementation established sync_status as the universal model, and all subsequent entities follow it.

---

## 9. Observability

### 9.1 Log `batch_start` and `batch_done` at every batch

```
upsert_<entity>: batch_start entity=<entity> row_start=<n> total=<n> in_sync=<n> actionable=<n>
upsert_<entity>: batch_done  entity=<entity> inserted=<n> updated=<n> failed=<n>
```

`actionable_count` counts only rows with a status in `_ACTIONABLE` — not `len(rows) - in_sync_count`. Rows with missing or unrecognised `sync_status` are neither in-sync nor actionable.

### 9.2 Log `natural_key=` on every per-row event

Never log raw DB row `id` or sheet row number as the primary identifier in per-row log lines. Always log `natural_key=` so failures in logs map directly back to the sheet.

### 9.3 Log at the right level

- `logger.info` — normal operation: inserted, updated, batch_start, batch_done
- `logger.warning` — skipped/non-fatal: missing_sync_status, unknown_sync_status, unknown_account_subtype, update_fallback_to_insert
- `logger.error` — only inside exception handlers for actual failures: create_failed, update_failed

---

## 10. Docs — keep in sync with code

### 10.1 Add new entity's `sheets/` directory to both layout docs

When implementing a new sync_status entity, add `sheets/<entity>.py` to:
- `_tasks/SETUP.md` folder structure
- `_runbooks/CODE-REVIEW-INSTRUCTIONS.md` Step 2 layout

### 10.2 Add each new entity to the USAGE-INSTRUCTIONS entity toggle example

The `config.yaml` example in USAGE-INSTRUCTIONS.md must list every entity in the actual `config.yaml`. Missing entries mislead operators into thinking the entity is not toggle-able.

### 10.3 Update TASK-<entity>.md `sub_type` references before implementing accounts

Every occurrence of `sub_type` in TASK-accounts.md (Q3, Q11, Q28, sheet schema, `account_types` schema) must be updated to `account_subtype` before planning or starting the accounts implementation. The migration 0002 already uses `account_subtype`; the task doc is stale.
