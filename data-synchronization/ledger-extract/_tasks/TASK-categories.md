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
| Q2 | `workflow_type` values | `account-credit`, `account-debit`, `funds-transfer`, `forex-transfer`, `debt-repayment` — `VARCHAR(100) NOT NULL` with `CHECK` constraint |
| Q3 | `source_account_types` / `target_account_types` storage | Separate `account_types` reference table + two join tables (see below) |

---

## Tables to create (3 migrations)

### Migration 0001 — `account_types` (reference table, seeded)

Seeded from the GAS account schema. Contains all valid type + sub-type combinations.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK |
| `type` | `TEXT NOT NULL` | `asset`, `investment`, `liability` |
| `sub_type` | `TEXT NOT NULL` | e.g. `current`, `crypto`, `mortgage` |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` | Consistent with all other tables |
| `created_at` | `TIMESTAMPTZ NOT NULL` | When the seed row was inserted — provide `now()` explicitly in each seed INSERT (no `DEFAULT` on this column) |
| `deleted_at` | `TIMESTAMPTZ` | Set if sub-type is retired |

`UNIQUE (type, sub_type)`

`is_deleted` and `deleted_at` are for manual retirement only — the extract job never writes to this table after the initial seed. To retire a sub-type, update the row directly via a new migration or manual SQL. Retiring a sub-type does not immediately remove existing join rows pointing to it — those are cleaned up only when the referencing category is next modified in the sheet (triggering the changed-row path which deletes and re-inserts all join rows). No `updated_at` column — since the extract job never updates this table after the initial seed, there is nothing to track; any direct SQL retirement is a one-time manual act.

Seed data from GAS `account-schema.gs`:

| type | sub_type |
|---|---|
| `asset` | `current`, `savings`, `cash` |
| `investment` | `stocks_shares`, `isa`, `pension_sipp`, `crypto`, `fixed_deposit`, `bonds`, `property`, `commodities`, `p2p_lending`, `other` |
| `liability` | `personal_loan`, `credit_card`, `mortgage`, `auto_loan`, `heloc`, `student_loan`, `medical_loan`, `debt_consolidation`, `overdraft` |

---

### Migration 0002 — `category_master`

| Column | Sheet type | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | — | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `tx_type` | enum string | `TEXT NOT NULL` | Natural key part 1 — transform must raise a hard error if value is not one of `money-in`, `money-out`, `money-transfer` |
| `major_category` | string | `TEXT NOT NULL` | Natural key part 2 |
| `minor_category` | string | `TEXT NOT NULL` | Natural key part 3 |
| `description` | string | `TEXT` | |
| `is_active` | boolean string | `BOOLEAN NOT NULL` | Transform must always supply value — raise a hard error if the sheet cell is empty or `None` |
| `tag_keywords` | string | `TEXT` | |
| `counterparty_examples` | string | `TEXT` | |
| `source_account_mandatory` | boolean string | `BOOLEAN NOT NULL` | Transform must always supply value — raise a hard error if the sheet cell is empty or `None` |
| `target_account_mandatory` | boolean string | `BOOLEAN NOT NULL` | Transform must always supply value — raise a hard error if the sheet cell is empty or `None` |
| `workflow_type` | enum string | `VARCHAR(100) NOT NULL` | CHECK constraint — see below. Transform must always supply value; raise a hard error if empty, not a recognised enum value, or not a valid combination with the row's `tx_type` (see composite CHECK table above) |
| `is_subscription_eligible` | boolean string | `BOOLEAN NOT NULL DEFAULT FALSE` | If sheet cell is empty or None, transform defaults to `FALSE` |
| `row_hash` | — | `TEXT NOT NULL` | SHA-256 of source row content |
| `is_deleted` | — | `BOOLEAN NOT NULL DEFAULT FALSE` | Soft-delete flag |
| `created_at` | — | `TIMESTAMPTZ NOT NULL` | When this row was first written by the extract job |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL` | When this row was last updated by the extract job |
| `deleted_at` | — | `TIMESTAMPTZ` | Set when soft-deleted |

