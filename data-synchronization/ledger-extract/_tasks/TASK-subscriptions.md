# TASK — subscriptions

**Status:** OPEN
**Build order:** 4 of 4 — depends on accounts and categories if FK constraints are added

---

## Open questions

| # | Question | Blocks |
|---|----------|--------|
| Q1 | Exact worksheet tab name | `extractor.py` |
| Q2 | FK constraints on `source_account` (→ accounts)? | `0006_create_subscriptions.py` |
| Q3 | Replace `tx_type`, `major_category`, `minor_category` text columns with `category_id UUID FK → category_master.id`, same as transactions — confirm and update schema before building | `0006_create_subscriptions.py` |

---

## Source schema (16 columns)

| Column | Sheet type | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | string | `TEXT` | Natural key |
| `name` | string | `TEXT` | |
| `counterparty_name` | string | `TEXT` | |
| `amount` | number string | `NUMERIC(19,6)` | |
| `currency` | string | `TEXT` | 3-char code |
| `frequency` | enum string | `TEXT` | `weekly`, `monthly`, `quarterly`, `annual` |
| `day_of_month` | number string | `INTEGER` | Optional |
| `day_of_week` | number string | `INTEGER` | Optional |
| `source_account` | string | `TEXT` | Account `id` — FK or TEXT (see Q2) |
| `tx_type` | enum string | `TEXT` | `money-in`, `money-out`, `money-transfer` |
| `major_category` | string | `TEXT` | FK or TEXT (see Q2) |
| `minor_category` | string | `TEXT` | FK or TEXT (see Q2) |
| `tags` | string | `TEXT` | Semicolons preserved |
| `is_active` | boolean string | `BOOLEAN` | |
| `description` | string | `TEXT` | |
| `created_at` | date string | `TIMESTAMPTZ` | Stored as `subscription_created_at` — avoids collision with extract-added `created_at` |

Extended columns added by extract (all entities):

| Column | Type |
|--------|------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` |
| `row_hash` | `TEXT NOT NULL` |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` |
| `created_at` | `TIMESTAMPTZ NOT NULL` |
| `updated_at` | `TIMESTAMPTZ NOT NULL` |
| `deleted_at` | `TIMESTAMPTZ` |

Note: the sheet's `id` becomes `subscription_id TEXT UNIQUE NOT NULL`.

---

## What to build

- [ ] `migrations/0006_create_subscriptions.py`
- [ ] `transforms/subscriptions.py` — row dict → typed dict + SHA-256 hash
- [ ] `database/subscriptions.py` — subscriptions upsert
- [ ] `database/ledger_data_checksums.py` — read/write ledger_data_checksums for subscriptions
- [ ] Wire into `core/extractor.py`
