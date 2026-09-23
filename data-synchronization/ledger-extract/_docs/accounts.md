# Accounts: current extraction contract

The extractor reads the **`accounts` sheet only** and writes **`account_master`**. It does not import any account detail tab, create extension snapshots, or maintain extension balances from transactions. The complete detail contracts and their unresolved mappings are in [account-details.md](account-details.md).

This document describes the implemented code, including migrations `0011` and `0013`. It replaces the earlier account task/design notes; proposed detail mappings are not implemented behavior.

Sources: [GAS account schema](../../../expense-tracker/api/account-schema.gs), [sheet header contract](../sheets/contracts.py), [account transform](../transforms/accounts.py), [account writer](../database/accounts.py), [original account tables](../migrations/0004_create_accounts.py), [tracking-date migration](../migrations/0011_account_tracking_snapshot.py), and [applied-rate migration](../migrations/0013_capture_applied_rates.py).

## Every master sheet column

The table lists the canonical 19-column GAS order. Extraction requires the matching header set, but accepts reordered columns and resolves sync writeback positions from the actual headers. Optional blank strings become database `NULL` where a field is persisted. “Immutable” means a differing source value fails extraction for an existing UUID; it is not silently ignored. The DB type and nullability below describe `account_master` after the listed migrations.

| # | Sheet column | Database destination | Transformation and update behavior |
|---|---|---|---|
| 1 | `id` | `id UUID NOT NULL`, primary key | Required valid UUID, canonicalized by Python. Stable identity for insert, retry, update, deletion, and restore. No generated replacement ID. |
| 2 | `account_name` | `account_name TEXT NOT NULL` | Required trimmed string. Updated on replay. |
| 3 | `legal_entity_name` | `legal_entity_name TEXT NULL` | Optional trimmed string. Immutable. |
| 4 | `type` | `account_type TEXT NOT NULL` | Required `asset`, `investment`, or `liability`; type/subtype pair must exist in `account_types`. Immutable. |
| 5 | `sub_type` | `account_subtype TEXT NOT NULL` | Required trimmed string; validated against `account_types` together with `type`. Mutable within the same account type. The lookup checks existence, not reference-row active status. |
| 6 | `account_currency_local` | `local_currency CHAR(3) NOT NULL` | Required three ASCII letters; trimmed and uppercased; must exist in `currency_master`. Immutable. Older source header `local_currency` is not accepted. |
| 7 | `local_timezone` | `local_timezone TEXT NULL` | Optional recognized IANA timezone. Used to reject ambiguous/nonexistent local times when supplied; local date strings remain local text. No timezone is invented when blank. Immutable. |
| 8 | `account_opening_date_local` | `opening_date_local TEXT NULL` | Optional valid ISO local date/datetime without a UTC offset. Real account opening date. Used as the legacy FX snapshot date only when tracking date is absent. Immutable; a date and its equivalent midnight datetime compare equal. |
| 9 | `account_closing_date_local` | `closing_date_local TEXT NULL` | Optional valid ISO local date/datetime. Cannot precede a supplied opening date. Mutable. |
| 10 | `opening_value_local` | `opening_amount_local_value BIGINT NOT NULL` | Required finite decimal major units; converted to signed minor units using `currency_master.decimal_places` and `ROUND_HALF_UP`. Rejects BIGINT overflow. Liabilities must be ≤ 0; assets/investments ≥ 0. Immutable after minor-unit conversion. Also supplies the derived base amount below. |
| 11 | `current_value_local` | **Not persisted** | GAS virtual/computed account balance, not authoritative stored detail data. The extractor does not turn this cell into a deposit balance or another extension value. |
| 12 | `description` | `account_description TEXT NULL` | Optional trimmed string; mutable. |
| 13 | `record_status` | `record_status TEXT NOT NULL` | Required `active`, `inactive`, `deleted`, or `locked`. Mirrored on each processed row, including restore/unlock. No physical account deletion. |
| 14 | `sync_status` | **Not an account DB column** | Controls processing. `create-pending`, `create-failed`, `update-pending`, and `update-failed` are actionable. `in-sync` normally skips, but a missing DB identity is automatically requeued; explicit reprocessing also includes existing identities. Successful writeback sets `in-sync`; row failure sets the matching `create-failed`/`update-failed`. |
| 15 | `sync_date` | **Not an account DB column** | Written back to Sheets as a UTC ISO timestamp for the sync attempt. Does not supply either DB audit timestamp. |
| 16 | `sync_notes` | **Not an account DB column** | Written back with an actionable row error; cleared after success. |
| 17 | `created_at` | **Not copied into `account_master.created_at`** | Source audit timestamp remains in Sheets. The identically named DB column records DB insertion time instead. |
| 18 | `updated_at` | **Not copied into `account_master.updated_at`** | Source audit timestamp remains in Sheets and participates in source-change protection. The DB column records successful DB write time instead. |
| 19 | `tracking_start_date_local` | `tracking_start_date_local TEXT NULL` | Optional valid ISO local date/datetime. Opening balance is valued at this snapshot date when present. Added by migration `0011`; an existing DB `NULL` may be populated once from the sheet, then is immutable. Date and equivalent midnight datetime compare equal. |

The 13 persisted source fields above plus the six derived/DB-origin columns below account for all **19 `account_master` columns**. Source sync state and source audit timestamps are not silently merged into database audit fields.

