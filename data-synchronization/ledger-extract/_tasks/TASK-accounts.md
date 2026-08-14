# TASK — accounts

**Status:** OPEN
**Build order:** 2 of 4 — no dependencies on other entities

---

## Open questions

None — all design decisions confirmed.

---

## Source schema (10 columns)

| Column | Sheet type | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | string | `TEXT` | Natural key (UNIQUE constraint) |
| `name` | string | `TEXT` | |
| `type` | enum string | `TEXT` | `asset`, `investment`, `liability` |
| `sub_type` | string | `TEXT` | e.g. `current`, `crypto`, `mortgage` |
| `currency` | string | `TEXT` | 3-char code |
| `opening_value` | number string | `NUMERIC(19,6)` | |
| `current_value` | number string | `NUMERIC(19,6)` | Latest balance only — no history snapshots |
| `is_active` | boolean string | `BOOLEAN` | |
| `description` | string | `TEXT` | |
| `created_at` | date string | `TIMESTAMPTZ` | Stored as `account_created_at` — avoids collision with extract-added `created_at` |

Extended columns added by extract (all entities):

| Column | Type |
|--------|------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` |
| `row_hash` | `TEXT NOT NULL` |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` |
| `created_at` | `TIMESTAMPTZ NOT NULL` |
| `updated_at` | `TIMESTAMPTZ NOT NULL` |
| `deleted_at` | `TIMESTAMPTZ` |

Note: the sheet's `id` column becomes `account_id TEXT UNIQUE NOT NULL` in the DB — the surrogate `id UUID` is the PK.

---

## What to build

- [ ] `migrations/0004_create_accounts.py`
- [ ] `transforms/accounts.py` — row dict → typed dict + SHA-256 hash
- [ ] `database/accounts.py` — accounts upsert
- [ ] `database/ledger_data_checksums.py` — read/write ledger_data_checksums for accounts
- [ ] Wire into `core/extractor.py`
