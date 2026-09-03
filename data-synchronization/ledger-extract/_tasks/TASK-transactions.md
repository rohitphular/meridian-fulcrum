# TASK — transactions

**Status:** IN PROGRESS — schema and extract behaviour confirmed; implementation not yet started
**Build order:** 3 of 4 — depends on categories (category_id FK), accounts (account_id FK), and counterparty_master (counterparty_id FK)
**External dependency:** `currency-rates` TASK-currency-schema-enhancements.md must be applied first — migrations 0003 (XAU `decimal_places = 9`), 0004 (`minor_unit_name` column), and 0005 (`rate_value NUMERIC(19,8)`) must all be applied before this job runs

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
| Q5 | FK on `account_id` | `account_id UUID NOT NULL FK → account_master(id)`. Extract resolves the sheet `account_id` (natural key, e.g. `ACC-20240101-001`) to the account's surrogate UUID via a preloaded `account_map`. If the natural key is blank or not found in the map → `sync-failure: account_not_found`; does not proceed. Replaces the old `source_account` / `target_account` two-column model. A transfer is two rows: `money-out` row on the source account + `money-in` row on the target account, linked by `parent_tx_id`. |
| Q6 | Currency / FX columns | `local_currency` (DB column) is **derived from the resolved account's `local_currency`** — there is no `currency` sheet column. `tx_amount_local` (from `tx_amount`), `tx_amount_base` / `base_currency` / `currency_rate_ref` — XAU equivalent computed at extract time from `currency_rates` using the account's currency. No `fx_rate` sheet column. When `local_currency = 'XAU'` (XAU account): `tx_amount_base = tx_amount_local` (nanograms), no rate lookup, `currency_rate_ref = NULL`. For all other currencies: rate lookup on `rate_date = tx_date_time_base.date()`; if no rate found → `sync-failure`. |
| Q7 | `tx_description` naming | `description` renamed to `tx_description` to make scope explicit. |
| Q8 | `tx_amount` sign convention | `tx_amount_local > 0` enforced by CHECK — direction (money-in vs money-out) is encoded in `category_master.tx_type` via the mandatory `category_id`; no separate `tx_type` column on `transaction_master`. |
| Q9 | Soft-delete pattern | All primary entity tables — `transaction_master`, `counterparty_master`, `beneficiaries_master` — use `record_status TEXT NOT NULL DEFAULT 'active'` for lifecycle management, consistent with `account_master`. No `is_deleted` / `deleted_at` columns on any of them. The post-row soft-delete passes set `record_status = 'deleted'` on orphaned counterparties and beneficiaries. `transaction_beneficiaries` (junction) remains hard-delete only — rows are deleted and re-inserted on `update-pending`. |
| Q10 | Location columns | `user_location_area/city/country` (where user physically is) stays on `transaction_master`. `user_location_latitude` and `user_location_longitude` are **sheet columns** — the extract writes them when non-blank in the sheet row, and stores NULL when blank (user manually enriches in the sheet). Counterparty location moves to `counterparty_master` — see Q14. |
| Q11 | Timezone handling | User travels, so local timezone changes per transaction. Sheet column `tx_timezone` holds an IANA timezone name (e.g. `Asia/Kolkata`, `America/New_York`); optional, defaults to `Europe/London` when blank. `tx_timezone_local TEXT NOT NULL` stores the resolved IANA name. `tx_date_time_local TIMESTAMP` is derived by converting `tx_date_time_base` (UTC) to `tx_timezone_local` — it is not a sheet column. `tx_timezone_base TEXT NOT NULL` is always `'UTC'`. |
| Q12 | Currency rate sourcing | `tx_amount_base` / `base_currency` / `currency_rate_ref` resolved via `_resolve_currency_rate`: looks up the local currency row in `currency_rates` on `rate_date = tx_date_time_base.date()`. `tx_amount_base` is computed as integer nanograms — `tx_amount_local` (local minor units) × `10^9` (XAU factor) ÷ (`rate_value` × local minor unit factor), rounded `ROUND_HALF_UP` to the nearest integer. `base_currency = 'XAU'` always. For XAU accounts: `tx_amount_base = tx_amount_local`, `currency_rate_ref = NULL` (no rate needed). For all other currencies: `currency_rate_ref = cr_local.id` (NOT NULL); if no rate found → `sync-failure`. All currencies except XAU go through the rate lookup — no other shortcuts. |
| Q13 | Beneficiaries | Tracked via two new tables: `beneficiaries_master` (person registry, soft-deleteable) and `transaction_beneficiaries` (junction, hard-deleted and re-inserted on `update-pending`). Sheet column `beneficiaries` supports optional percentages: `"Alice:60;Bob:40"` or equal-split shorthand `"Alice;Bob"`. `split_percentage NUMERIC(7,4)` stored per junction row — extract computes equal shares when not specified. Split amount = `tx_amount_base * (split_percentage / 100)` at query time. Percentages must sum to 100 — validated in extract, not SQL. |
| Q14 | Counterparty normalisation | Counterparties extracted to `counterparty_master`. `counterparty_key` is derived from `counterparty_name` only (no location fields — those are manually enriched in the DB and never written by the extract). Key derivation: strip non-alphanumeric characters (except spaces), trim, uppercase, replace spaces with underscores, collapse consecutive underscores. If `counterparty_name` is blank → `counterparty_id = NULL`. If provided, a `counterparty_master` record is always created or reactivated via upsert — never left unresolved. `counterparty_label` updated to latest value on every upsert. `transaction_master` stores `counterparty_id UUID FK → counterparty_master(id)`. |
| Q15 | Change detection and sync | Sheet carries `sync_status` column with values `create-pending`, `update-pending`, `in-sync`, `sync-failure`. Extract processes only `create-pending` and `update-pending`; skips all other values. On success: writes `in-sync` to `sync_status`, sets `sync_date_time`, clears `sync_notes`, and writes `created_at` / `updated_at`. On failure: writes `sync-failure` to `sync_status`, sets `sync_date_time`, writes failure reason to `sync_notes`; does not write `created_at` / `updated_at`. Row index tracking is required during the sheet read. No row hashing; no checksums table. |
| Q16 | Transaction lifecycle status | `transaction_master` carries `record_status TEXT NOT NULL DEFAULT 'active'` with values `active`, `inactive`, `deleted`, `locked` — same pattern as `account_master`. The extract writes the sheet `record_status` value directly to the DB on every sync. The extract refuses to modify `locked` or `deleted` records — any `update-pending` row whose DB record is `locked` or `deleted` is written as `sync-failure`. `deleted` marks a record for removal; `locked` marks it as finalised by a separate archival process. Use `record_status` and `updated_at` for lifecycle queries; there is no `is_deleted` / `deleted_at` on this table. |
| Q17 | `parent_tx_id` | Optional field linking related transaction rows (e.g. two legs of a money-transfer, one row per account). If non-blank, the referenced `transaction_id` must already exist in `transaction_master` — the extract validates this via a DB lookup before inserting; if not found → `sync-failure: parent_tx_not_found`. Blank is valid — no constraint on when it must be set. Stored as `parent_tx_id TEXT` (nullable FK → `transaction_master(transaction_id)`, self-referential). |

