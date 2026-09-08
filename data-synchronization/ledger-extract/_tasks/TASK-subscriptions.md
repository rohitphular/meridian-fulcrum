# TASK — subscriptions

**Status:** OPEN
**Build order:** 4 of 4 — depends on accounts (`account_id` FK) and categories (`category_id` FK)

---

## Open questions

All resolved. Decisions recorded inline below.

---

## Source schema (21 columns)

| # | Column | Sheet type | DB column | DB type | Notes |
|---|--------|-----------|-----------|---------|-------|
| 1 | `id` | string | `subscription_id` | `TEXT NOT NULL` | Natural key (UUID stamped by GAS); blank → `id_required` (transform fail) |
| 2 | `subscription_name` | string | `name` | `TEXT NOT NULL` | Required; blank → `name_required` (transform fail; `TEXT NOT NULL` does not catch empty string) |
| 3 | `counterparty_name` | string | `counterparty_id` | `UUID` | Resolved via `counterparty_master` upsert; nullable (blank = `NULL`) |
| 4 | `subscription_amount_local` | number string | `amount_local` | `BIGINT NOT NULL` | Stored as minor units using `decimal_places` from `currency_master`; currency derived from source account |
| 5 | `frequency` | enum string | `frequency` | `TEXT NOT NULL` | `weekly`, `monthly`, `quarterly`, `annual` |
| 6 | `day_of_month` | number string | `day_of_month` | `INTEGER` | Required when `frequency` is `monthly`, `quarterly`, or `annual` (`missing_day_of_month`); otherwise optional; 1–31 (`invalid_day_of_month`) |
| 7 | `day_of_week` | number string | `day_of_week` | `INTEGER` | Required when `frequency` is `weekly` (`missing_day_of_week`); otherwise optional; 1=Monday … 7=Sunday (`invalid_day_of_week`) |
| 8 | `source_account` | string | `account_id` | `UUID NOT NULL` | UUID (account's `id`); looked up directly in `account_map`; not found → `create-failed`/`update-failed` |
| 9 | `tx_type` | enum string | — | not stored | Required for extract (category_id NOT NULL); `money-in` or `money-out`; blank → `tx_type_required`; invalid value → `invalid_tx_type`; used with `major_category` + `minor_category` to resolve `category_id`; not stored on `subscription_master` |
| 10 | `major_category` | string | — | not stored | Required for extract (category_id NOT NULL); blank → `major_category_required`; used for `category_id` lookup only |
| 11 | `minor_category` | string | — | not stored | Required for extract (category_id NOT NULL); blank → `minor_category_required`; used for `category_id` lookup only |
| 12 | `description` | string | `description` | `TEXT` | Optional |
| 13 | `record_status` | enum string | `record_status` | `TEXT NOT NULL` | `active`, `inactive`, `deleted`, `locked` |
| 14 | `created_at` | ISO string | written back | — | Written back by extract on first successful create |
| 15 | `sync_status` | string | written back | — | `create-pending`, `update-pending`, `in-sync`, `create-failed`, `update-failed`; written back by extract |
| 16 | `sync_date` | string | written back | — | Written back by extract |
| 17 | `sync_notes` | string | written back | — | Written back by extract |
| 18 | `updated_at` | ISO string | written back | — | Written back by extract on every successful sync |
| 19 | `subscription_start_date_local` | datetime string | `subscription_start_date_local` | `TIMESTAMPTZ NOT NULL` | Required; ISO datetime `YYYY-MM-DD HH:MM:SS`; blank → `subscription_start_date_required`; invalid format → `invalid_subscription_start_date` |
| 20 | `subscription_end_date_local` | datetime string | `subscription_end_date_local` | `TIMESTAMPTZ` | Optional; nullable; `YYYY-MM-DD HH:MM:SS`; blank → `NULL`; non-blank invalid format → `invalid_subscription_end_date` |
| 21 | `subscription_timezone_local` | string | `subscription_timezone_local` | `TEXT` | Optional; IANA timezone identifier (e.g. `Europe/London`); nullable (blank = `NULL`) |

**Write-back columns** (accumulated per batch, flushed once via `batch_update_rows`):

- Success (5 values): start at col 14 (`created_at`): `[created_at, sync_status, sync_date, sync_notes, updated_at]`
- Failure (3 values): start at col 15 (`sync_status`): `[sync_status, sync_date, sync_notes]`

`_SYNC_STATUS_COL = 15`  (col 15 = `sync_status`; success writes start at col 14 = `created_at`)

---

## DB schema — `subscription_master`

Table abbreviation: `sm`

| # | Column | Type | Nullable | Notes |
|---|--------|------|----------|-------|
| 1 | `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | No | Surrogate PK |
| 2 | `subscription_id` | `TEXT NOT NULL` | No | Natural key from sheet (UUID) |
| 3 | `name` | `TEXT NOT NULL` | No | Mapped from sheet column `subscription_name` |
| 4 | `counterparty_id` | `UUID` | Yes | FK → `counterparty_master(id)` |
| 5 | `amount_local` | `BIGINT NOT NULL` | No | Minor units in source account's local currency |
| 6 | `frequency` | `TEXT NOT NULL` | No | |
| 7 | `day_of_month` | `INTEGER` | Yes | |
| 8 | `day_of_week` | `INTEGER` | Yes | |
| 9 | `account_id` | `UUID NOT NULL` | No | FK → `account_master(id)` |
| 10 | `category_id` | `UUID NOT NULL` | No | FK → `category_master(id)` |
| 11 | `description` | `TEXT` | Yes | |
| 12 | `subscription_start_date_local` | `TIMESTAMPTZ NOT NULL` | No | |
| 13 | `subscription_end_date_local` | `TIMESTAMPTZ` | Yes | |
| 14 | `subscription_timezone_local` | `TEXT` | Yes | IANA timezone identifier; NULL when not set |
| 15 | `record_status` | `TEXT NOT NULL` | No | |
| 16 | `created_at` | `TIMESTAMPTZ NOT NULL` | No | |
| 17 | `updated_at` | `TIMESTAMPTZ NOT NULL` | No | |

### Constraints (11)

| Name | Type | Definition |
|------|------|------------|
| `pk_sm` | PRIMARY KEY | `(id)` |
| `uq_sm_subscription_id` | UNIQUE | `(subscription_id)` |
| `fk_sm_account` | FOREIGN KEY | `(account_id) REFERENCES account_master(id)` |
| `fk_sm_category` | FOREIGN KEY | `(category_id) REFERENCES category_master(id)` |
| `fk_sm_counterparty` | FOREIGN KEY | `(counterparty_id) REFERENCES counterparty_master(id)` |
| `chk_sm_frequency` | CHECK | `frequency IN ('weekly', 'monthly', 'quarterly', 'annual')` |
| `chk_sm_record_status` | CHECK | `record_status IN ('active', 'inactive', 'deleted', 'locked')` |
| `chk_sm_amount_positive` | CHECK | `amount_local > 0` |
| `chk_sm_day_of_month` | CHECK | `day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 31)` |
| `chk_sm_day_of_week` | CHECK | `day_of_week IS NULL OR (day_of_week >= 1 AND day_of_week <= 7)` |
| `chk_sm_date_range` | CHECK | `subscription_end_date_local IS NULL OR subscription_end_date_local >= subscription_start_date_local` |

---

## Sync-status model

Write-back pattern — no hash comparison, no `ledger_data_checksums` involvement.

| Status | Set by | Routing |
|--------|--------|---------|
| `create-pending` | GAS | INSERT path |
| `create-failed` | Extract | INSERT path (retry) |
| `update-pending` | GAS | UPDATE path |
| `update-failed` | Extract | UPDATE path (retry) |
| `in-sync` | Extract | Silent skip |
| blank / unrecognised | — | `logger.warning` + skip, no write-back |

---

## Preload (once per batch)

```python
account_map = load_account_map(conn)  # dict[str, tuple[Any, str]]
currency_decimal_places = _load_decimal_places(conn)  # dict[str, int]
```

`load_account_map` uses `SELECT id, local_currency FROM account_master WHERE record_status NOT IN ('deleted', 'locked')` and returns `{str(row[0]): (row[0], row[1])}` — UUID string → (UUID, local_currency). This is the same map used by the transactions module.

`_load_decimal_places` selects only `currency_code, decimal_places` from `currency_master` — no `minor_unit_name`.

---

## Resolution steps

Executed inside `_run_insert_steps(conn, row, account_map, currency_decimal_places, failed_status)`:

1. **`source_account` → `account_id`**: look up `account_map[source_account]` → `(account_uuid, local_currency)`. Not found → `write_back_failure(failed_status, account_not_found)` + `continue`.

2. **`local_currency` → `decimal_places`**: look up `currency_decimal_places[local_currency]` using `local_currency` from step 1. Not found → `write_back_failure(failed_status, currency_not_found)` + `continue`.

3. **`subscription_amount_local` → `amount_local` BIGINT**: `int((amount * Decimal(10)**dp).to_integral_value(ROUND_HALF_UP))`. If `amount_local == 0` after rounding → `write_back_failure(failed_status, amount_rounds_to_zero)` + `continue`. Always use `Decimal(10)**dp`, not `Decimal(10**dp)`.

4. **`tx_type` + `major_category` + `minor_category` → `category_id`**: query `category_master` by `(tx_type_key, major_category_key, minor_category_key)`. Not found → `write_back_failure(failed_status, category_not_found)` + `continue`.

5. **`counterparty_name` → `counterparty_id`**: if `counterparty_name` is blank, `counterparty_id = None`. Otherwise, derive `counterparty_key`: strip non-alphanumeric-non-space characters, strip and uppercase, replace runs of spaces with `_`, collapse consecutive `_`. If the resulting key is empty string, log a warning and set `counterparty_id = None` (do not fail). Otherwise upsert into `counterparty_master` on `counterparty_key`. Failure → `write_back_failure(failed_status, counterparty_error)` + `continue`.

6. **INSERT `subscription_master`**: `INSERT ... ON CONFLICT (subscription_id) DO UPDATE SET ... RETURNING id`. Integrity error → rollback + `write_back_failure(failed_status, <sync_notes from _to_sync_notes>)` + `continue`.

7. **Commit + write back `in-sync`**: `conn.commit()` then accumulate success write-back (5 values).

**UPDATE path** (for `update-pending` / `update-failed`):

Same steps 1–5, then:

- `SELECT record_status FROM subscription_master WHERE subscription_id = $1`. If 0 rows → fall through to INSERT path (step 6).
- If `record_status = 'locked'` → write `update-failed` with `subscription_locked` + `continue`.
- If `record_status = 'deleted'` → write `update-failed` with `subscription_deleted` + `continue`.
- Otherwise → `UPDATE subscription_master SET ... WHERE subscription_id = $1`; then commit + write back `in-sync` (5 values).

---

## `category_id` lookup SQL

```sql
SELECT id
FROM category_master
WHERE tx_type_key = %s
  AND major_category_key = %s
  AND minor_category_key = %s
  AND record_status = 'active'
