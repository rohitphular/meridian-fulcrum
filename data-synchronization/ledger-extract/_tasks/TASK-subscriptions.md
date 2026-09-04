# TASK — subscriptions

**Status:** OPEN
**Build order:** 4 of 4 — depends on accounts (`account_id` FK) and categories (`category_id` FK)

---

## Open questions

All resolved. Decisions recorded inline below.

---

## Source schema (22 columns)

| # | Column | Sheet type | DB column | DB type | Notes |
|---|--------|-----------|-----------|---------|-------|
| 1 | `id` | string | `subscription_id` | `TEXT NOT NULL` | Natural key |
| 2 | `name` | string | `name` | `TEXT NOT NULL` | |
| 3 | `counterparty_name` | string | `counterparty_id` | `UUID` | Resolved via `counterparty_master` upsert; nullable (blank = `NULL`) |
| 4 | `amount` | number string | `amount_local` | `BIGINT NOT NULL` | Stored as minor units using `decimal_places` from `currency_master` |
| 5 | `currency` | string | `currency` | `CHAR(3) NOT NULL` | ISO 4217 or `XAU`; used to derive `decimal_places` for `amount_local` |
| 6 | `frequency` | enum string | `frequency` | `TEXT NOT NULL` | `weekly`, `monthly`, `quarterly`, `annual` |
| 7 | `day_of_month` | number string | `day_of_month` | `INTEGER` | Optional; 1–31 |
| 8 | `day_of_week` | number string | `day_of_week` | `INTEGER` | Optional; 0 = Sunday, 6 = Saturday |
| 9 | `source_account` | string | `account_id` | `UUID NOT NULL` | Natural key resolved via `account_map`; not found → `sync-failure` (terminal) |
| 10 | `tx_type` | enum string | — | not stored | `money-in` or `money-out`; used with `major_category` + `minor_category` to resolve `category_id`; not stored on `subscription_master` |
| 11 | `major_category` | string | — | not stored | Used for `category_id` lookup only |
| 12 | `minor_category` | string | — | not stored | Used for `category_id` lookup only |
| 13 | `tags` | string | `tags` | `TEXT` | Optional; semicolons preserved |
| 14 | `description` | string | `description` | `TEXT` | Optional |
| 15 | `record_status` | enum string | `record_status` | `TEXT NOT NULL` | `active`, `inactive`, `deleted`, `locked` |
| 16 | `created_at` | ISO string | written back | — | Written back by extract on first successful create |
| 17 | `sync_status` | string | written back | — | Written back by extract |
| 18 | `sync_date_time` | string | written back | — | Written back by extract |
| 19 | `sync_notes` | string | written back | — | Written back by extract |
| 20 | `updated_at` | ISO string | written back | — | Written back by extract on every successful sync |
| 21 | `subscription_start_date` | date string | `subscription_start_date` | `DATE NOT NULL` | ISO date `YYYY-MM-DD` |
| 22 | `subscription_end_date` | date string | `subscription_end_date` | `DATE` | Optional; nullable |

**Write-back columns** (accumulated per batch, flushed once via `batch_update_rows`):

- Success (5 values): `sync_status` (col 17), `sync_date_time` (col 18), `sync_notes` (col 19), `created_at` (col 16), `updated_at` (col 20)
- Failure (3 values): `sync_status` (col 17), `sync_date_time` (col 18), `sync_notes` (col 19)

`_SYNC_STATUS_COL = 17`

---

## DB schema — `subscription_master`

Table abbreviation: `sm`