---

## Source schema (24 columns from sheet)

Columns shown in actual sheet order.

| # | Column | Sheet type | Extract writes? | Notes |
|---|--------|-----------|-----------------|-------|
| 1 | `id` | string | No | Required — row identity; maps directly to `transaction_master.transaction_id` |
| 2 | `tx_date_time` | `YYYY-MM-DDTHH:MM` string | No | Required — stored in UTC; maps to `tx_date_time_base` |
| 3 | `tx_timezone` | string | No | Optional — IANA timezone name (e.g. `Asia/Kolkata`); defaults to `Europe/London` when blank; maps to `tx_timezone_local` |
| 4 | `parent_tx_id` | string | No | Optional — references another transaction's `id`; if non-blank must exist in `transaction_master.transaction_id`; blank is always valid; maps to `parent_tx_id TEXT` nullable FK → `transaction_master(transaction_id)` |
| 5 | `tx_type` | enum string | No | `money-in` or `money-out` only — a transfer is two rows linked by `parent_tx_id` |
| 6 | `account_id` | string | No | Required — account natural key (e.g. `ACC-20240101-001`); resolved to `account_master.id` via the preloaded account map; replaces the old `source_account` + `target_account` columns; currency is derived from the resolved account's `local_currency` — there is no separate `currency` column in the sheet |
| 7 | `tx_amount` | number string | No | Required — amount in the account's local currency major units; maps to `tx_amount_local`; previously named `amount` |
| 8 | `major_category` | string | No | Not stored on `transaction_master` — used for `category_id` lookup |
| 9 | `minor_category` | string | No | Not stored on `transaction_master` — used for `category_id` lookup |
| 10 | `description` | string | No | Optional; maps to `tx_description` |
| 11 | `counterparty_name` | string | No | Optional — normalised to `counterparty_key`; resolved to `counterparty_id` FK via `counterparty_master` |
| 12 | `tx_tags` | string | No | Semicolon-separated; stored as-is on `transaction_master.tx_tags` |
| 13 | `beneficiaries` | string | No | Required — semicolon-separated names with optional percentages (e.g. `Alice:60;Bob:40`); drives `beneficiaries_master` + `transaction_beneficiaries`; blank is `sync-failure: beneficiary_required` |
| 14 | `user_location_area` | string | No | Optional — neighbourhood/district where user physically is; maps to `transaction_master.user_location_area` |
| 15 | `user_location_city` | string | No | Optional; maps to `transaction_master.user_location_city` |
| 16 | `user_location_country` | string | No | Optional; maps to `transaction_master.user_location_country` |
| 17 | `user_location_latitude` | decimal string | No | Optional — sheet column (old doc incorrectly marked this as DB-only); maps to `transaction_master.user_location_latitude`; must be paired with `user_location_longitude` |
| 18 | `user_location_longitude` | decimal string | No | Optional — sheet column (old doc incorrectly marked this as DB-only); maps to `transaction_master.user_location_longitude`; must be paired with `user_location_latitude` |
| 19 | `record_status` | enum string | No | `active`, `inactive`, `deleted`, `locked` — extract writes sheet value directly to `transaction_master.record_status`; replaces old `tx_status` column (Q16) |
| 20 | `sync_status` | string | Yes | `create-pending`, `update-pending`, `in-sync`, `sync-failure`; extract writes result after processing |
| 21 | `sync_date_time` | ISO datetime string | Yes | Written by the extract on every sync attempt — separate column from `sync_notes`, mirroring the accounts module pattern |
| 22 | `sync_notes` | string | Yes | Failure reason written by the extract on `sync-failure`; cleared on success |
| 23 | `created_at` | ISO datetime string | Yes | Written by the extract on first successful sync; preserved across updates |
| 24 | `updated_at` | ISO datetime string | Yes | Written by the extract on every successful sync |