LIMIT 1
```

Parameters: `(tx_type, major_category, minor_category)` — values read from transform output.

The lookup does not filter on `is_subscription_eligible` — that gate is enforced at the GAS UI layer. The extract trusts that categories assigned to subscriptions are eligible.

---

## `_to_sync_notes` — error code mapping

| Exception | `sync_notes` value |
|-----------|-------------------|
| `ValueError` | `str(e).removeprefix("subscriptions: ")` |
| `UniqueViolation` (`uq_sm_subscription_id`) | `duplicate_subscription_id` — defensive; unreachable in normal operation because INSERT uses `ON CONFLICT (subscription_id) DO UPDATE` |
| `ForeignKeyViolation` (`fk_sm_account`) | `account_fk_violation` |
| `ForeignKeyViolation` (`fk_sm_category`) | `category_fk_violation` |
| `ForeignKeyViolation` (`fk_sm_counterparty`) | `counterparty_fk_violation` |
| `CheckViolation` (`chk_sm_frequency`) | `invalid_frequency` |
| `CheckViolation` (`chk_sm_record_status`) | `invalid_record_status` |
| `CheckViolation` (`chk_sm_amount_positive`) | `amount_not_positive` |
| `CheckViolation` (`chk_sm_day_of_month`) | `invalid_day_of_month` |
| `CheckViolation` (`chk_sm_day_of_week`) | `invalid_day_of_week` |
| `CheckViolation` (`chk_sm_date_range`) | `end_before_start` |
| `NotNullViolation` | `null_constraint_violation` |
| Unknown | `raise TypeError` |

---

## No soft-delete pass

Subscriptions does not run a post-row soft-delete pass. `counterparty_master` soft-delete is owned by the transactions module. If a future requirement arises to also check `subscription_master` references before soft-deleting a counterparty, that update belongs in `database/transactions.py`'s existing pass.

---

## What to build

- [ ] `migrations/0010_create_subscriptions.py`
- [ ] `transforms/subscriptions.py` — validates and type-converts all 21 sheet columns; `ValueError` prefix `"subscriptions: "`; `id` (subscription_id) required — blank → `id_required`; `subscription_name` (col 2) required — blank → `name_required`; reads `subscription_amount_local` (col 4); `subscription_start_date_local` (col 19) required — blank → `subscription_start_date_required`, must parse with `datetime.strptime(val, '%Y-%m-%d %H:%M:%S')` (sheet format uses space separator, not `T`) — invalid format → `invalid_subscription_start_date`; non-blank `subscription_end_date_local` (col 20) must parse with the same format — invalid format → `invalid_subscription_end_date`; blank `subscription_end_date_local` → `None`; `subscription_timezone_local` (col 21) optional — passed through as-is when non-blank, `None` when blank; `tx_type` required — blank → `tx_type_required`, invalid value → `invalid_tx_type`; `major_category` required — blank → `major_category_required`; `minor_category` required — blank → `minor_category_required`; cross-field frequency anchor: `weekly` requires non-blank `day_of_week` (`missing_day_of_week`), `monthly`/`quarterly`/`annual` require non-blank `day_of_month` (`missing_day_of_month`); `day_of_week` validated as 1–7 (`invalid_day_of_week`); `day_of_month` validated as 1–31 (`invalid_day_of_month`); no `currency` column (currency derived from account in DB layer); GAS canonical format reference: `sheetDateTimeToDate` / `dateToSheetDateTime` in `expense-tracker/api/app-utils.gs`
- [ ] `sheets/subscriptions.py` — `write_back_success()` (5 cols starting at col 14 = `created_at`: `[created_at, sync_status, sync_date, sync_notes, updated_at]`), `write_back_failure()` (3 cols starting at col 15 = `sync_status`: `[sync_status, sync_date, sync_notes]`), `flush()`; `_SYNC_STATUS_COL = 15`
- [ ] `database/subscriptions.py` — `upsert_subscriptions(conn, sheets_client, rows, account_map)`; `source_account` UUID looked up directly from `account_map`; `local_currency` taken from account_map result; no `currency` column written to DB; `sync-failure` status is not used — all failures write `create-failed` or `update-failed`; `day_of_week` validated as 1–7 in transform
- [ ] Wire into `core/extractor.py` — after transactions; pass `account_map` (reuse the one loaded for transactions if both enabled in same run, or load fresh)
