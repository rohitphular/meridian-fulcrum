# TASK — transactions

**Status:** IN PROGRESS
**Build order:** 3 of 4 — depends on categories (category_id FK), accounts (source/target account FK), and counterparty_master (counterparty_id FK)
**External dependency:** `currency-rates` TASK-xau-decimal-places.md must be applied first — migrations 0003 (XAU `decimal_places = 9`), 0004 (`minor_unit_name` column), and 0005 (`rate_value NUMERIC(19,8)`) must all be applied before this job runs
**Pending:** new migrations (counterparty_master, beneficiaries_master, transaction_beneficiaries); 0005_create_transactions.py schema update; transforms and database layers need full rewrite to sync_status model

---

## Open questions

None — all design decisions confirmed.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | Worksheet tab name | `'transactions'` |
| Q2 | Row identity | Sheet carries an `id` column whose value maps directly to `transaction_master.transaction_id TEXT NOT NULL UNIQUE`. The extract reads identity from the sheet — it does not compute or derive it. `transaction_id` is stable across edits; it does not change when data fields are modified. |
| Q3 | `tx_date_time` format | `YYYY-MM-DDTHH:MM` (ISO 8601, no seconds, no timezone suffix). Sheet stores UTC. Parsed with `datetime.fromisoformat()` and stored directly as `tx_date_time_base TIMESTAMPTZ`. `tx_date_time_local` is derived at extract time by converting `tx_date_time_base` to `tx_timezone_local`. |
| Q4 | `day_of_week` derived column | YES — PostgreSQL ENUM `day_of_week_enum` (MONDAY … SUNDAY), computed at extract time from `tx_date_time_base` (UTC) and `tx_date_time_local` (local) using `_DAY_NAMES[weekday()]`. |
| Q5 | FK on `source_account` / `target_account` | Stored as `source_account_id UUID` / `target_account_id UUID` FK → `account_master(id)`. Extract resolves sheet account name → UUID via a preloaded `account_name_map`. If name not found, logs a warning and stores NULL; does not fail the row. |
| Q6 | Currency / FX columns | `tx_amount_local` (from `amount`), `tx_currency_local` (from `currency`) — original values. `tx_amount_base` / `tx_currency_base` — XAU equivalent, computed at extract time from `currency_rates` table. Sheet `fx_rate` column is present but intentionally ignored by the extract. If no rate found in `currency_rates`, the row is marked `sync-failure`. |
| Q7 | `tx_description` naming | `description` renamed to `tx_description` to make scope explicit. |
| Q8 | `amount` sign convention | `tx_amount_local > 0` enforced by CHECK — sign is conveyed by `tx_type`. |
| Q9 | Soft-delete pattern | `transaction_master` uses `tx_status` (see Q16) for lifecycle management — no `is_deleted` / `deleted_at` columns. Lookup and junction-adjacent tables (`counterparty_master`, `beneficiaries_master`) retain the standard `is_deleted BOOLEAN NOT NULL DEFAULT FALSE` + `deleted_at TIMESTAMPTZ` soft-delete pattern consistent with `category_master`. |
| Q10 | Location columns | `user_location_area/city/country` (where user physically is) stays on `transaction_master`. `user_location_latitude` and `user_location_longitude` exist in DB but are manually enriched — never written by the extract. Counterparty location moves to `counterparty_master` — see Q14. |
| Q11 | Timezone handling | User travels, so local timezone changes per transaction. Sheet column `tx_timezone` holds an IANA timezone name (e.g. `Asia/Kolkata`, `America/New_York`); optional, defaults to `Europe/London` when blank. `tx_timezone_local TEXT NOT NULL` stores the resolved IANA name. `tx_date_time_local TIMESTAMP` is derived by converting `tx_date_time_base` (UTC) to `tx_timezone_local` — it is not a sheet column. `tx_timezone_base TEXT NOT NULL` is always `'UTC'`. |
| Q12 | Currency rate sourcing | `tx_amount_base` / `tx_currency_base` / `local_to_base_currency_rate_ref` resolved via `_resolve_currency_rate`: looks up the local currency row in `currency_rates` on `rate_date = tx_date_time_base.date()`. `tx_amount_base` is computed as integer nanograms — `tx_amount_local` (local minor units) × `10^9` (XAU factor) ÷ (`rate_value` × local minor unit factor), rounded `ROUND_HALF_UP` to the nearest integer. `tx_currency_base = 'XAU'`; `local_to_base_currency_rate_ref = cr_local.id`. All currencies including GBP go through this lookup — no shortcut. All three columns are `NOT NULL` — if no rate found, row is marked `sync-failure` and not written to DB. |
| Q13 | Beneficiaries | Tracked via two new tables: `beneficiaries_master` (person registry, soft-deleteable) and `transaction_beneficiaries` (junction, hard-deleted and re-inserted on `update-pending`). Sheet column `beneficiaries` supports optional percentages: `"Alice:60;Bob:40"` or equal-split shorthand `"Alice;Bob"`. `split_percentage NUMERIC(7,4)` stored per junction row — extract computes equal shares when not specified. Split amount = `tx_amount_base * (split_percentage / 100)` at query time. Percentages must sum to 100 — validated in extract, not SQL. |
| Q14 | Counterparty normalisation | Counterparties extracted to `counterparty_master`. `counterparty_key` is derived from `counterparty_name` only (no location fields — those are manually enriched in the DB and never written by the extract). Key derivation: strip non-alphanumeric characters (except spaces), trim, uppercase, replace spaces with underscores, collapse consecutive underscores. If `counterparty_name` is blank → `counterparty_id = NULL`. If provided, a `counterparty_master` record is always created or reactivated via upsert — never left unresolved. `counterparty_label` updated to latest value on every upsert. `transaction_master` stores `counterparty_id UUID FK → counterparty_master(id)`. |
| Q15 | Change detection and sync | Sheet carries `sync_status` column with values `create-pending`, `update-pending`, `in-sync`, `sync-failure`. Extract processes only `create-pending` and `update-pending`; skips all other values. On success: writes `in-sync` to `sync_status` and clears `sync_notes`. On failure: writes `sync-failure` to `sync_status` and writes the failure reason to `sync_notes`. Row index tracking is required during the sheet read. No row hashing; no checksums table. |
| Q16 | Transaction lifecycle status | `transaction_master` carries `tx_status TEXT NOT NULL DEFAULT 'active'` with values `active`, `deleted`, `locked`. Extract always sets `active` on every write. `deleted` is set externally (manually or by a future process) to mark a record for removal. `locked` is set by a separate archival process (to be built later) that runs periodically to finalise old transactions — it hard-deletes all `deleted` records then marks remaining `active` records as `locked`. The extract refuses to modify `locked` or `deleted` records — any `update-pending` row whose DB record is `locked` or `deleted` is written as `sync-failure`. Use `tx_status` and `updated_at` for lifecycle queries; there is no `is_deleted` / `deleted_at` on this table. |