**Columns no longer in the sheet (present in old design, now removed):**
- `source_account` / `target_account` — replaced by single `account_id`
- `currency` — derived from account's `local_currency`; no longer a sheet column
- `fx_rate` — removed entirely (was previously "present in sheet, intentionally ignored")

---

## DB schema — `transaction_master` table

Prerequisites: `day_of_week_enum` type created in migration before the table. Column order mirrors the sheet column order.

| Column | Type | Constraints | Mapped to sheet column | Notes |
|--------|------|-------------|------------------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | — | Surrogate PK; generated |
| `transaction_id` | `TEXT NOT NULL` | UNIQUE | `id` | Sheet-supplied identity; not computed by the extract |
| `parent_tx_id` | `TEXT` | FK → `transaction_master(transaction_id)` | `parent_tx_id` | Optional — links related rows (e.g. two legs of a money-transfer); NULL when blank in sheet |
| `tx_date_time_base` | `TIMESTAMPTZ NOT NULL` | | `tx_date_time` | Sheet already stores UTC value — no conversion required |
| `tx_date_time_local` | `TIMESTAMP NOT NULL` | | — | Derived — `tx_date_time_base` converted to `tx_timezone_local`; stored naive |
| `tx_timezone_base` | `TEXT NOT NULL` | `CHECK (tx_timezone_base = 'UTC')` | — | Always `'UTC'` |
| `tx_timezone_local` | `TEXT NOT NULL` | | `tx_timezone` | IANA timezone name; `Europe/London` when sheet column blank |
| `tx_day_of_week_base` | `day_of_week_enum NOT NULL` | | — | Derived from `tx_date_time_base` (UTC) |
| `tx_day_of_week_local` | `day_of_week_enum NOT NULL` | | — | Derived from `tx_date_time_local` (local) |
| `category_id` | `UUID NOT NULL` | FK → `category_master(id)` | `tx_type` + `major_category` + `minor_category` | NOT NULL — sync-failure if no match; direction (money-in vs money-out) encoded in the matched category's own `tx_type` field; transfer rows are distinguished solely by linked `parent_tx_id`, not by a separate `tx_type` column |
| `account_id` | `UUID NOT NULL` | FK → `account_master(id)` | `account_id` | Sheet natural key resolved to surrogate UUID via preloaded map; `local_currency` derived from this account's `local_currency` |
| `tx_amount_local` | `BIGINT NOT NULL` | `CHECK (tx_amount_local > 0)` | `tx_amount` | Local currency minor units (e.g. pence for GBP, nanograms for XAU) |
| `tx_amount_base` | `BIGINT NOT NULL` | `CHECK (tx_amount_base > 0)` | — | XAU nanograms (dp=9); equals `tx_amount_local` for XAU accounts; computed via `currency_rates` for all others |
| `local_currency` | `TEXT NOT NULL` | `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))` | — | Derived from `account_id → account_master.local_currency`; not a direct sheet column |
| `base_currency` | `TEXT NOT NULL` | `CHECK (base_currency = 'XAU')` | — | Always `'XAU'` |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)` | — | NULL for XAU accounts (no rate needed); NOT NULL for all other currencies — constraint `chk_tm_rate_ref_required` enforces this |
| `tx_description` | `TEXT` | | `description` | Optional |
| `counterparty_id` | `UUID` | FK → `counterparty_master(id)` (added in migration 0006) | `counterparty_name` | Resolved via upsert; NULL only when `counterparty_name` is blank or normalises to empty |
| `tx_tags` | `TEXT` | | `tx_tags` | Semicolon-separated raw string |
| `user_location_area` | `TEXT` | | `user_location_area` | Optional |
| `user_location_city` | `TEXT` | | `user_location_city` | Optional |
| `user_location_country` | `TEXT` | | `user_location_country` | Optional |
| `user_location_latitude` | `NUMERIC(10, 6)` | `CHECK (user_location_latitude BETWEEN -90 AND 90)` | `user_location_latitude` | Optional — written by extract if non-blank in sheet; NULL otherwise |
| `user_location_longitude` | `NUMERIC(10, 6)` | `CHECK (user_location_longitude BETWEEN -180 AND 180)` | `user_location_longitude` | Optional — written by extract if non-blank in sheet; NULL otherwise |
| `record_status` | `TEXT NOT NULL DEFAULT 'active'` | `CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))` | `record_status` | Extract writes sheet value directly; refuses to modify `locked` or `deleted` records on `update-pending` |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | `created_at` | Written by extract on first successful sync; preserved across updates |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | `updated_at` | Written by extract on every successful sync |

**Constraint names** — abbreviation `tm` used for all `transaction_master` constraints:

```
pk_tm                    PRIMARY KEY (id)
uq_tm_transaction_id     UNIQUE (transaction_id)
fk_tm_parent_tx          FOREIGN KEY (parent_tx_id) REFERENCES transaction_master(transaction_id)
fk_tm_account            FOREIGN KEY (account_id) REFERENCES account_master(id)
fk_tm_rate_ref           FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)
fk_tm_counterparty       FOREIGN KEY (counterparty_id) REFERENCES counterparty_master(id)  -- added in migration 0006
fk_tm_category           FOREIGN KEY (category_id) REFERENCES category_master(id)
chk_tm_record_status     CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))
chk_tm_tx_amount_base    CHECK (tx_amount_base > 0)
chk_tm_tx_amount_local   CHECK (tx_amount_local > 0)
chk_tm_base_currency  CHECK (base_currency = 'XAU')
chk_tm_local_currency CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))
chk_tm_tx_timezone_base  CHECK (tx_timezone_base = 'UTC')
chk_tm_rate_ref_required CHECK ((local_currency = 'XAU' AND currency_rate_ref IS NULL) OR (local_currency != 'XAU' AND currency_rate_ref IS NOT NULL))
chk_tm_location_pair     CHECK ((user_location_latitude IS NULL AND user_location_longitude IS NULL) OR (user_location_latitude IS NOT NULL AND user_location_longitude IS NOT NULL))
chk_tm_location_lat      CHECK (user_location_latitude BETWEEN -90 AND 90)
chk_tm_location_lon      CHECK (user_location_longitude BETWEEN -180 AND 180)
```

17 constraints total.

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
| `record_status` | `TEXT NOT NULL DEFAULT 'active'` | `CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))` | Lifecycle — extract sets `active` on every upsert (reactivates if previously deleted) |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |

Constraints:
- `CHECK ((location_latitude IS NULL AND location_longitude IS NULL) OR (location_latitude IS NOT NULL AND location_longitude IS NOT NULL))`

**Key derivation:** Strip non-alphanumeric characters (except spaces) from `counterparty_name`, trim, uppercase, replace spaces with `_`, collapse consecutive underscores. Examples: `"McDonald's"` → `MCDONALDS`; `"Tesco Express"` → `TESCO_EXPRESS`; `"M&S"` → `MS`. If `counterparty_name` is blank → `counterparty_id = NULL`; does not fail the row. If `counterparty_name` normalises to an empty string (e.g. `"&&&"`) → log a warning, set `counterparty_id = NULL`; does not fail the row.

---

## DB schema — `beneficiaries_master` table

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK | Surrogate PK |
| `beneficiary_name` | `TEXT NOT NULL` | UNIQUE | Name exactly as it appears in the sheet |
| `beneficiary_details` | `TEXT` | | Optional — manually enriched by the user; never written by the extract |
| `record_status` | `TEXT NOT NULL DEFAULT 'active'` | `CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))` | Lifecycle — extract sets `active` on every upsert (reactivates if previously deleted) |
| `created_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | | Extract-managed |

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

