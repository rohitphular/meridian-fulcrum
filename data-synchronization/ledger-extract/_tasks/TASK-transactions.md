# TASK — transactions

**Status:** OPEN
**Build order:** 3 of 4 — depends on categories (category_id FK) and accounts (if account FK enforced)

---

## Open questions

| # | Question | Blocks |
|---|----------|--------|
| Q1 | Exact worksheet tab name | `extractor.py` |
| Q2 | FK constraints on `source_account`, `target_account` → accounts? (category is now resolved via `category_id` UUID FK — that decision is made) | `0005_create_transactions.py` |
| Q3 | `tx_date_time` format in the sheet — confirm exact string format (e.g. `2024-01-15 14:32:00`, ISO 8601, other) so the transform parses it correctly | `transforms/transactions.py` |
| Q4 | Add a derived `day_of_week` column (e.g. `SMALLINT 0–6` or `TEXT` like `'Monday'`) computed from `tx_date_time` at extract time? Could be useful for spending-by-weekday analysis without recomputing at query time — discuss before building | `0005_create_transactions.py`, `transforms/transactions.py` |

---

## Source schema (14 columns)

| Column | Sheet type | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | string | `TEXT` | Natural key — format `YYYY-MM-DD-NNN` |
| `tx_date_time` | date string | `TIMESTAMPTZ` | See Q3 for format |
| `tx_type` | enum string | `TEXT NOT NULL` | `money-in`, `money-out`, `money-transfer` — kept on transactions; avoids a join for the most common filter |
| `source_account` | string | `TEXT` | Account `id` from GAS — FK or TEXT (see Q2) |
| `target_account` | string | `TEXT` | Account `id`, empty for non-transfers — FK or TEXT (see Q2) |
| `tx_location_area` | string | `TEXT` | Optional |
| `tx_location_city` | string | `TEXT` | Optional |
| `tx_location_country` | string | `TEXT` | Optional |
| `amount` | number string | `NUMERIC(19,6)` | In `currency` units |
| `currency` | string | `TEXT` | 3-char code |
| `fx_rate` | number string | `NUMERIC(19,6)` | Optional |
| `tags` | string | `TEXT` | Semicolons preserved |
| `counterparty_name` | string | `TEXT` | Optional |
| `description` | string | `TEXT` | Optional |

`major_category` and `minor_category` text columns are **not** stored — replaced by `category_id` below.

Extended columns added by extract:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `transaction_id` | `TEXT UNIQUE NOT NULL` | Sheet's `id` |
| `category_id` | `UUID` | FK → `categories.id`; nullable — transfers may have no category |
| `row_hash` | `TEXT NOT NULL` | SHA-256 of source row content |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` | Soft-delete flag |
| `created_at` | `TIMESTAMPTZ NOT NULL` | When this row was first written by the extract job |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | When this row was last updated by the extract job |
| `deleted_at` | `TIMESTAMPTZ` | Set when soft-deleted |

Constraints:
- `CHECK (tx_type IN ('money-in', 'money-out', 'money-transfer'))`
- `FOREIGN KEY (category_id) REFERENCES category_master(id)` — enforced; categories must be loaded before transactions

---

## Extract behaviour

**Hash input:** All 14 source columns concatenated deterministically (including the raw `major_category` and `minor_category` text from the sheet — they feed the hash even though they are not stored as columns).

**category_id resolution:** At transform time, look up `categories.id` using `(tx_type, major_category, minor_category)` from the sheet. If no match is found, log a warning and set `category_id = NULL`. This will not fail the upsert — categories must be run before transactions in every extract cycle.

---

## What to build

- [ ] `migrations/0005_create_transactions.py`
- [ ] `transforms/transactions.py` — row dict → typed dict + SHA-256 hash; parse `tx_date_time`; resolve `category_id`
- [ ] `database/upsert.py` — transactions upsert (add entity section)
- [ ] `database/hashes.py` — read/write extract_hashes for transactions
- [ ] Wire into `core/extractor.py` — ensure categories extract runs before transactions