---

## Source schema (20 columns from sheet)

Columns shown in sheet order. Names reflect the post-rename state (after Required changes are applied).

| Column | Sheet type | Notes |
|--------|-----------|-------|
| `id` | string | Required — row identity; maps directly to `transaction_master.transaction_id` |
| `sync_status` | string | `create-pending`, `update-pending`, `in-sync`, `sync-failure`; extract writes result after processing |
| `sync_notes` | string | Optional — failure reason written by the extract on `sync-failure`; cleared on success |
| `tx_date_time` | `YYYY-MM-DDTHH:MM` string | Required — stored in UTC; maps to `tx_date_time_base` |
| `tx_timezone` | string | Optional — IANA timezone name (e.g. `Asia/Kolkata`); defaults to `Europe/London` when blank; used to derive `tx_date_time_local` |
| `tx_type` | enum string | `money-in`, `money-out`, `money-transfer` |
| `source_account` | string | Account name; empty for `money-in`; resolved to UUID at extract |
| `target_account` | string | Account name; empty for `money-out`; resolved to UUID at extract |
| `user_location_area` | string | Optional — neighbourhood/district where user physically is (renamed from `tx_location_area`) |
| `user_location_city` | string | Optional — city where user physically is (renamed from `tx_location_city`) |
| `user_location_country` | string | Optional — country where user physically is (renamed from `tx_location_country`) |
| `amount` | number string | In `currency` units; maps to `tx_amount_local` |
| `currency` | string | 3-char code; maps to `tx_currency_local` |
| `fx_rate` | decimal string | Present in sheet — intentionally ignored by the extract |
| `major_category` | string | Not stored on `transaction_master` — used for `category_id` lookup |
| `minor_category` | string | Not stored on `transaction_master` — used for `category_id` lookup |
| `tx_tags` | string | Semicolon-separated; stored as-is (renamed from `tags`) |
| `beneficiaries` | string | Required — semicolon-separated names with optional percentages; drives `beneficiaries_master` + `transaction_beneficiaries`; blank is `sync-failure: beneficiary_required` |
| `counterparty_name` | string | Optional — normalised to `counterparty_key`; resolved to `counterparty_id` FK via `counterparty_master` |
| `description` | string | Optional; maps to `tx_description` |