Constraints:
- `UNIQUE (tx_type, major_category, minor_category)` — natural key
- `CHECK (source_account_mandatory = TRUE OR target_account_mandatory = TRUE)` — at least one account side must be mandatory. Transform must validate this before inserting — raise a hard error if both are `False` (Python bool, after type conversion)
- Composite CHECK enforcing valid `tx_type` × `workflow_type` combinations:

```sql
CHECK (
    (tx_type = 'money-in'       AND workflow_type = 'account-credit') OR
    (tx_type = 'money-out'      AND workflow_type IN ('account-debit', 'debt-repayment')) OR
    (tx_type = 'money-transfer' AND workflow_type IN ('funds-transfer', 'forex-transfer'))
)
```

Valid combinations:

| `tx_type` | `workflow_type` |
|-----------|----------------|
| `money-in` | `account-credit` |
| `money-out` | `account-debit` |
| `money-out` | `debt-repayment` |
| `money-transfer` | `funds-transfer` |
| `money-transfer` | `forex-transfer` |

This replaces two separate single-column CHECKs — the composite covers all invalid values implicitly.

Note: `source_account_types` and `target_account_types` are **not** columns on this table — they are represented by the two join tables below.

---

### Migration 0003 — `category_source_account_types` and `category_target_account_types` (join tables)

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

**Zero-row guard:** If the sheet tab returns 0 rows, abort the job run with an error — do not proceed to the soft-delete pass and do not continue with subsequent entities. An empty read (cleared tab, wrong tab name, permissions error) must never trigger a full wipe of all categories.

**Hash input:** All 13 source columns in schema order (including `source_account_types` and `target_account_types` — token-normalised per section below before being included in `ordered_values`), using the canonical `|`-separated format defined in SETUP.md. Column order: `tx_type`, `major_category`, `minor_category`, `description`, `is_active`, `tag_keywords`, `counterparty_examples`, `source_account_mandatory`, `target_account_mandatory`, `workflow_type`, `is_subscription_eligible`, `source_account_types`, `target_account_types`.

**Token normalisation for `source_account_types` / `target_account_types`:** Before including these fields in `ordered_values` for the hash:
- If `raw is None`, empty (`""`), or whitespace-only — pass `""` directly (skip normalisation)
- Otherwise — `",".join(sorted(t.strip() for t in raw.split(",") if t.strip()))` (empty tokens from doubled/trailing commas are discarded)

This ensures `"asset,investment"` and `"investment,asset"` produce the same hash.

**Natural key encoding in `ledger_data_checksums`:** `{tx_type}|{major_category}|{minor_category}`

**Natural key constraint:** `|` is a prohibited character in `tx_type`, `major_category`, and `minor_category`. After stripping whitespace (for validation only — raw values are used for key construction and hash computation), each field must also be non-empty — raise a hard error if any is empty or whitespace-only. The extractor enforces both checks before constructing the natural key (see per-row pass step 1) — a silent corruption is worse than a failed run.

**source/target account type mapping:** The sheet stores comma-separated type strings (e.g. `"asset,investment"`). Expansion algorithm:
0. If the raw field value is `None`, empty, or whitespace-only, skip the expansion — produce zero join rows without any WARNING
1. Split on `,`, strip whitespace from each token; discard empty strings (these arise from trailing or doubled commas — silently ignored, not warned)
2. For each token: `SELECT id FROM account_types WHERE type = $1 AND is_deleted = FALSE`
3. Collect all matching IDs — these become the join table rows
4. If a token matches 0 rows in `account_types`: log a `WARNING` (include entity, natural key, and the unmatched token) and skip that token — do not fail the row

