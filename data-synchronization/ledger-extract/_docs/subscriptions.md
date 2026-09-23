# Subscriptions — current Sheet-to-database mapping

This document describes the implemented contract as of 2026-09-23. The source is the expense-tracker `subscriptions` tab. The destination `subscription_master` stores recurring-obligation definitions, not posted transactions. Optional counterparty names also populate the shared `counterparty_master` registry.

Source definitions: [GAS field registry](../../../expense-tracker/api/subscription-schema.gs), [GAS validation](../../../expense-tracker/api/subscription-validation.gs), [GAS writers](../../../expense-tracker/api/subscription-core.gs), and [expense-tracker subscription documentation](../../../expense-tracker/_docs/subscriptions.md). Extract implementation: [transform](../transforms/subscriptions.py), [database writer](../database/subscriptions.py), [snapshot reader](../sheets/client.py), and [acknowledgements](../sheets/subscriptions.py).

## Source columns, in Sheet order

Positions are the canonical GAS positions. The snapshot reader checks the complete current header set and resolves actual positions for reordered tabs. `NOT NULL` describes the destination column. Optional text is trimmed and stored as SQL `NULL` when blank.

| # | Sheet column / value | Database destination / type | Mapping and validation |
|---|---|---|---|
| 1 | `id` — UUID string | `subscription_master.subscription_id` — `TEXT NOT NULL UNIQUE` | Validated and canonicalized source UUID. Stable natural key used for every upsert; separate from the generated database `subscription_master.id`. |
| 2 | `subscription_name` — text | `subscription_master.name` — `TEXT NOT NULL` | Required, trimmed, nonempty. The destination name differs from the source column name. |
| 3 | `counterparty_name` — text or blank | `subscription_master.counterparty_id` — nullable `UUID`, FK to `counterparty_master.id` | Shared normalized-name lookup/upsert. Blank gives a `NULL` FK. [Counterparty mapping](transactions.md#counterparty-storage) accounts for every registry column and the normalization rules. |
| 4 | `subscription_amount_local` — major-unit number or numeric text | `subscription_master.amount_local` — `BIGINT NOT NULL` | Required finite positive `Decimal`, converted to the source account currency's minor units with `ROUND_HALF_UP`. Zero after rounding and BIGINT overflow fail. |
| 5 | `frequency` — cadence string | `subscription_master.frequency` — `TEXT NOT NULL` | Required member of `weekly`, `monthly`, `quarterly`, `annual`. No other cadence is inferred. |
| 6 | `day_of_month` — integer or blank | `subscription_master.day_of_month` — nullable `INTEGER` | Required for monthly/quarterly/annual; range 1–31. For weekly, blank becomes `NULL`; a supplied value is still validated and retained. |
| 7 | `day_of_week` — integer or blank | `subscription_master.day_of_week` — nullable `INTEGER` | Required for weekly; 1=Monday through 7=Sunday. For other frequencies, blank becomes `NULL`; a supplied value is still validated and retained. |
| 8 | `source_account` — account UUID | `subscription_master.account_id` — `UUID NOT NULL`, FK to `account_master.id` | Required both by GAS and the extractor. Parse/canonicalize UUID and resolve the existing account; the account supplies currency and hence minor-unit precision. |
| 9 | `tx_type` — `money-in` / `money-out` or blank in GAS | `subscription_master.category_id` — `UUID NOT NULL`, FK to `category_master.id` | Required by the extractor as the `category_master.tx_type_key` lookup component. GAS permits blank; this current mismatch is described below. No separate destination `tx_type` column exists. |
| 10 | `major_category` — category key or blank in GAS | `subscription_master.category_id` — `UUID NOT NULL` | Required by the extractor, matching `category_master.major_category_key` with columns 9 and 11. No major-category string is stored on the subscription. |
| 11 | `minor_category` — subcategory key or blank in GAS | `subscription_master.category_id` — `UUID NOT NULL` | Required by the extractor, matching `category_master.minor_category_key`. All three classification keys must resolve to an existing category. |
| 12 | `description` — text or blank | `subscription_master.description` — nullable `TEXT` | Trim; blank becomes `NULL`. |
| 13 | `record_status` — lifecycle string | `subscription_master.record_status` — `TEXT NOT NULL` | Required `active`, `inactive`, `deleted` or `locked`. Mirror the source value, including restoration and unlocking. The extractor does not independently expire schedules. |
| 14 | `created_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | GAS owns the source value. The database column with the same name independently records first ingestion. |
| 15 | `sync_status` — synchronization string | **Not persisted in an entity table; read and written back to the Sheet** | Four pending/failed statuses are actionable. Success writes `in-sync`; a controlled failure writes `create-failed` or `update-failed`. Invalid statuses fail snapshot validation. |
| 16 | `sync_date` — ISO timestamp or blank | **Not persisted in an entity table; written back to the Sheet** | UTC time of the recorded processing outcome. This is not the subscription start/end date. |
| 17 | `sync_notes` — text or blank | **Not persisted in an entity table; written back to the Sheet** | Cleared on success; contains the controlled failure reason on failure. |
| 18 | `updated_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | GAS owns the source value. The database column of the same name records the latest successful ingestion/upsert. |
| 19 | `subscription_start_date_local` — local datetime or blank | `subscription_master.subscription_start_date_local` — nullable `TIMESTAMPTZ` | Blank stays `NULL`, after migration 0012. Nonblank values require an explicit valid row timezone and are stored as timezone-aware instants. The historical `_local` suffix does not mean this database column is a naive timestamp. |
| 20 | `subscription_end_date_local` — local datetime or blank | `subscription_master.subscription_end_date_local` — nullable `TIMESTAMPTZ` | Same timezone conversion as start. If both dates exist, end must not precede start. An end without a start is permitted. |
| 21 | `subscription_timezone_local` — IANA zone or blank | `subscription_master.subscription_timezone_local` — nullable `TEXT` | A supplied zone must be valid. Blank stays `NULL` only when both dates are absent; any nonblank date with a blank zone fails `missing_subscription_timezone_local`. No London or database-session fallback is applied. |

## Additional `subscription_master` columns

The source mappings above plus these three database-only fields account for all **17 columns** in the current primary table. Schema: [migration 0010](../migrations/0010_create_subscriptions.py), amended by [0012](../migrations/0012_allow_optional_subscription_start.py) to make the start date nullable.

| Qualified database column | Type / nullability | Origin and meaning |
|---|---|---|
| `subscription_master.id` | `UUID NOT NULL`, primary key | PostgreSQL `gen_random_uuid()` on first insertion; preserved by `ON CONFLICT (subscription_id)`. This UUID is not written into the Sheet. |
| `subscription_master.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` at first ingestion; preserved on conflict. Not copied from source `created_at`. |
| `subscription_master.updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on every successful upsert/replay. Not copied from source `updated_at`. |

The database stores no separate `local_currency`, `base_currency`, `amount_base`, `currency_rate_id`, `applied_rate_value`, `tx_type`, major/minor category strings, `next_payment_date`, tags or beneficiary allocations for subscriptions. Currency is obtained by joining `subscription_master.account_id` to `account_master.local_currency`; direction and classification are obtained through `category_id`.

## Money and related records

For source amount `A` and the account currency precision `d` from `currency_master`, the mapping is:

```text
subscription_master.amount_local = ROUND_HALF_UP(A × 10^d)
```

The result must be between `1` and `9,223,372,036,854,775,807`. [The financial helper](../transforms/financial.py) uses Decimal arithmetic and validates the precision and BIGINT bound. NaN, infinity, nonpositive source values and rounded-zero amounts fail before a subscription is committed. No exchange-rate lookup or XAU valuation is performed: this row defines a local-currency obligation, and its future payments are separate transactions. Source numeric cells may already have lost digits in Sheets; Decimal conversion cannot restore missing source precision.

The subscription retains the account's UUID directly; there is no separate account-name resolution or subscription-specific account identity. Account and category lookups include inactive, locked and deleted records so historical obligations can still be represented. Account currency edits are guarded by [the account extractor](accounts.md), because changing currency would reinterpret stored subscription minor units. The category lookup uses `(tx_type_key, major_category_key, minor_category_key)` and does not apply an `is_subscription_eligible` filter.

The only auxiliary entity written by subscriptions is `counterparty_master`. Its **11-column complete mapping** is shared with transactions and documented in [counterparty storage](transactions.md#counterparty-storage): database-generated stable UUID, normalized unique key, latest source label, five untouched location-enrichment fields, inferred lifecycle status, and independent database creation/update timestamps. Subscription writes participate in the same normalized-key identity space; whichever valid source row resolves a shared counterparty last supplies its label. Subscriptions do not populate `beneficiaries_master` or `transaction_beneficiaries`.

## Dates, schedules and source-contract differences

The shared [date helper](../transforms/dates.py) accepts local timestamps in `YYYY-MM-DD HH:MM:SS` or the equivalent `T` form, optionally with up to six fractional-second digits. Date-only values, offset suffixes, malformed/unknown zones, nonexistent daylight-saving times and ambiguous repeated-hour times fail. The extractor binds aware datetimes to `TIMESTAMPTZ`; PostgreSQL represents the instant, while the separately stored IANA name supplies the source timezone. Its display may vary with the SQL session timezone without changing that instant. Blank dates are not invented from `created_at`, today's date or the recurrence anchor.

The following differences are current behaviour, not proposed schema changes:

| Concern | Expense-tracker source behaviour | Ledger-extract behaviour / consequence |
|---|---|---|
| Account | GAS create/update requires nonblank `source_account`; the validator does not establish its UUID/FK validity. | Requires a valid UUID that exists in `account_master`. There is **no optional-account mismatch**; malformed or missing references fail. |
| Category and direction | GAS accepts blank `tx_type`, `major_category` and `minor_category`; the schema marks these optional, and the writer stores blanks. A supplied `tx_type` is enum-validated. | Requires the complete valid triplet because `subscription_master.category_id` is `NOT NULL`. A source-valid uncategorized subscription fails extraction until classification is supplied. |
| Start/end dates and timezone | All three source fields are optional; GAS stores their supplied strings and does not enforce the extractor's IANA-zone/DST contract. | Dates may remain absent; any present date requires an explicit valid timezone. Invalid dates, ranges and ambiguous instants fail rather than relying on the database session timezone. |
| Start date | The source permits a blank start. | Current migration 0012 makes the database start nullable. Older schema without that migration cannot represent the same absence. |
| Recurrence anchors | Weekly uses day of week; the other three cadences use day of month. GAS can retain a supplied unused anchor as well. | Validates the required anchor and range; also validates and retains a supplied unused anchor. It does not manufacture a quarterly/annual month anchor. |
| Computed payment date | `next_payment_date` is calculated in GAS responses; it is not a Sheet column. GAS schedule calculation uses server local time and currently has no fixed quarterly/annual month anchor. | No next-payment date is read, computed or persisted. The extractor is not a payment scheduler. |
| Expiry/lifecycle | GAS may change source status based on end-date expiry. | Copies the resulting source `record_status`; it does not run its own expiry policy. |
| Duplicate names | Interactive GAS creation rejects duplicate nondeleted names; bulk import is based on source UUID. | Uniqueness is on `subscription_id`, not `name`; equal names with different source IDs remain separate records. |
| Audit timestamps | GAS owns source `created_at` / `updated_at`. | Deliberately does not copy them to database audit columns and never overwrites them in the Sheet. Source audit history is not otherwise archived by this job. |

Existing database dates written by older code may have been interpreted using that session's timezone. The nullable-start migration does not repair those instants. Reprocessing valid source dates with explicit zones updates them; the job does not infer missing historical timezone information.

## Synchronization and identity

`create-pending`, `create-failed`, `update-pending` and `update-failed` all use the same stable-ID upsert. A subscription and any counterparty change commit together; a validation or database-integrity error rolls the row back. Existing deleted or locked database records can be restored or unlocked when that is the source state. Missing records on an update are inserted through the same upsert.

`in-sync` rows normally skip. A source identity missing after database recovery is requeued in memory, and `--reprocess` deliberately revalidates existing rows. A physically deleted Sheet row does not delete its database record; synchronize a `record_status=deleted` tombstone instead.

Only `sync_status`, `sync_date` and `sync_notes` are written back, using the original physical row and actual header positions, after the database commit and source-snapshot check. Success never rewrites the source audit timestamps. If acknowledgement fails, replay reuses the same database UUID and original database `created_at`. The complete job is not one database transaction; earlier valid rows may remain committed after a later row fails.

After all enabled entities finish successfully, shared registry cleanup preserves counterparties used by any nondeleted subscription or transaction, including inactive or locked references. It marks only unused active registry rows deleted. See [module behaviour](../README.md), [transactions and shared registries](transactions.md), and [usage](../_runbooks/USAGE-INSTRUCTIONS.md) for the full extraction and recovery contract.
