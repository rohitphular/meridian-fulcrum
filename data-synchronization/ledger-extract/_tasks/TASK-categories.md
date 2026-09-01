# TASK — categories

**Status:** READY TO BUILD
**Build order:** 1 of 4 — no dependencies on other entities

---

## Open questions

None — all decisions confirmed.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | Sheet tab name | `'categories'` |
| Q2 | `source_account_types` / `target_account_types` storage | Separate `account_types` reference table + two join tables (see below) |
| Q3 | Soft-delete mechanism | `record_status` is the single status field. On insert/update it mirrors the sheet value verbatim. When the user deletes a category via the app, GAS sets `record_status = 'deleted'` and `sync_status = 'update-pending'` on that row — the extractor picks it up on the next run via the normal update path. There is no pass that detects rows missing from the sheet. No `is_deleted` flag, no `deleted_at` timestamp — `record_status` is the sole signal. Rows are never hard-deleted. |

---

## Sheet schema (20 columns)

| # | Column | Notes |
|---|--------|-------|
| 1 | `tx_type_key` | Natural key part 1 — `money-in` or `money-out` |
| 2 | `tx_type_label` | Display label for tx type |
| 3 | `major_category_key` | Natural key part 2 — slug derived from label |
| 4 | `major_category_label` | User-facing label |
| 5 | `minor_category_key` | Natural key part 3 — slug derived from label |
| 6 | `minor_category_label` | User-facing label |
| 7 | `description` | Optional |
| 8 | `tag_keywords` | Comma-and-space-separated; lowercased on save |
| 9 | `counterparty_examples` | Optional |
| 10 | `source_account_types` | Comma-separated sub-types |
| 11 | `target_account_types` | Comma-separated sub-types |
| 12 | `source_account_mandatory` | `TRUE` / `FALSE` |
| 13 | `target_account_mandatory` | `TRUE` / `FALSE` |
| 14 | `is_subscription_eligible` | `TRUE` / `FALSE` |
| 15 | `record_status` | `active`, `inactive`, `deleted`, `locked` |
| 16 | `sync_status` | Backend-stamped — extractor writes back cols 16–18 only |
| 17 | `sync_date_time` | Backend-stamped |
| 18 | `sync_notes` | Backend-stamped |
| 19 | `created_at` | Backend-stamped — never written by extractor |
| 20 | `updated_at` | Backend-stamped — never written by extractor |

Columns 1–15 are source data read by the extractor. Columns 16–20 are stamped by the GAS backend; the extractor writes back only cols 16–18 via the designated write-back path and must never touch cols 19–20.

---

## Tables to create (3 migrations)

### Migration 1 — `account_types` (reference table, seeded)

Seeded from the GAS account schema. Contains all valid type + sub-type combinations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK |
| `account_type` | `TEXT NOT NULL` | `asset`, `investment`, `liability` |
| `account_subtype` | `TEXT NOT NULL` | e.g. `current`, `crypto`, `mortgage` |
| `description` | `TEXT` | Optional human-readable description of this sub-type |
| `record_status` | `TEXT NOT NULL DEFAULT 'active'` | `active`, `inactive`, or `deleted` — rows are never hard-deleted |
| `created_at` | `TIMESTAMPTZ NOT NULL` | Provide `now()` explicitly in each seed INSERT; no `DEFAULT` on this column |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | Updated whenever the row is modified; provide `now()` explicitly in seed INSERT |

`UNIQUE (account_type, account_subtype)`

`CHECK (record_status IN ('active', 'inactive', 'deleted'))`

`record_status` is for manual retirement only — the extract job never writes to this table after the initial seed. To retire a sub-type, set `record_status = 'inactive'` or `'deleted'` via a new migration or manual SQL. Rows are never hard-deleted. Retiring a sub-type does not immediately remove existing join rows pointing to it — those are cleaned up only when the referencing category is next modified in the sheet (triggering the changed-row path which deletes and re-inserts all join rows).

Seed data from GAS account schema:

| account_type | account_subtype |
|---|---|
| `asset` | `current`, `savings`, `cash` |
| `investment` | `stocks_shares`, `isa`, `pension_sipp`, `crypto`, `fixed_deposit`, `bonds`, `property`, `commodities`, `p2p_lending`, `other` |
| `liability` | `personal_loan`, `credit_card`, `mortgage`, `auto_loan`, `heloc`, `student_loan`, `medical_loan`, `debt_consolidation`, `overdraft` |

---

### Migration 2 — `category_master`