The expansion algorithm is invoked separately for each field — results for `source_account_types` insert into `category_source_account_types`; results for `target_account_types` insert into `category_target_account_types`. Insert `(category_id, account_type_id)` into the appropriate join table for each collected ID using `ON CONFLICT DO NOTHING` — duplicate tokens within the same cell (e.g. `"asset,asset"`) produce the same set of join rows as the deduplicated form; the hash is computed from the raw cell value so a later correction would be detected as a changed row. When the source data becomes more granular (type+sub_type), the query tightens to `WHERE type = $1 AND sub_type = $2` — no schema change required.

**Upsert logic:**

**Error handling policy:** "Hard error" throughout means raise an exception and abort the job run — do not silently skip the row. The sheet must be fixed before re-running. The only exception is the known DB inconsistency case (RETURNING id returns 0 rows), which explicitly rolls back and skips to the next row (documented per path). Any unexpected psycopg2 exception from a DB write should propagate — do not catch it — it will abort the job run. (The expansion algorithm's token-not-found case in step 4 above is a WARNING, not a hard error, and is governed by its own documented behaviour — not this policy.)

**Duplicate natural key guard:** If two rows in the sheet share the same natural key `(tx_type, major_category, minor_category)`, the first occurrence is processed normally. Every subsequent duplicate is skipped with a `WARNING` (entity, natural_key logged) — do not raise a hard error. The first occurrence's data is preserved; the user must fix the sheet. Because the duplicate is skipped (not added to `seen_keys` a second time), the soft-delete pass will not soft-delete the row.

Per-row pass (for each row read from sheet):
0. Call the transform on the raw sheet row: validate all column-level fields (`tx_type` enum membership; `is_active`, `source_account_mandatory`, `target_account_mandatory` — raise a hard error if empty or `None`; `is_subscription_eligible` — default to `FALSE` if empty or `None`; `workflow_type` value and `tx_type` combination; source/target mandatory combination) and produce the typed dict plus the SHA-256 hash of the 13 source columns (the transform assembles `ordered_values` from raw sheet strings — see Hash format in SETUP.md). If any validation fails, raise an exception and abort the job run. This step must complete before adding anything to `seen_keys`.
1. Validate `tx_type`, `major_category`, `minor_category`: after stripping whitespace, each must be non-empty and must not contain `|` — raise a hard error if any check fails (see Natural key constraint above). For `major_category` and `minor_category` (free text): strip whitespace for validation only — use raw values for hash computation, natural key construction, and DB insert. For `tx_type` (enum): the natural key and DB insert use the stripped (post-validation) value — equivalent to raw, since any leading/trailing whitespace would have already caused an enum validation failure in step 0. Compute natural key: `{tx_type}|{major_category}|{minor_category}` — immediately add to `seen_keys` **before** any DB write for this row
2. Look up `(entity='categories', natural_key)` in `ledger_data_checksums`
   - If found and hash matches — update `last_seen_at = now()` in `ledger_data_checksums` and commit before moving to the next row (a rollback by a subsequent row must not undo this update); skip (natural key already in `seen_keys` from step 1 — do not defer this add or unchanged rows will be soft-deleted)
   - If not found (new row, or resurrected after prior soft-delete) — **within a single transaction**: `INSERT INTO category_master (tx_type, major_category, minor_category, description, is_active, tag_keywords, counterparty_examples, source_account_mandatory, target_account_mandatory, workflow_type, is_subscription_eligible, row_hash, is_deleted, created_at, updated_at) VALUES (...all typed transform fields..., $hash, FALSE, now(), now()) ON CONFLICT (tx_type, major_category, minor_category) DO UPDATE SET is_deleted = FALSE, deleted_at = NULL, description = EXCLUDED.description, is_active = EXCLUDED.is_active, tag_keywords = EXCLUDED.tag_keywords, counterparty_examples = EXCLUDED.counterparty_examples, source_account_mandatory = EXCLUDED.source_account_mandatory, target_account_mandatory = EXCLUDED.target_account_mandatory, workflow_type = EXCLUDED.workflow_type, is_subscription_eligible = EXCLUDED.is_subscription_eligible, row_hash = EXCLUDED.row_hash, updated_at = now() RETURNING id`; `DELETE FROM category_source_account_types WHERE category_id = <returned id>`; `DELETE FROM category_target_account_types WHERE category_id = <returned id>`; run the expansion algorithm above for both `source_account_types` and `target_account_types` within the same transaction (expansion SELECTs run inside the transaction) and insert the resulting `(category_id, account_type_id)` pairs into the respective join tables; `INSERT INTO ledger_data_checksums (entity, natural_key, row_hash, last_seen_at) VALUES ('categories', $natural_key, $hash, now())`
   - If found and hash differs (changed row) — **within a single transaction**: run `UPDATE category_master SET description = $description, is_active = $is_active, tag_keywords = $tag_keywords, counterparty_examples = $counterparty_examples, source_account_mandatory = $source_account_mandatory, target_account_mandatory = $target_account_mandatory, workflow_type = $workflow_type, is_subscription_eligible = $is_subscription_eligible, row_hash = $hash, updated_at = now() WHERE tx_type = $1 AND major_category = $2 AND minor_category = $3 RETURNING id`; if no row returned (DB inconsistency), log error, rollback the transaction, and continue to the next row; `DELETE FROM category_source_account_types WHERE category_id = <returned id>`; `DELETE FROM category_target_account_types WHERE category_id = <returned id>`; run the expansion algorithm within the same transaction and re-insert the resulting `(category_id, account_type_id)` pairs into the respective join tables; `UPDATE ledger_data_checksums SET row_hash = $hash, last_seen_at = now() WHERE entity = 'categories' AND natural_key = $natural_key`

Soft-delete pass (after all sheet rows processed):
3. Query `SELECT natural_key FROM ledger_data_checksums WHERE entity = 'categories'` — diff against `seen_keys`, an in-memory `set[str]` accumulated during the per-row pass (one entry added per sheet row: `{tx_type}|{major_category}|{minor_category}`)
4. For each key present in DB but absent from sheet — **within a single transaction**:
   - Parse the natural key back into parts: split `{tx_type}|{major_category}|{minor_category}` on `|`
   - Resolve to `category_id`: `UPDATE category_master SET is_deleted = TRUE, deleted_at = now(), updated_at = now() WHERE tx_type = $1 AND major_category = $2 AND minor_category = $3 RETURNING id`; if no row returned (DB inconsistency), log error, rollback the transaction, and skip — leave the `ledger_data_checksums` row intact. This is a permanently stuck state: every subsequent run will hit the same missing `category_master` row and skip again. Manual intervention is required: investigate the root cause, then `DELETE FROM ledger_data_checksums WHERE entity = 'categories' AND natural_key = '<key>'`
   - `DELETE FROM category_source_account_types WHERE category_id = <returned id>`
   - `DELETE FROM category_target_account_types WHERE category_id = <returned id>`
   - `DELETE FROM ledger_data_checksums WHERE entity = 'categories' AND natural_key = $natural_key`

---

## What to build

- [x] `migrations/0001_create_account_types.py` — table + seed data
- [x] `migrations/0002_create_category_master.py`
- [x] `migrations/0003_create_category_account_type_joins.py`
- [x] `migrations/0007_create_extract_hashes.py` — shared infrastructure, built as part of this first entity
- [x] `migrations/0008_create_job_state.py` — shared infrastructure, built as part of this first entity
- [x] `transforms/categories.py` — row dict → typed dict + SHA-256 hash
- [x] `database/categories.py` — category_master upsert + explicit join table deletes/inserts
- [x] `database/ledger_data_checksums.py` — read/write ledger_data_checksums for categories
- [x] `database/job_execution_details.py` — Phase 1 bootstrap/read and Phase 3 UPSERT
- [x] Wire into `core/extractor.py`