**Preloads at job startup** (loaded ONCE per batch before the per-row loop, not per-row or per-currency):
- `account_id → (account_master.id, local_currency)` map (accounts with `record_status NOT IN ('deleted', 'locked')` only):
  ```sql
  SELECT account_id, id, local_currency FROM account_master
  WHERE record_status NOT IN ('deleted', 'locked')
  ```
  `account_map: dict[str, tuple[UUID, str]]` — maps natural key → (surrogate id, local_currency). Used to resolve `account_id` and derive `local_currency` in one lookup.
- `currency_decimal_places` and `currency_minor_unit_names` — loaded from a **single query**:
  ```sql
  SELECT currency_code, decimal_places, minor_unit_name FROM currency_master
  ```
  `currency_decimal_places = {row[0]: row[1] for row in rows}` — used to convert raw decimal amounts to integer minor units for both local currency and XAU.
  `currency_minor_unit_names = {row[0]: row[2] for row in rows}` — available for log messages and error reporting.

**Write-back on success:** `sync_status = 'in-sync'`, `sync_date_time = <now ISO>`, `sync_notes = ''`, `created_at = <original or now ISO>`, `updated_at = <now ISO>` (5 columns starting at `sync_status` col position)

**Write-back on failure:** `sync_status = 'sync-failure'`, `sync_date_time = <now ISO>`, `sync_notes = <reason string>` (3 columns only — `created_at` / `updated_at` are not written on failure)

---

### Per-row pass

Iterate rows in sheet order. For each row:

- If `id` is blank → log a warning and skip; no write-back
- If `sync_status` not in `{create-pending, update-pending}` → skip

**Validation (both statuses before processing):**
- `tx_date_time` required; must parse as ISO datetime → on failure: `sync-failure`
- `tx_type` required; must be `money-in` or `money-out` → on failure: `sync-failure`
- `account_id` required; must exist in the preloaded `account_map` → on failure: `sync-failure: account_not_found`; `local_currency` is taken from the matched account's `local_currency`
- `tx_amount` required; must be a valid positive decimal → on failure: `sync-failure`
- `record_status` required; must be `active`, `inactive`, `deleted`, or `locked` → on failure: `sync-failure`
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

1. Validate and transform the row (datetime, timezone, tx_amount, tx_type, record_status)
2. Resolve `account_id` from preloaded `account_map` — if blank or not found → `sync-failure: account_not_found`; `local_currency` is taken from the matched account's `local_currency`
3. If `parent_tx_id` is non-blank, verify it exists in `transaction_master.transaction_id` via a DB lookup — if not found → `sync-failure: parent_tx_not_found`; do not proceed
4. Resolve `tx_amount_base` / `base_currency` / `currency_rate_ref` using `local_currency` from step 2 — on failure write `sync-failure` and skip; do not write to DB
5. Resolve `counterparty_id` (see counterparty resolution below)
6. Resolve `category_id`: look up `(tx_type, major_category, minor_category)` in `category_master`; if no match → `sync-failure: category_not_found`; do not proceed