---

## Required changes to the sheet

| Change | Column | Action |
|--------|--------|--------|
| Add | `sync_status` | New column — `create-pending` / `update-pending` / `in-sync` / `sync-failure`; extract writes result after processing |
| Add | `sync_notes` | New column — failure reason written by extract on `sync-failure`; cleared on success |
| Add | `tx_timezone` | New column after `tx_date_time` — IANA timezone name (e.g. `Asia/Kolkata`); leave blank to default to `Europe/London` |
| Rename | `tx_location_area` → `user_location_area` | Rename column header |
| Rename | `tx_location_city` → `user_location_city` | Rename column header |
| Rename | `tx_location_country` → `user_location_country` | Rename column header |
| Rename | `tags` → `tx_tags` | Rename column header |
| Add | `beneficiaries` | New column — semicolon-separated names with optional percentages (e.g. `Alice:60;Bob:40` or `Alice;Bob` for equal split) |

Columns unchanged: `id`, `tx_date_time`, `tx_type`, `source_account`, `target_account`, `amount`, `currency`, `fx_rate`, `major_category`, `minor_category`, `counterparty_name`, `description`.

---

## DB schema — `transaction_master` table

Prerequisites: `day_of_week_enum` type created in migration before the table.

| Column | Type | Constraints | Mapped to sheet column | Notes |
|--------|------|-------------|------------------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | — | Surrogate PK; generated |
| `transaction_id` | `TEXT NOT NULL` | UNIQUE | `id` | Sheet-supplied identity; not computed by the extract |
| `tx_date_time_base` | `TIMESTAMPTZ NOT NULL` | | `tx_date_time` | Sheet already stores UTC value — no conversion required |
| `tx_date_time_local` | `TIMESTAMP NOT NULL` | | — | Not a sheet column — computed by converting `tx_date_time_base` from UTC to `tx_timezone_local` |
| `tx_timezone_base` | `TEXT NOT NULL` | `CHECK (tx_timezone_base = 'UTC')` | — | Always `'UTC'` — explicit for clarity |
| `tx_timezone_local` | `TEXT NOT NULL` | | `tx_timezone` | IANA timezone name; `Europe/London` when sheet column blank |
| `tx_day_of_week_base` | `day_of_week_enum NOT NULL` | | — | Derived from `tx_date_time_base` (UTC) |
| `tx_day_of_week_local` | `day_of_week_enum NOT NULL` | | — | Derived from `tx_date_time_local` (local) |
| `tx_type` | `TEXT NOT NULL` | `CHECK (tx_type IN ('money-in', 'money-out', 'money-transfer'))` | `tx_type` | |
| `source_account_id` | `UUID` | FK → `account_master(id)` | `source_account` | Name lookup → UUID; NULL for `money-in` or unresolved |
| `target_account_id` | `UUID` | FK → `account_master(id)` | `target_account` | Name lookup → UUID; NULL for `money-out` or unresolved |
| `tx_amount_base` | `BIGINT NOT NULL` | `CHECK (tx_amount_base > 0)` | — | XAU nanograms (dp=9); unit name `'nanogram'` from `currency_master.minor_unit_name`; computed via `currency_rates` and `currency_master`; row marked `sync-failure` if rate not found |
| `tx_amount_local` | `BIGINT NOT NULL` | `CHECK (tx_amount_local > 0)` | `amount` | Local currency minor units; unit name from `currency_master.minor_unit_name` (e.g. `pence` for GBP, `satoshi` for BTC) |
| `tx_currency_base` | `TEXT NOT NULL` | `CHECK (tx_currency_base = 'XAU')` | — | Always `'XAU'` |
| `tx_currency_local` | `TEXT NOT NULL` | `CHECK (char_length(tx_currency_local) = 3 AND tx_currency_local = upper(tx_currency_local))` | `currency` | Original currency |
| `local_to_base_currency_rate_ref` | `UUID NOT NULL` | FK → `currency_rates(id)` | — | References the local-currency row in `currency_rates` |
| `counterparty_id` | `UUID` | FK → `counterparty_master(id)` | `counterparty_name` | Resolved via upsert; NULL only when `counterparty_name` is blank or normalises to empty |
| `user_location_area` | `TEXT` | | `user_location_area` | Optional — where user physically is |
| `user_location_city` | `TEXT` | | `user_location_city` | Optional |
| `user_location_country` | `TEXT` | | `user_location_country` | Optional |
| `user_location_latitude` | `NUMERIC(10, 6)` | `CHECK (user_location_latitude BETWEEN -90 AND 90)` | — | Not a sheet column — manually enriched in DB; never written by the extract |
| `user_location_longitude` | `NUMERIC(10, 6)` | `CHECK (user_location_longitude BETWEEN -180 AND 180)` | — | Not a sheet column — manually enriched in DB; never written by the extract |
| `tx_tags` | `TEXT` | | `tx_tags` | Semicolon-separated raw string |
| `tx_description` | `TEXT` | | `description` | Optional |
| `category_id` | `UUID` | FK → `category_master(id)` | `major_category` + `minor_category` | Lookup → UUID; NULL if no match |
| `tx_status` | `TEXT NOT NULL DEFAULT 'active'` | `CHECK (tx_status IN ('active', 'deleted', 'locked'))` | — | `active` = normal; `deleted` = marked for removal by archival process; `locked` = finalised by archival process; extract always sets `active` on write; refuses to modify `locked` or `deleted` records |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | — | Set on INSERT; preserved across updates |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | — | Set to `now()` on every write |