| # | Column | Type | Nullable | Notes |
|---|--------|------|----------|-------|
| 1 | `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | No | Surrogate PK |
| 2 | `subscription_id` | `TEXT NOT NULL` | No | Natural key from sheet |
| 3 | `name` | `TEXT NOT NULL` | No | |
| 4 | `counterparty_id` | `UUID` | Yes | FK → `counterparty_master(id)` |
| 5 | `amount_local` | `BIGINT NOT NULL` | No | Minor units |
| 6 | `currency` | `CHAR(3) NOT NULL` | No | ISO 4217 or XAU |
| 7 | `frequency` | `TEXT NOT NULL` | No | |
| 8 | `day_of_month` | `INTEGER` | Yes | |
| 9 | `day_of_week` | `INTEGER` | Yes | |
| 10 | `account_id` | `UUID NOT NULL` | No | FK → `account_master(id)` |
| 11 | `category_id` | `UUID NOT NULL` | No | FK → `category_master(id)` |
| 12 | `tags` | `TEXT` | Yes | |
| 13 | `description` | `TEXT` | Yes | |
| 14 | `subscription_start_date` | `DATE NOT NULL` | No | |
| 15 | `subscription_end_date` | `DATE` | Yes | |
| 16 | `record_status` | `TEXT NOT NULL` | No | |
| 17 | `created_at` | `TIMESTAMPTZ NOT NULL` | No | |
| 18 | `updated_at` | `TIMESTAMPTZ NOT NULL` | No | |

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
| `chk_sm_day_of_week` | CHECK | `day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)` |
| `chk_sm_date_range` | CHECK | `subscription_end_date IS NULL OR subscription_end_date >= subscription_start_date` |

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
| `sync-failure` | Extract | Silent skip — terminal errors only (e.g. `account_not_found`) |
| blank / unrecognised | — | `logger.warning` + skip, no write-back |

---

## Preload (once per batch)

```python
account_map = load_account_map(conn)                  # dict[str, tuple[Any, str]]
currency_decimal_places = _load_decimal_places(conn)  # dict[str, int]
```

`_load_decimal_places` selects only `currency_code, decimal_places` from `currency_master` — no `minor_unit_name`.

---

## Resolution steps

Executed inside `_run_insert_steps(conn, row, account_map, currency_decimal_places, failed_status)`:

1. **`source_account` → `account_id`**: look up `account_map[source_account]` → `(uuid, _)`. Not found → `write_back_failure(sync-failure, account_not_found)` + `continue` (terminal — account_map is loaded once per batch and cannot self-heal mid-run).

2. **`currency` → `decimal_places`**: look up `currency_decimal_places[currency]`. Not found → `write_back_failure(failed_status, currency_not_found)` + `continue`.

3. **`amount` → `amount_local` BIGINT**: `int((amount * Decimal(10)**dp).to_integral_value(ROUND_HALF_UP))`. If `amount_local == 0` after rounding → `write_back_failure(failed_status, amount_rounds_to_zero)` + `continue`. Always use `Decimal(10)**dp`, not `Decimal(10**dp)`.

4. **`tx_type` + `major_category` + `minor_category` → `category_id`**: query `category_master` by `(tx_type_key, major_category_key, minor_category_key)`. Not found → `write_back_failure(failed_status, category_not_found)` + `continue`.

5. **`counterparty_name` → `counterparty_id`**: if `counterparty_name` is present, upsert into `counterparty_master` using the natural key derived from name (same derivation as transactions module). Failure → `write_back_failure(failed_status, counterparty_error)` + `continue`. If `counterparty_name` is blank, `counterparty_id = None`.

6. **INSERT `subscription_master`**: `INSERT ... ON CONFLICT (subscription_id) DO UPDATE SET ... RETURNING id`. Integrity error → rollback + `write_back_failure(failed_status, <sync_notes from _to_sync_notes>)` + `continue`.

7. **Commit + write back `in-sync`**: `conn.commit()` then accumulate success write-back (5 values).

**UPDATE path** (for `update-pending` / `update-failed`):

Same steps 1–5, then `UPDATE subscription_master SET ... WHERE subscription_id = $1 RETURNING id`. If 0 rows returned → fall through to INSERT path (step 6).

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

---

## `_to_sync_notes` — error code mapping

| Exception | `sync_notes` value |
|-----------|-------------------|
| `ValueError` | `str(e).removeprefix("subscriptions: ")` |
| `UniqueViolation` (`uq_sm_subscription_id`) | `duplicate_subscription_id` |
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

- [ ] `migrations/0009_create_subscriptions.py`
- [ ] `transforms/subscriptions.py` — validates and type-converts all 22 sheet columns; `ValueError` prefix `"subscriptions: "`
- [ ] `sheets/subscriptions.py` — `write_back_success()` (5 cols), `write_back_failure()` (3 cols), `flush()`; `_SYNC_STATUS_COL = 17`
- [ ] `database/subscriptions.py` — `upsert_subscriptions(conn, sheets_client, rows, account_map)`
- [ ] Wire into `core/extractor.py` — after transactions; pass `account_map` (reuse the one loaded for transactions if both enabled in same run, or load fresh)