```sql
SELECT id FROM category_master
WHERE tx_type = %s AND major_category = %s AND minor_category = %s
  AND record_status = 'active'
```
7. `INSERT INTO transaction_master (transaction_id, record_status, ...) RETURNING id` — `transaction_id` = sheet `id` value; `record_status` = sheet value; write `user_location_latitude` and `user_location_longitude` if non-blank in the sheet row, NULL otherwise; the returned surrogate `id` is required as `transaction_ref` in step 8
8. Resolve and insert beneficiaries (see beneficiary resolution below)
9. Commit
10. Write `in-sync` to `sync_status`, set `sync_date_time`, clear `sync_notes`, write `created_at` / `updated_at`

On any failure — whether a raised exception or a controlled failure (e.g. `account_not_found` at step 2, `parent_tx_not_found` at step 3, or a beneficiary validation failure at step 8) — call `conn.rollback()` before writing `sync-failure` to the sheet and moving to the next row. Steps 5 onwards write to the open transaction; without an explicit rollback those writes bleed into the next row's commit. **Exception — UNIQUE violation on `transaction_id`:** if the INSERT fails with a unique constraint violation, do not write `sync-failure`; instead fall through to the `update-pending` path (fetch original `created_at`, delete + re-insert). This handles the case where a previous run committed successfully but the sheet write-back failed, leaving the row stuck on `create-pending`. Implementation note: in psycopg2, after any constraint violation the transaction is in an aborted state — no further SQL can run until a rollback or savepoint rollback. The INSERT must be wrapped in a `SAVEPOINT`; on `UniqueViolation` rollback to the savepoint (not the full transaction) before executing the update-pending SELECT + delete + re-insert.

---

#### update-pending

1. Look up `transaction_master.id` (surrogate PK), `record_status`, and `created_at` WHERE `transaction_id = sheet_id`
   - Not found → `sync-failure: transaction_not_found`; skip
   - `record_status = 'locked'` → `sync-failure: transaction_locked`; skip
   - `record_status = 'deleted'` → `sync-failure: transaction_deleted`; skip
2. `DELETE FROM transaction_beneficiaries WHERE transaction_ref = <surrogate id>`
3. `DELETE FROM transaction_master WHERE transaction_id = sheet_id`
4. Follow `create-pending` path from step 1 (re-insert fresh with same `transaction_id`); use the original `created_at` fetched in step 1 — do not set `created_at = now()`