Additional constraint:
- `CHECK ((user_location_latitude IS NULL AND user_location_longitude IS NULL) OR (user_location_latitude IS NOT NULL AND user_location_longitude IS NOT NULL))`

---

## DB schema — `counterparty_master` table

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | Surrogate PK |
| `counterparty_key` | `TEXT NOT NULL` | UNIQUE | Normalised identity — derived from `counterparty_name` only; trimmed, uppercased, spaces → underscores |
| `counterparty_label` | `TEXT NOT NULL` | | Display name — updated to the latest value on every upsert |
| `location_area` | `TEXT` | | Optional — manually enriched in DB; never written by the extract |
| `location_city` | `TEXT` | | Optional — manually enriched in DB; never written by the extract |
| `location_country` | `TEXT` | | Optional — manually enriched in DB; never written by the extract |
| `location_latitude` | `NUMERIC(10, 6)` | `CHECK (location_latitude BETWEEN -90 AND 90)` | Optional — manually enriched in DB; never written by the extract |
| `location_longitude` | `NUMERIC(10, 6)` | `CHECK (location_longitude BETWEEN -180 AND 180)` | Optional — manually enriched in DB; never written by the extract |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` | | Soft-delete flag |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `deleted_at` | `TIMESTAMPTZ` | | Set on soft-delete |

Constraints:
- `CHECK ((is_deleted = FALSE AND deleted_at IS NULL) OR (is_deleted = TRUE AND deleted_at IS NOT NULL))`
- `CHECK ((location_latitude IS NULL AND location_longitude IS NULL) OR (location_latitude IS NOT NULL AND location_longitude IS NOT NULL))`

**Key derivation:** Strip non-alphanumeric characters (except spaces) from `counterparty_name`, trim, uppercase, replace spaces with `_`, collapse consecutive underscores. Examples: `"McDonald's"` → `MCDONALDS`; `"Tesco Express"` → `TESCO_EXPRESS`; `"M&S"` → `MS`. If `counterparty_name` is blank → `counterparty_id = NULL`; does not fail the row. If `counterparty_name` normalises to an empty string (e.g. `"&&&"`) → log a warning, set `counterparty_id = NULL`; does not fail the row.

---

## DB schema — `beneficiaries_master` table

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | Surrogate PK |
| `beneficiary_name` | `TEXT NOT NULL` | UNIQUE | Name exactly as it appears in the sheet |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` | | Soft-delete flag |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `deleted_at` | `TIMESTAMPTZ` | | Set on soft-delete |