## Derived and DB-origin columns

| Database column | SQL type / nullability | Actual origin |
|---|---|---|
| `opening_amount_base_value` | `BIGINT NOT NULL` | Opening local amount after local-minor-unit rounding, converted to XAU nanograms using the selected historical rate and `ROUND_HALF_UP`. Recomputed for every processed row, including an existing account. |
| `base_currency` | `CHAR(3) NOT NULL` | Extractor constant `XAU`; one XAU means **one gram of gold**. |
| `currency_rate_id` | `UUID NULL` | FK to the selected `currency_rates.id`. `NULL` for XAU itself and exactly zero foreign opening balances that require no conversion. Nonzero foreign balances require a rate. |
| `applied_rate_value` | `NUMERIC(19,8) NULL` | A copy of the exact selected Decimal rate used in the calculation: local currency major units per one XAU gram. `1` for XAU; `NULL` for zero foreign balances without conversion. Existing rows receive `NULL` when migration `0013` runs; no historical rate is guessed. Populated/replaced when the row is processed. |
| `created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on insertion; preserved on account updates/retries. Not the sheet creation time. |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on every successful account insert/update. Not the sheet modification time. |

## Monetary calculation and historical dates

Let `d` be the currency's minor-unit precision and `r` the selected rate in local major units per XAU gram:

```text
local_minor = ROUND_HALF_UP(sheet_opening_value × 10^d)
base_minor  = ROUND_HALF_UP((local_minor / 10^d) / r × 10^9)
```

All arithmetic uses `Decimal`. The base amount is derived from the amount actually stored locally, so extra source precision cannot create conflicting local/base values. For example, `123.455` USD at precision 2 stores `12346` cents. At `100` USD per XAU gram, the base amount is `1234600000` nanograms, based on `123.46` USD.

For XAU accounts, `currency_master.decimal_places` must be `9`; base and local minor amounts are identical, `currency_rate_id` is `NULL`, and `applied_rate_value` is `1`. For an exactly zero foreign source opening amount, both stored amounts are zero and no date/rate is required. A nonzero source amount still follows the normal historical-rate path even if minor-unit rounding reduces it to zero.

The valuation date is the **local calendar date** of `tracking_start_date_local`, falling back to `account_opening_date_local` only when tracking date is blank. The writer selects the latest XAU-based rate on or before that date. It never falls forward to a later rate and never substitutes extraction day. Missing dates for nonzero foreign balances, or missing earlier rates, fail the row. There is currently no maximum prior-rate age; a very old available rate can be selected.

An account's real opening date may precede the recorded balance snapshot by years. The fallback is a legacy assumption, not evidence that the supplied balance actually existed at the real opening date. Supply `tracking_start_date_local` to make the intended date explicit. The current code does not enforce tracking date ≥ opening date or tracking date ≤ closing date.

## Updates, retries, deletion, and replay

The writer locks an existing account by UUID before checking immutable fields. Mutable fields are name, subtype, closing date, description, and record status. Existing immutable differences fail with the field names to reconcile. Currency cannot change underneath existing transaction/subscription minor-unit amounts. The only migration accommodation is the first fill of an absent tracking date.

Every successful processed row also refreshes base amount, selected rate ID, and captured `applied_rate_value` at the unchanged historical snapshot date. A later edit to `currency_rates.rate_value` cannot rewrite the captured value already stored on the account. Explicit reprocessing uses the corrected/backfilled rate and replaces the account's derived base amount and rate snapshot. This is current-state revaluation; previous account valuation versions are not retained in an account history table.

Writes commit per row. A bad row rolls back that row and increments the failure count; previously committed rows remain. The job must not report success or checkpoint the failed source snapshot. Source writeback changes only the three sync cells after source-change checks; a writeback failure can leave a committed DB row pending, which is why retries must preserve UUID identity. A physical sheet-row removal is not a deletion instruction; supported deletion is `record_status=deleted` plus an actionable sync status.

Run and replay behavior, including precautions for applying migrations and `--reprocess`, is described in the [module README](../README.md). Account regressions are in [unit tests](../tests/unit/test_accounts.py) and [integration tests](../tests/integration/).

## Concrete boundaries still to resolve

- **Account details:** all six current detail tabs remain unextracted. Existing seven extension tables are a different contract, not a complete mapping. See the field-by-field inventory in [account-details.md](account-details.md).
- **Current balances:** the master stores an opening snapshot, not a continuously updated balance. There is no implemented extension balance replay, investment mark-to-market, or current-value aggregation here.
- **Negative assets:** GAS can retain a negative asset opening input, while this extractor and DB require nonnegative asset/investment opening values. Such rows fail explicitly; the source/DB policy needs reconciliation rather than an implicit sign change.
- **Local times:** ambiguous/nonexistent local datetimes fail if a timezone is supplied. When timezone is absent, local date syntax is validated but no DST interpretation is possible. These TEXT columns are not UTC timestamps.
- **Valuation provenance:** account rows now capture the applied numeric rate, but migration cannot reconstruct rates used by legacy writes. Replay deliberately revalues at the current historical rate series. Maximum acceptable rate age and a full history of repeated valuations remain undefined.
- **Source audit history:** sheet `created_at`/`updated_at` are not archived in separate DB columns. Database audit timestamps describe ingestion only.