All steps run inside a single DB transaction. On any exception **or** controlled failure (e.g. currency rate not found in step 4's re-insert) after step 2 has begun, the entire block — including the DELETEs in steps 2 and 3 — must be rolled back before writing `sync-failure` to the sheet. Never leave the DB with the transaction deleted but the re-insert incomplete.

---

### Resolution functions

**`counterparty_id` resolution:**
If `counterparty_name` is blank → `counterparty_id = NULL`; skip. Otherwise derive `counterparty_key` from `counterparty_name` only: strip non-alphanumeric characters (except spaces), trim, uppercase, replace spaces with `_`, collapse consecutive underscores. If the resulting key is empty (e.g. input was `"&&&"`) → log a warning, set `counterparty_id = NULL`. Otherwise upsert — a counterparty entry is always created if the name is provided:

```sql
INSERT INTO counterparty_master (counterparty_key, counterparty_label, record_status, created_at, updated_at)
VALUES (%s, %s, 'active', now(), now())
ON CONFLICT (counterparty_key) DO UPDATE SET
    counterparty_label = EXCLUDED.counterparty_label,
    record_status      = 'active',
    updated_at         = now()
RETURNING id
```

All location fields on `counterparty_master` (`location_area`, `location_city`, `location_country`, `location_latitude`, `location_longitude`) are manually enriched — the extract never writes them.

**`tx_amount_base` / `base_currency` / `currency_rate_ref` resolution:**

`local_currency` is derived from the account lookup (create-pending step 2) — it is not read from the sheet. Amounts are stored as integers in currency minor units. Minor unit factor for any currency = `10 ^ decimal_places` from the preloaded `currency_decimal_places` map.

Step 1 — convert raw sheet amount to local minor units:
```python
local_dp = currency_decimal_places[local_currency]  # e.g. 2 for GBP, 9 for XAU
tx_amount_local = int(
    (Decimal(raw_amount.strip()) * Decimal(10) ** local_dp).to_integral_value(ROUND_HALF_UP)
)
# e.g. "10.50" GBP → 1050 pence; "0.000001" XAU → 1000 nanograms
```

If `tx_amount_local == 0` → `sync-failure: amount_rounds_to_zero_in_minor_units`; do not proceed. This catches valid positive decimals that round to zero minor units (e.g. `0.001 GBP` → 0 pence, `0.4 JPY` → 0 yen).

Step 2 — fetch the rate row:

```sql
SELECT id, rate_value FROM currency_rates
WHERE quote_currency_code = %s
  AND rate_date = %s
  AND base_currency_code = 'XAU'
```

Bind values: `(local_currency, tx_date_time_base.date())`. `rate_value` = how many local major units equal 1 XAU (e.g. 76.0 GBP per XAU gram). Returns `(rate_id, rate_value)` tuple. If no row returned → `sync-failure: currency_rate_not_found: {currency} on {date}`; do not proceed. `rate_value` is psycopg2's native `Decimal` — do not wrap in `Decimal(str(...))`.

Step 3 — compute XAU nanograms:

For XAU accounts (`local_currency = 'XAU'`): `tx_amount_base = tx_amount_local`; `currency_rate_ref = None`. No rate lookup needed.

For all other currencies:
```python
xau_dp = currency_decimal_places["XAU"]
if xau_dp != 9:
    raise ValueError(f"currency_master.decimal_places for XAU is {xau_dp}, expected 9")
if not isinstance(rate_value, Decimal):
    raise TypeError(f"_resolve_currency_rate: expected Decimal from psycopg2, got {type(rate_value).__name__}")
tx_amount_base = int(
    (Decimal(tx_amount_local) * Decimal(10) ** xau_dp / (rate_value * Decimal(10) ** local_dp))
    .to_integral_value(ROUND_HALF_UP)
)
# e.g. 1050 pence at 76 GBP/XAU → 138_157_895 nanograms
```

`base_currency = 'XAU'`; `currency_rate_ref = rate_id`. All currencies except XAU go through this lookup — no other shortcuts.

**Beneficiary resolution:**
Parse `raw_beneficiaries` by splitting on `';'` and stripping whitespace. Names are stored as-is (strip only, no case normalisation) — `"Alice"` and `"alice"` are distinct records. Each entry is either `"Name"` or `"Name:percentage"`. All entries must follow the same form — mixing is not allowed:
- If any entry is empty after stripping (e.g. `"Alice;;Bob"` produces `''`) → `sync-failure: beneficiary_empty_name`
- If entries are inconsistent (some have a percentage, some do not, e.g. `"Alice:60;Bob"`) → `sync-failure: beneficiary_inconsistent_percentage_format`
- If any percentage is present but non-numeric → `sync-failure: beneficiary_invalid_percentage`
- If any explicit percentage is ≤ 0 or > 100 → `sync-failure: beneficiary_invalid_percentage`
- If no percentages given, compute equal shares: `100 / COUNT` rounded to 4 dp, with remainder assigned to the last entry so they sum exactly to `100.0000` (e.g. 3 people → `33.3333, 33.3333, 33.3334`)
- If explicit percentages given, validate they sum to `100` (±0.01 tolerance) — if not → `sync-failure: beneficiary_percentages_do_not_sum_to_100`

For each non-empty name, upsert into `beneficiaries_master`:

```sql
INSERT INTO beneficiaries_master (beneficiary_name, record_status, created_at, updated_at)
VALUES (%s, 'active', now(), now())
ON CONFLICT (beneficiary_name) DO UPDATE SET
    record_status = 'active',
    updated_at    = now()
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

Run after all rows are processed. Both passes filter on `record_status = 'active'` to exclude transactions marked for deletion — those references will be cleared when the archival process runs. Each pass must be committed after execution.

**`counterparty_master` soft-delete pass:**
```sql
UPDATE counterparty_master SET record_status = 'deleted', updated_at = now()
WHERE id NOT IN (
    SELECT DISTINCT counterparty_id FROM transaction_master
    WHERE record_status = 'active' AND counterparty_id IS NOT NULL
)
AND record_status = 'active'
```
Commit after this UPDATE.

**`beneficiaries_master` soft-delete pass:**
```sql
UPDATE beneficiaries_master SET record_status = 'deleted', updated_at = now()
WHERE id NOT IN (
    SELECT DISTINCT tb.beneficiary_id
    FROM transaction_beneficiaries tb
    JOIN transaction_master tm ON tm.id = tb.transaction_ref
    WHERE tm.record_status = 'active'
)
AND record_status = 'active'
```
Commit after this UPDATE.

---

## Implementation patterns

These patterns are mandatory for the transactions implementation — derived from the accounts module.

**No `assert` statements anywhere.** All guards use explicit `if / raise`:
- psycopg2 Decimal adapter: `if not isinstance(rate_value, Decimal): raise TypeError(...)`
- XAU decimal_places: `if xau_dp != 9: raise ValueError(...)`
- INSERT RETURNING result: `if pk_row is None: raise RuntimeError(...)`

**Every INSERT with `RETURNING id` must capture and check the result before committing:**
```python
pk_row = cursor.fetchone()
if pk_row is None:
    raise RuntimeError(f"INSERT returned no id for transaction_id={natural_key}")
conn.commit()
```
Apply to: `transaction_master` INSERT, `beneficiaries_master` INSERT, `transaction_beneficiaries` INSERT.

**Every except chain must end with a bare `except Exception` rollback guard:**
```python
except (pg_errors.UniqueViolation, pg_errors.ForeignKeyViolation, ...) as e:
    conn.rollback()
    ...
except Exception:
    conn.rollback()
    raise
```
This ensures unexpected exceptions (network timeout, adapter errors) always close the open transaction before propagating.

**The per-row loop must be wrapped in `try / finally` to guarantee `flush()` always runs:**
```python
try:
    for row_index, row in enumerate(rows):
        ...
finally:
    sheets_transactions.flush(sheets_client, _SHEET_NAME, write_backs)
```

**`WriteBack` type alias must be typed precisely:**
```python
WriteBack = tuple[int, int, list[str]]
```

**`_to_sync_notes(e)` — DB constraint → human-readable `sync_notes` message mapping:**

`_to_sync_notes` receives psycopg2 integrity errors only — never `ValueError` (transform/validation errors are written directly as `sync-failure`, not via this function).

| Constraint / exception | `sync_notes` message |
|---|---|
| `UniqueViolation` on `uq_tm_transaction_id` | `"Duplicate transaction_id — already exists in DB"` |
| `ForeignKeyViolation` on `fk_tm_parent_tx` | `"parent_tx_id references a transaction that does not exist in DB — sync the parent row first"` |
| `ForeignKeyViolation` on `fk_tm_account` | `"account_id references an account that no longer exists"` |
| `ForeignKeyViolation` on `fk_tm_rate_ref` | `"Currency rate reference no longer exists in currency_rates"` |
| `ForeignKeyViolation` on `fk_tm_counterparty` | `"counterparty_id references a counterparty that no longer exists"` |
| `ForeignKeyViolation` on `fk_tm_category` | `"category_id references a category that no longer exists"` |
| `ForeignKeyViolation` — other | `f"DB FK violation: {constraint}"` |
| `CheckViolation` on `chk_tm_record_status` | `"Invalid record_status — must be active, inactive, deleted, or locked"` |
| `CheckViolation` on `chk_tm_tx_amount_local` | `"tx_amount_local must be > 0 — indicates a code bug; file a bug report"` |
| `CheckViolation` on `chk_tm_tx_amount_base` | `"tx_amount_base must be > 0 — indicates a code bug; file a bug report"` |
| `CheckViolation` on `chk_tm_base_currency` | `"base_currency must be XAU — indicates a code bug; file a bug report"` |
| `CheckViolation` on `chk_tm_local_currency` | `"local_currency must be a 3-character uppercase ISO code — indicates a code bug; file a bug report"` |
| `CheckViolation` on `chk_tm_tx_timezone_base` | `"tx_timezone_base must be UTC — indicates a code bug; file a bug report"` |
| `CheckViolation` on `chk_tm_rate_ref_required` | `"currency_rate_ref constraint violated — indicates a code bug in the extract job; file a bug report"` |
| `CheckViolation` — other | `f"DB constraint violation: {constraint}"` |
| `NotNullViolation` | `f"Required field is null: {e.diag.column_name} — indicates a code bug; file a bug report"` |
| Unknown type | `raise TypeError(f"_to_sync_notes: unhandled exception type {type(e).__name__}")` |

---

## What to build

**New migrations (not yet created):**

- [ ] `migrations/0006_create_counterparty_master.py`

```sql
CREATE TABLE IF NOT EXISTS counterparty_master (
    id                    UUID            NOT NULL DEFAULT gen_random_uuid(),
    counterparty_key      TEXT            NOT NULL,
    counterparty_label    TEXT            NOT NULL,
    location_area         TEXT,
    location_city         TEXT,
    location_country      TEXT,
    location_latitude     NUMERIC(10, 6),
    location_longitude    NUMERIC(10, 6),
    record_status         TEXT            NOT NULL DEFAULT 'active',
    created_at            TIMESTAMPTZ     NOT NULL,
    updated_at            TIMESTAMPTZ     NOT NULL,

    CONSTRAINT pk_counterparty_master              PRIMARY KEY (id),
    CONSTRAINT uq_counterparty_master_key          UNIQUE (counterparty_key),
    CONSTRAINT chk_counterparty_master_status      CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked')),
    CONSTRAINT chk_counterparty_master_location_lat  CHECK (location_latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_counterparty_master_location_lon  CHECK (location_longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_counterparty_master_location_pair CHECK ((location_latitude IS NULL AND location_longitude IS NULL) OR (location_latitude IS NOT NULL AND location_longitude IS NOT NULL))
);

-- FK deferred from migration 0005: transaction_master exists now, counterparty_master just created
ALTER TABLE transaction_master
    ADD CONSTRAINT fk_tm_counterparty
    FOREIGN KEY (counterparty_id) REFERENCES counterparty_master(id);
```

- [ ] `migrations/0007_create_beneficiaries_master.py`

```sql
CREATE TABLE IF NOT EXISTS beneficiaries_master (
    id                   UUID            NOT NULL DEFAULT gen_random_uuid(),
    beneficiary_name     TEXT            NOT NULL,
    beneficiary_details  TEXT,
    record_status        TEXT            NOT NULL DEFAULT 'active',
    created_at           TIMESTAMPTZ     NOT NULL,
    updated_at           TIMESTAMPTZ     NOT NULL,

    CONSTRAINT pk_beneficiaries_master         PRIMARY KEY (id),
    CONSTRAINT uq_beneficiaries_master_name    UNIQUE (beneficiary_name),
    CONSTRAINT chk_beneficiaries_master_status CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))
);
```

- [ ] `migrations/0008_create_transaction_beneficiaries.py` — depends on `transaction_master` (0005) and `beneficiaries_master` (0007)

```sql
CREATE TABLE IF NOT EXISTS transaction_beneficiaries (
    id                UUID            NOT NULL DEFAULT gen_random_uuid(),
    transaction_ref   UUID            NOT NULL,
    beneficiary_id    UUID            NOT NULL,
    split_percentage  NUMERIC(7, 4)   NOT NULL,
    created_at        TIMESTAMPTZ     NOT NULL,

    CONSTRAINT pk_transaction_beneficiaries             PRIMARY KEY (id),
    CONSTRAINT fk_transaction_beneficiaries_transaction FOREIGN KEY (transaction_ref) REFERENCES transaction_master(id),
    CONSTRAINT fk_transaction_beneficiaries_beneficiary FOREIGN KEY (beneficiary_id) REFERENCES beneficiaries_master(id),
    CONSTRAINT uq_transaction_beneficiaries_pair        UNIQUE (transaction_ref, beneficiary_id),
    CONSTRAINT chk_transaction_beneficiaries_split_pct  CHECK (split_percentage > 0 AND split_percentage <= 100)
);
```

**Updates to existing files:**
- [ ] `migrations/0005_create_transactions.py` — **Approach: rewrite from scratch.** Name all constraints using the `tm` abbreviation — see constraint names block in the DB schema section above. Add `DROP TABLE IF EXISTS transactions` at the top (handles the case where the old migration already ran), then rewrite to `CREATE TABLE IF NOT EXISTS transaction_master` with all correct columns in the sheet-mirrored order (see DB schema section). Preserve the existing `day_of_week_enum` DO block unchanged. Do not layer ALTER statements on top. Changes vs the current table definition: rename table to `transaction_master`; drop `row_hash`, `is_deleted`, `deleted_at`, `source_account_id`, `target_account_id`; add `account_id UUID NOT NULL` FK → `account_master(id)`; add `parent_tx_id TEXT` nullable self-referential FK → `transaction_master(transaction_id)`; replace flat counterparty columns with `counterparty_id UUID` nullable — **no FK constraint here** (FK added in migration 0006 after `counterparty_master` exists); add `tx_timezone_base TEXT NOT NULL CHECK (tx_timezone_base = 'UTC')`; add `tx_timezone_local TEXT NOT NULL`; add `user_location_latitude/longitude NUMERIC(10,6)` nullable with range CHECKs and pair consistency constraint; change `tx_amount_local` and `tx_amount_base` from `NUMERIC(19,6)` to `BIGINT NOT NULL`; rename `tx_currency_local` → `local_currency`, `tx_currency_base` → `base_currency`, `local_to_base_currency_rate_ref` → `currency_rate_ref`; `currency_rate_ref UUID` is now nullable (NULL for XAU accounts); add `chk_tm_rate_ref_required` to enforce nullability rules; no `tx_type` column — direction is encoded in the category; add `category_id UUID NOT NULL` FK → `category_master(id)` in the position `tx_type` occupied (after `tx_day_of_week_local`, before `account_id`); add `record_status TEXT NOT NULL DEFAULT 'active' CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))` replacing the old `tx_status` column
- [ ] `transforms/transactions.py` — full rewrite: read all 24 sheet columns — `id`, `tx_date_time`, `tx_timezone`, `parent_tx_id`, `tx_type`, `account_id`, `tx_amount`, `major_category`, `minor_category`, `description`, `counterparty_name`, `tx_tags`, `beneficiaries`, `user_location_area/city/country/latitude/longitude`, `record_status`; no `currency`, `fx_rate`, `source_account`, `target_account`; no hash computation; parse `tx_date_time` as UTC into `tx_date_time_base`; derive `tx_date_time_local` by converting to `tx_timezone_local` and stripping tzinfo; validate timezone via `ZoneInfo`; pass all fields through for DB layer
- [ ] `database/transactions.py` — full rewrite: sync_status model (`create-pending` / `update-pending`); preload `account_map: dict[str, tuple[UUID, str]]` (account_id → surrogate id + local_currency); add `_resolve_counterparty` (name-only key, always upsert with `record_status = 'active'`; never write location fields); add `_resolve_beneficiaries` (parse, validate, equal-split rounding, upsert with `record_status = 'active'`); rewrite `_resolve_currency_rate` for XAU using integer minor-unit arithmetic — XAU shortcut: `tx_amount_base = tx_amount_local`, `currency_rate_ref = None`; non-XAU: rate lookup on `rate_date = tx_date_time_base.date()`, `sync-failure` on miss; `local_currency` derived from account map, not from sheet; `category_id` is NOT NULL — category lookup on `(tx_type, major_category, minor_category)` must succeed; no match → `sync-failure: category_not_found`; write `user_location_latitude/longitude` when non-blank; soft-delete passes set `record_status = 'deleted'` (not `is_deleted = TRUE`) filtered on `record_status = 'active'`; use `transaction_master` table name throughout; write-back success: 5 columns (`sync_status`, `sync_date_time`, `sync_notes`, `created_at`, `updated_at`); write-back failure: 3 columns (`sync_status`, `sync_date_time`, `sync_notes`); follow all accounts module implementation patterns from the "Implementation patterns" section above — no `assert`, `fetchone` guard on every `RETURNING id`, bare `except Exception: conn.rollback(); raise` at end of every except chain, `try/finally` around the per-row loop to guarantee `flush()`, `WriteBack = tuple[int, int, list[str]]`, `_to_sync_notes` using the constraint → message table above
- [ ] `core/extractor.py` — rename `account_name_map` → `account_map`; pass `sheets_client` into `upsert_transactions` so the DB layer can write sync results back to the sheet