Constraints:
- `CHECK ((is_deleted = FALSE AND deleted_at IS NULL) OR (is_deleted = TRUE AND deleted_at IS NOT NULL))`

---

## DB schema — `transaction_beneficiaries` table

Junction between `transaction_master` and `beneficiaries_master`. No soft-delete — rows are hard-deleted and re-inserted on `update-pending`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | Surrogate PK |
| `transaction_ref` | `UUID NOT NULL` | FK → `transaction_master(id)` | References the surrogate PK, not the TEXT `transaction_id` |
| `beneficiary_id` | `UUID NOT NULL` | FK → `beneficiaries_master(id)` | |
| `split_percentage` | `NUMERIC(7, 4) NOT NULL` | `CHECK (split_percentage > 0 AND split_percentage <= 100)` | Share of the transaction for this beneficiary; extract computes equal shares when not specified in sheet |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |

Constraints:
- `UNIQUE (transaction_ref, beneficiary_id)` — no duplicate beneficiaries per transaction
- Percentages per transaction must sum to 100 — enforced at application level in the extract, not SQL

**Sheet syntax:** `beneficiaries` column supports optional percentages — `"Alice:60;Bob:40"`. If no percentages given (e.g. `"Alice;Bob"`), extract computes equal shares (`100 / COUNT`).

**Query pattern — split amount per person:**
```sql
SELECT t.transaction_id, bm.beneficiary_name,
       (t.tx_amount_base * tb.split_percentage / 100)::BIGINT AS per_person_amount_nanogram
FROM transaction_master t
JOIN transaction_beneficiaries tb ON tb.transaction_ref = t.id
JOIN beneficiaries_master bm ON bm.id = tb.beneficiary_id
```
`per_person_amount_nanogram` is in XAU nanograms (dp=9). Divide by `10^9` at display time to get XAU major units (grams).

---

## Extract behaviour

**Prerequisites:** `categories`, `accounts`, and `currency_rates` must be populated before transactions run. `counterparty_master`, `beneficiaries_master`, and `transaction_beneficiaries` tables must exist (migrations 0006–0008).

**Zero-row guard:** if sheet returns 0 rows total, raise `RuntimeError` — prevents accidental full wipe.

**Row read:** sheet rows are read with their index positions so the extract can write `sync_status` and `sync_notes` back to the correct cells after processing.

**Preloads at job startup:**
- `account_name → account_master.id` map (non-deleted accounts only)
- `currency_decimal_places`: `currency_code → decimal_places` map from `currency_master` (all rows) — used to convert raw decimal amounts to integer minor units for both local currency and XAU
- `currency_minor_unit_names`: `currency_code → minor_unit_name` map from `currency_master` (all rows) — available for log messages and error reporting; loaded from the same query as `currency_decimal_places`

**Write-back on success:** `sync_status = 'in-sync'`, `sync_notes = ''`

**Write-back on failure:** `sync_status = 'sync-failure'`, `sync_notes = <reason string>`

---

### Per-row pass

Iterate rows in sheet order. For each row:

- If `id` is blank → log a warning and skip; no write-back
- If `sync_status` not in `{create-pending, update-pending}` → skip

**Validation (both statuses before processing):**
- `tx_date_time` required; must parse as ISO datetime → on failure: `sync-failure`
- `tx_type` required; must be `money-in`, `money-out`, or `money-transfer` → on failure: `sync-failure`
- `amount` required; must be a valid positive decimal → on failure: `sync-failure`
- `currency` required; normalised to `raw_currency.strip().upper()` before any validation or lookup — lowercase input is silently corrected, not failed; must be exactly 3 characters after normalisation → on failure: `sync-failure`; must exist in the preloaded `currency_decimal_places` map → on failure: `sync-failure: currency_not_found_in_currency_master`
- `tx_type = 'money-transfer'`: if either `source_account` or `target_account` is blank → `sync-failure: money_transfer_missing_account`; user must fix the sheet
- `beneficiaries` required; if blank → `sync-failure: beneficiary_required`