| Column | Sheet col | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | — | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `tx_type_key` | 1 | `TEXT NOT NULL` | Natural key part 1 — transform hard errors if not `money-in` or `money-out` |
| `tx_type_label` | 2 | `TEXT NOT NULL` | Transform hard errors if empty |
| `major_category_key` | 3 | `TEXT NOT NULL` | Natural key part 2 — transform hard errors if empty or contains `|` |
| `major_category_label` | 4 | `TEXT NOT NULL` | Transform hard errors if empty |
| `minor_category_key` | 5 | `TEXT NOT NULL` | Natural key part 3 — transform hard errors if empty or contains `|` |
| `minor_category_label` | 6 | `TEXT NOT NULL` | Transform hard errors if empty |
| `description` | 7 | `TEXT` | |
| `tag_keywords` | 8 | `TEXT` | |
| `counterparty_examples` | 9 | `TEXT` | |
| `source_account_mandatory` | 12 | `BOOLEAN NOT NULL` | Default `FALSE` if empty or None |
| `target_account_mandatory` | 13 | `BOOLEAN NOT NULL` | Default `FALSE` if empty or None |
| `is_subscription_eligible` | 14 | `BOOLEAN NOT NULL DEFAULT FALSE` | Default `FALSE` if empty or None |
| `record_status` | 15 | `TEXT NOT NULL` | Transform hard errors if empty, None, or not in `{'active', 'inactive', 'deleted', 'locked'}`; mirrored verbatim from sheet |
| `created_at` | — | `TIMESTAMPTZ NOT NULL` | When first written by the extract job |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL` | When last updated by the extract job |

Constraints:
- `UNIQUE (tx_type_key, major_category_key, minor_category_key)` — natural key
- `CHECK (tx_type_key IN ('money-in', 'money-out'))` — enforced at DB level; also enforced by the transform

---

### Migration 3 — `category_source_account_types` and `category_target_account_types` (join tables)

Both tables have the same structure:

| Column | Type | Notes |
|--------|------|-------|
| `category_id` | `UUID NOT NULL` | FK → `category_master.id` |
| `account_type_id` | `UUID NOT NULL` | FK → `account_types.id` |

`PRIMARY KEY (category_id, account_type_id)` on each.

No cascade defined on the FK — join rows are managed explicitly by the extract job (see upsert logic below).

---

## Referenced by

- `transactions.category_id UUID FK → category_master.id` — categories must be extracted before transactions in every run
- `subscriptions` — no direct FK yet; add `category_id` FK when subscriptions entity is designed (see TASK-subscriptions.md)

---

## Extract behaviour

**Sheet tab:** `'categories'`

**Zero-row guard:** If the sheet tab returns 0 rows, abort the job run with an error — do not continue with subsequent entities. An empty read (cleared tab, wrong tab name, permissions error) must never trigger a full wipe of all categories.

**sync_status routing:**

The extractor does not compute hashes. The sheet's `sync_status` column (col 16) drives all DB operations.

| `sync_status` | Action |
|---|---|
| `in-sync` | Skip — no DB write, no sheet write-back |
| `create-pending` | INSERT path |
| `create-failed` | Retry — INSERT path |
| `update-pending` | UPDATE path |
| `update-failed` | Retry — UPDATE path |

**Sheet write-back:** After processing each non-`in-sync` row, the extractor accumulates three-cell write-back entries for the Google Sheet:
- `sync_status` (col 16): `'in-sync'` on success; `'create-failed'` or `'update-failed'` (matching the path taken) on DB error or validation failure
- `sync_date_time` (col 17): UTC ISO timestamp of the operation
- `sync_notes` (col 18): `''` on success; error message on failure

Write-backs are accumulated in a `list[WriteBack]` during the per-row loop and flushed in a single `batch_update_rows` API call at the end of each batch — not per-row. If the job aborts mid-batch before the flush, rows processed in that batch retain their previous `sync_status`; re-running the job retries them safely (all DB writes are idempotent via `ON CONFLICT DO UPDATE`).

**Natural key:** `{tx_type_key}|{major_category_key}|{minor_category_key}`. `|` is a prohibited character in each of the three key fields; each must also be non-empty after stripping whitespace. Violations are row-level validation failures — write `create-failed`/`update-failed` + error message to the sheet and continue.

**source/target account type mapping:** The sheet stores comma-separated sub-type strings (e.g. `"current, savings"`). Expansion algorithm:
0. If the raw field value is `None`, empty, or whitespace-only, skip the expansion — produce zero join rows without any WARNING
1. Split on `,`, strip whitespace from each token; discard tokens where `t.strip() == ''` (empty tokens from trailing or doubled commas — silently ignored, not warned)
2. For each token: `SELECT id FROM account_types WHERE account_subtype = $1 AND record_status = 'active'` — only `active` rows match; `inactive` and `deleted` rows are excluded
3. Collect all matching IDs — these become the join table rows
4. If a token matches 0 rows in `account_types`: log a `WARNING` (include entity, natural key, and the unmatched token) and skip that token — do not fail the row

The expansion algorithm is invoked separately for each field — results for `source_account_types` insert into `category_source_account_types`; results for `target_account_types` insert into `category_target_account_types`. Insert `(category_id, account_type_id)` into the appropriate join table for each collected ID using `ON CONFLICT DO NOTHING`.

**Error handling policy:** Row-level DB errors write `create-failed`/`update-failed` + error message to the sheet and continue to the next row — the job does not abort. Job-level failures (zero rows in sheet, Sheets API write-back failure, DB connection failure) abort the run. The expansion algorithm's token-not-found case (step 4 above) is a WARNING and does not trigger a write-back.

Per-row pass (for each row read from sheet):
0. Read `sync_status` (col 16): if `'in-sync'`, skip immediately — no further processing, no sheet write-back
1. Call the transform on the raw sheet row: validate all column-level fields. Any validation failure writes `create-failed`/`update-failed` (matching `sync_status` path) + error message to the sheet for this row; continue to the next row. Rules:
   - `tx_type_key`: must be `'money-in'` or `'money-out'`
   - `tx_type_label`: must be non-empty
   - `major_category_key`, `minor_category_key`: must be non-empty and must not contain `|`
   - `major_category_label`, `minor_category_label`: must be non-empty
   - `record_status`: must be in `{'active', 'inactive', 'deleted', 'locked'}`
   - `source_account_mandatory`, `target_account_mandatory`: default to `FALSE` if empty or None
   - `is_subscription_eligible`: default to `FALSE` if empty or None
2. Compute natural key: `{tx_type_key}|{major_category_key}|{minor_category_key}`. Any key field violation (empty or contains `|`) is a validation failure — write back and continue.
3. Route by `sync_status`:
   - `create-pending` or `create-failed` — **within a single transaction**: `INSERT INTO category_master (tx_type_key, tx_type_label, major_category_key, major_category_label, minor_category_key, minor_category_label, description, tag_keywords, counterparty_examples, source_account_mandatory, target_account_mandatory, is_subscription_eligible, record_status, created_at, updated_at) VALUES (...all typed transform fields..., now(), now()) ON CONFLICT (tx_type_key, major_category_key, minor_category_key) DO UPDATE SET tx_type_label = EXCLUDED.tx_type_label, major_category_label = EXCLUDED.major_category_label, minor_category_label = EXCLUDED.minor_category_label, description = EXCLUDED.description, tag_keywords = EXCLUDED.tag_keywords, counterparty_examples = EXCLUDED.counterparty_examples, source_account_mandatory = EXCLUDED.source_account_mandatory, target_account_mandatory = EXCLUDED.target_account_mandatory, is_subscription_eligible = EXCLUDED.is_subscription_eligible, record_status = EXCLUDED.record_status, updated_at = now() RETURNING id`; `DELETE FROM category_source_account_types WHERE category_id = <returned id>`; `DELETE FROM category_target_account_types WHERE category_id = <returned id>`; run the expansion algorithm within the same transaction and insert resulting `(category_id, account_type_id)` pairs; commit. On DB error: rollback, write `create-failed` + error message to sheet, continue.
   - `update-pending` or `update-failed` — **within a single transaction**: `UPDATE category_master SET tx_type_label = $tx_type_label, major_category_label = $major_category_label, minor_category_label = $minor_category_label, description = $description, tag_keywords = $tag_keywords, counterparty_examples = $counterparty_examples, source_account_mandatory = $source_account_mandatory, target_account_mandatory = $target_account_mandatory, is_subscription_eligible = $is_subscription_eligible, record_status = $record_status, updated_at = now() WHERE tx_type_key = $1 AND major_category_key = $2 AND minor_category_key = $3 RETURNING id`; if no row returned, fall back to the INSERT path (same SQL as `create-pending` — the row may have been lost from the DB); `DELETE FROM category_source_account_types WHERE category_id = <returned id>`; `DELETE FROM category_target_account_types WHERE category_id = <returned id>`; run the expansion algorithm and re-insert; commit. On DB error: rollback, write `update-failed` + error message to sheet, continue.
4. On success: write `sync_status = 'in-sync'`, `sync_date_time = <UTC ISO timestamp>`, `sync_notes = ''` to the sheet for this row.

---

## What to build

- [ ] `migrations/0001_create_shared_infrastructure.py` — `job_execution_details`
- [ ] `migrations/0002_create_account_types.py` — `account_types` reference table + seed data
- [ ] `migrations/0003_create_categories.py` — `category_master` + join tables
- [ ] `transforms/categories.py` — row dict → typed dict
- [ ] `database/categories.py` — `category_master` upsert + explicit join table deletes/inserts
- [ ] `database/job_execution_details.py` — Phase 1 bootstrap/read and Phase 3 UPSERT
- [ ] `sheets/categories.py` — write-back `sync_status`, `sync_date_time`, `sync_notes` to sheet via Sheets API
- [ ] Wire into `core/extractor.py`