**Datetime computation:**
- `tx_timezone_local` = `raw_tx_timezone.strip()` if non-blank, else `'Europe/London'`
- Validate `tx_timezone_local` via `ZoneInfo(tx_timezone_local)` — unrecognised IANA name → `sync-failure`; blank is always safe (defaults to `'Europe/London'` before validation)
- `tx_timezone_base` = `'UTC'` — always
- `tx_date_time_base` = `datetime.fromisoformat(raw_tx_date_time.strip()).replace(tzinfo=ZoneInfo(tx_timezone_base))` — `fromisoformat` on a no-suffix string returns a naive datetime; `.replace(tzinfo=ZoneInfo(tx_timezone_base))` marks it as UTC without shifting the value
- `tx_date_time_local` = `tx_date_time_base.astimezone(ZoneInfo(tx_timezone_local)).replace(tzinfo=None)` — stored as naive `TIMESTAMP`
- `tx_day_of_week_base` = `_DAY_NAMES[tx_date_time_base.weekday()]`
- `tx_day_of_week_local` = `_DAY_NAMES[tx_date_time_local.weekday()]`

---

#### create-pending

1. Validate and transform the row (datetime, timezone, amount, currency, tx_type)
2. Resolve `tx_amount_base` / `tx_currency_base` / `local_to_base_currency_rate_ref` — on failure write `sync-failure` and skip; do not write to DB
3. Resolve `counterparty_id` (see counterparty resolution below)
4. Resolve `source_account_id` / `target_account_id` from preloaded map; NULL if not found. For `money-transfer`: if either resolves to NULL (blank or name not in `account_name_map`) → `sync-failure: money_transfer_missing_account`; do not proceed
5. Resolve `category_id`: look up `(tx_type, major_category, minor_category)` in `category_master`; NULL if no match; log warning
6. `INSERT INTO transaction_master (transaction_id, tx_status, ...) RETURNING id` — `transaction_id` = sheet `id` value; `tx_status = 'active'`; do not write `user_location_latitude` or `user_location_longitude`; the returned surrogate `id` is required as `transaction_ref` in step 7
7. Resolve and insert beneficiaries (see beneficiary resolution below)
8. Commit
9. Write `in-sync` to `sync_status`, clear `sync_notes`

On any failure — whether a raised exception or a controlled failure (e.g. `money_transfer_missing_account` at step 4, or a beneficiary validation failure at step 7) — call `conn.rollback()` before writing `sync-failure` to the sheet and moving to the next row. Steps 3 onwards write to the open transaction; without an explicit rollback those writes bleed into the next row's commit. **Exception — UNIQUE violation on `transaction_id`:** if the INSERT fails with a unique constraint violation, do not write `sync-failure`; instead fall through to the `update-pending` path (fetch original `created_at`, delete + re-insert). This handles the case where a previous run committed successfully but the sheet write-back failed, leaving the row stuck on `create-pending`. Implementation note: in psycopg2, after any constraint violation the transaction is in an aborted state — no further SQL can run until a rollback or savepoint rollback. The INSERT must be wrapped in a `SAVEPOINT`; on `UniqueViolation` rollback to the savepoint (not the full transaction) before executing the update-pending SELECT + delete + re-insert.

---

#### update-pending

1. Look up `transaction_master.id` (surrogate PK), `tx_status`, and `created_at` WHERE `transaction_id = sheet_id`
   - Not found → `sync-failure: transaction_not_found`; skip
   - `tx_status = 'locked'` → `sync-failure: transaction_locked`; skip
   - `tx_status = 'deleted'` → `sync-failure: transaction_deleted`; skip
2. `DELETE FROM transaction_beneficiaries WHERE transaction_ref = <surrogate id>`
3. `DELETE FROM transaction_master WHERE transaction_id = sheet_id`
4. Follow `create-pending` path from step 1 (re-insert fresh with same `transaction_id`, `tx_status = 'active'`); use the original `created_at` fetched in step 1 — do not set `created_at = now()`

All steps run inside a single DB transaction. On any exception **or** controlled failure (e.g. currency rate not found in step 4's re-insert) after step 2 has begun, the entire block — including the DELETEs in steps 2 and 3 — must be rolled back before writing `sync-failure` to the sheet. Never leave the DB with the transaction deleted but the re-insert incomplete.

---

### Resolution functions

**`counterparty_id` resolution:**
If `counterparty_name` is blank → `counterparty_id = NULL`; skip. Otherwise derive `counterparty_key` from `counterparty_name` only: strip non-alphanumeric characters (except spaces), trim, uppercase, replace spaces with `_`, collapse consecutive underscores. If the resulting key is empty (e.g. input was `"&&&"`) → log a warning, set `counterparty_id = NULL`. Otherwise upsert — a counterparty entry is always created if the name is provided:

```sql
INSERT INTO counterparty_master (counterparty_key, counterparty_label, created_at, updated_at)
VALUES (%s, %s, now(), now())
ON CONFLICT (counterparty_key) DO UPDATE SET
    counterparty_label = EXCLUDED.counterparty_label,
    is_deleted         = FALSE,
    deleted_at         = NULL,
    updated_at         = now()
RETURNING id
```

All location fields on `counterparty_master` (`location_area`, `location_city`, `location_country`, `location_latitude`, `location_longitude`) are manually enriched — the extract never writes them.

**`tx_amount_base` / `tx_currency_base` / `local_to_base_currency_rate_ref` resolution:**

Amounts are stored as integers in currency minor units. Minor unit factor for any currency = `10 ^ decimal_places` from the preloaded `currency_decimal_places` map.

Step 1 — convert raw sheet amount to local minor units:
```python
local_dp   = currency_decimal_places[tx_currency_local]   # e.g. 2 for GBP
local_factor = Decimal(10 ** local_dp)                    # e.g. 100
tx_amount_local = int(
    (Decimal(raw_amount.strip()) * local_factor)
    .quantize(Decimal('1'), rounding=ROUND_HALF_UP)
)
# e.g. "10.50" GBP → 1050 pence
```

Step 2 — look up rate and compute XAU nanograms:
Look up the local currency row in `currency_rates` on `rate_date = tx_date_time_base.date()`. `rate_value` = how many local major units equal 1 XAU (e.g. 76.0 GBP per XAU at current gold prices).
```python
xau_dp     = currency_decimal_places['XAU']               # always 9
xau_factor = Decimal(10 ** xau_dp)                        # 1_000_000_000
tx_amount_base = int(
    (Decimal(tx_amount_local) * xau_factor /
     (Decimal(str(cr_local.rate_value)) * local_factor))
    .quantize(Decimal('1'), rounding=ROUND_HALF_UP)
)
# e.g. 1050 pence at 76 GBP/XAU → 138_157_895 nanograms
```

`tx_currency_base = 'XAU'`; `local_to_base_currency_rate_ref = cr_local.id`. All currencies including GBP go through this lookup — no shortcut. If no rate found, write `sync-failure` with reason `"currency_rate_not_found: {currency} on {date}"` and skip the row — do not insert or update the transaction.

**Beneficiary resolution:**
Parse `raw_beneficiaries` by splitting on `';'` and stripping whitespace. Names are stored as-is (strip only, no case normalisation) — `"Alice"` and `"alice"` are distinct records. Each entry is either `"Name"` or `"Name:percentage"`. All entries must follow the same form — mixing is not allowed:
- If entries are inconsistent (some have a percentage, some do not, e.g. `"Alice:60;Bob"`) → `sync-failure: beneficiary_inconsistent_percentage_format`
- If any percentage is present but non-numeric → `sync-failure: beneficiary_invalid_percentage`
- If no percentages given, compute equal shares: `100 / COUNT` rounded to 4 dp, with remainder assigned to the last entry so they sum exactly to `100.0000` (e.g. 3 people → `33.3333, 33.3333, 33.3334`)
- If explicit percentages given, validate they sum to `100` (±0.01 tolerance) — if not → `sync-failure: beneficiary_percentages_do_not_sum_to_100`

For each non-empty name, upsert into `beneficiaries_master`:

```sql
INSERT INTO beneficiaries_master (beneficiary_name, created_at, updated_at)
VALUES (%s, now(), now())
ON CONFLICT (beneficiary_name) DO UPDATE SET
    is_deleted = FALSE,
    deleted_at = NULL,
    updated_at = now()
RETURNING id
```

Then insert junction rows:

```sql
INSERT INTO transaction_beneficiaries (transaction_ref, beneficiary_id, split_percentage, created_at)
VALUES (%s, %s, %s, now())
```

All beneficiary writes are in the same commit as the parent transaction.

---

### Post-row soft-delete passes

Run after all rows are processed. Both passes filter on `tx_status = 'active'` to exclude transactions marked for deletion — those references will be cleared when the archival process runs. Each pass must be committed after execution.

**`counterparty_master` soft-delete pass:**
```sql
UPDATE counterparty_master SET is_deleted = TRUE, deleted_at = now(), updated_at = now()
WHERE id NOT IN (
    SELECT DISTINCT counterparty_id FROM transaction_master
    WHERE tx_status = 'active' AND counterparty_id IS NOT NULL
)
AND is_deleted = FALSE
```
Commit after this UPDATE.

**`beneficiaries_master` soft-delete pass:**
```sql
UPDATE beneficiaries_master SET is_deleted = TRUE, deleted_at = now(), updated_at = now()
WHERE id NOT IN (
    SELECT DISTINCT tb.beneficiary_id
    FROM transaction_beneficiaries tb
    JOIN transaction_master tm ON tm.id = tb.transaction_ref
    WHERE tm.tx_status = 'active'
)
AND is_deleted = FALSE
```
Commit after this UPDATE.

---

## What to build

**New migrations (not yet created):**
- [ ] `migrations/0006_create_counterparty_master.py`
- [ ] `migrations/0007_create_beneficiaries_master.py`
- [ ] `migrations/0008_create_transaction_beneficiaries.py`

**Updates to existing files:**
- [ ] `migrations/0005_create_transactions.py` — rename table to `transaction_master`; drop `row_hash`, `is_deleted`, `deleted_at`; replace flat counterparty columns with `counterparty_id UUID FK → counterparty_master(id)`; add `tx_timezone_base TEXT NOT NULL CHECK (= 'UTC')`; add `tx_timezone_local TEXT NOT NULL`; add `user_location_latitude/longitude NUMERIC(10,6)` nullable with range CHECKs and pair consistency constraint; change `tx_amount_local` and `tx_amount_base` from `NUMERIC(19,6)` to `BIGINT NOT NULL`; update `chk_transactions_tx_amount_base` from `(tx_amount_base IS NULL OR tx_amount_base > 0)` to `(tx_amount_base > 0)`; remove `chk_transactions_base_consistency` (both columns are now NOT NULL); make `tx_currency_base`, `local_to_base_currency_rate_ref` NOT NULL; fix `tx_currency_base CHECK` to `= 'XAU'`; add `tx_status TEXT NOT NULL DEFAULT 'active' CHECK (tx_status IN ('active', 'deleted', 'locked'))`; remove soft-delete consistency CHECK
- [ ] `transforms/transactions.py` — full rewrite: read `id`, `sync_status`, `tx_timezone`, `user_location_area/city/country`, `beneficiaries` from sheet; ignore `fx_rate`; no hash computation; parse `tx_date_time` as UTC directly into `tx_date_time_base`; derive `tx_date_time_local` by converting to `tx_timezone_local` and stripping tzinfo; validate timezone via `ZoneInfo`; pass all fields through for DB layer
- [ ] `database/transactions.py` — full rewrite: sync_status model (`create-pending` / `update-pending`); add `_resolve_counterparty` (name-only key, always upsert, never write location fields); add `_resolve_beneficiaries` (parse, validate, equal-split rounding, upsert junction); rewrite `_resolve_currency_rate` for XAU using integer minor-unit arithmetic (preloaded `currency_decimal_places`, `ROUND_HALF_UP`, no GBP shortcut; `sync-failure` on rate miss or currency not in `currency_master`); remove `ledger_data_checksums` usage; write `in-sync` / `sync-failure` + `sync_notes` back to sheet; never write `user_location_latitude/longitude`; add counterparty and beneficiary soft-delete passes (filtered on `tx_status = 'active'`); use `transaction_master` table name throughout
- [ ] `core/extractor.py` — pass `sheets_client` into `upsert_transactions` so the DB layer can write sync results back to the sheet; confirm sheet client supports indexed cell writes
