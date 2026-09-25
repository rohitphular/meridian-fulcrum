# Subscriptions — current Sheet-to-database mapping

This document describes the implemented contract as of 2026-09-24. The source is the expense-tracker `subscription_master` tab. The destination `subscription_master` stores recurring-obligation definitions, not posted transactions. Optional counterparty names also populate the shared `counterparty_master` registry.

Source definitions: [GAS field registry](../../../expense-tracker/api/subscription-schema.gs), [GAS validation](../../../expense-tracker/api/subscription-validation.gs), [GAS writers](../../../expense-tracker/api/subscription-core.gs), and [expense-tracker subscription documentation](../../../expense-tracker/_docs/subscriptions.md). Extract implementation: [transform](../transforms/subscriptions.py), [database writer](../database/subscriptions.py), [snapshot reader](../sheets/client.py), and [acknowledgements](../sheets/subscriptions.py).

## Source columns, in Sheet order

Positions are the canonical GAS positions. The snapshot reader checks the complete current header set and resolves actual positions for reordered tabs. `NOT NULL` describes the destination column. Optional text is trimmed and stored as SQL `NULL` when blank.

| # | Sheet column / value | Database destination / type | Mapping and validation |
|---|---|---|---|
| 1 | `id` — UUID string | `subscription_master.subscription_id` — `TEXT NOT NULL UNIQUE` | Validated and canonicalized source UUID. Stable natural key used for every upsert; separate from the generated database `subscription_master.id`. |
| 2 | `subscription_name` — text | `subscription_master.name` — `TEXT NOT NULL` | Required, trimmed, nonempty. The destination name differs from the source column name. |
| 3 | `counterparty_name` — text or blank | `subscription_master.counterparty_id` — nullable `UUID`, FK to `counterparty_master.id` | Shared normalized-name lookup/upsert. Blank gives a `NULL` FK. [Counterparty mapping](transaction-master.md#counterparty-storage) accounts for every registry column and the normalization rules. |
| 4 | `subscription_amount_local` — major-unit number or numeric text | `subscription_master.amount_local` — `BIGINT NOT NULL` | Required finite positive `Decimal`, converted to the source account currency's minor units with `ROUND_HALF_UP`. Zero after rounding and BIGINT overflow fail. |
| 5 | `frequency` — cadence string | `subscription_master.frequency` — `TEXT NOT NULL` | Required member of `weekly`, `monthly`, `quarterly`, `annual`. No other cadence is inferred. |
| 6 | `day_of_month` — integer or blank | `subscription_master.day_of_month` — nullable `INTEGER` | Required for monthly/quarterly/annual; range 1–31. For weekly, blank becomes `NULL`; a supplied value is still validated and retained. |
| 7 | `day_of_week` — integer or blank | `subscription_master.day_of_week` — nullable `INTEGER` | Required for weekly; 1=Monday through 7=Sunday. For other frequencies, blank becomes `NULL`; a supplied value is still validated and retained. |
| 8 | `source_account` — account UUID | `subscription_master.account_id` — `UUID NOT NULL`, FK to `account_master.id` | Required both by GAS and the extractor. Parse/canonicalize UUID and resolve the existing account; the account supplies currency and hence minor-unit precision. |
| 9 | `tx_type` — `money-in` / `money-out` or blank | `subscription_master.tx_type` — nullable `TEXT`; also resolves `category_id` | Trim; blank becomes `NULL`. Nonblank direction must be valid. Together with columns 10–11, a complete triplet resolves the nullable category FK. |
| 10 | `major_category` — category key or blank | `subscription_master.major_category` — nullable `TEXT`; also resolves `category_id` | Trim; blank becomes `NULL`. Preserve a supplied key even when the other classification components are absent. |
| 11 | `minor_category` — subcategory key or blank | `subscription_master.minor_category` — nullable `TEXT`; also resolves `category_id` | Trim; blank becomes `NULL`. Complete triplets must resolve an existing category; incomplete triplets retain their supplied fields with a `NULL` category FK. |
| 12 | `description` — text or blank | `subscription_master.description` — nullable `TEXT` | Trim; blank becomes `NULL`. |
| 13 | `record_status` — lifecycle string | `subscription_master.record_status` — `TEXT NOT NULL` | Required `active`, `inactive`, `deleted` or `locked`. Mirror the source value, including restoration and unlocking. The extractor does not independently expire schedules. |
| 14 | `created_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | GAS owns the source value. The database column with the same name independently records first ingestion. |
| 15 | `sync_status` — synchronization string | **Not persisted in an entity table; read and written back to the Sheet** | Four pending/failed statuses are actionable. Success writes `in-sync`; a controlled failure writes `create-failed` or `update-failed`. Invalid statuses fail snapshot validation. |
| 16 | `sync_date` — ISO timestamp or blank | **Not persisted in an entity table; written back to the Sheet** | UTC time of the recorded processing outcome. This is not the subscription start/end date. |
| 17 | `sync_notes` — text or blank | **Not persisted in an entity table; written back to the Sheet** | Cleared on success; contains the controlled failure reason on failure. |
| 18 | `updated_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | GAS owns the source value. The database column of the same name records the latest successful ingestion/upsert. |
| 19 | `subscription_start_date_local` — local datetime or blank | `subscription_master.subscription_start_date_local` — nullable `TIMESTAMPTZ` | Blank stays `NULL` for weekly/monthly after migration 0012; quarterly/annual require a start to anchor the cycle. Nonblank values require an explicit valid row timezone and are stored as timezone-aware instants. The historical `_local` suffix does not mean this database column is a naive timestamp. |
| 20 | `subscription_end_date_local` — local datetime or blank | `subscription_master.subscription_end_date_local` — nullable `TIMESTAMPTZ` | Same timezone conversion as start. If both dates exist, end must not precede start. An end without a start is permitted. |
| 21 | `subscription_timezone_local` — IANA zone or blank | `subscription_master.subscription_timezone_local` — nullable `TEXT` | A supplied zone must be valid. Blank stays `NULL` only when both dates are absent; any nonblank date with a blank zone fails `missing_subscription_timezone_local`. No London or database-session fallback is applied. |

## Additional `subscription_master` columns

The source mappings above plus these three database-only fields account for all **20 columns** in the current primary table. Schema: [migration 0010](../migrations/0010_create_subscriptions.py), amended by [0012](../migrations/0012_allow_optional_subscription_start.py) to make the start date nullable, and [0021](../migrations/0021_optional_subscription_classification.py) to preserve optional classification and make its FK nullable.

| Qualified database column | Type / nullability | Origin and meaning |
|---|---|---|
| `subscription_master.id` | `UUID NOT NULL`, primary key | PostgreSQL `gen_random_uuid()` on first insertion; preserved by `ON CONFLICT (subscription_id)`. This UUID is not written into the Sheet. |
| `subscription_master.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` at first ingestion; preserved on conflict. Not copied from source `created_at`. |
| `subscription_master.updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on every successful upsert/replay. Not copied from source `updated_at`. |

The database stores no separate `local_currency`, `base_currency`, `amount_base`, `currency_rate_id`, `applied_rate_value`, `next_payment_date`, tags or beneficiary allocations for subscriptions. Currency is obtained by joining `subscription_master.account_id` to `account_master.local_currency`; direction and classification retain their original optional source fields; a resolved `category_id` additionally links the category metadata.

## Money and related records

For source amount `A` and the account currency precision `d` from `currency_master`, the mapping is:

```text
subscription_master.amount_local = ROUND_HALF_UP(A × 10^d)
```

The result must be between `1` and `9,223,372,036,854,775,807`. [The financial helper](../transforms/financial.py) uses Decimal arithmetic and validates the precision and BIGINT bound. Amounts use ASCII decimal notation (including scientific notation); schedule days use ASCII integer digits. Unicode digits and underscore separators are rejected to match the app. NaN, infinity, nonpositive source values and rounded-zero amounts fail before a subscription is committed. No exchange-rate lookup or XAU valuation is performed: this row defines a local-currency obligation, and its future payments are separate transactions. Source numeric cells may already have lost digits in Sheets; Decimal conversion cannot restore missing source precision.

The subscription retains the account's UUID directly; there is no separate account-name resolution or subscription-specific account identity. Account and category lookups include inactive, locked and deleted records so historical obligations can still be represented. Account currency edits are guarded by [the account extractor](account-master.md), because changing currency would reinterpret stored subscription minor units. When all three source components are present, the category lookup uses `(tx_type_key, major_category_key, minor_category_key)` and does not apply an `is_subscription_eligible` filter. When any component is absent, the FK is `NULL` and supplied components are still retained. Clearing classification on re-import clears the old FK too.

The only auxiliary entity written by subscriptions is `counterparty_master`. Its **11-column complete mapping** is shared with transactions and documented in [counterparty storage](transaction-master.md#counterparty-storage): database-generated stable UUID, normalized unique key, latest source label, five untouched location-enrichment fields, inferred lifecycle status, and independent database creation/update timestamps. Subscription writes participate in the same normalized-key identity space; whichever valid source row resolves a shared counterparty last supplies its label. Subscriptions do not populate `beneficiaries_master` or `transaction_beneficiaries`.

## Dates and scheduling contract

The shared [date helper](../transforms/dates.py) accepts local timestamps in `YYYY-MM-DD HH:MM:SS` or equivalent `T` form, optionally with up to six fractional-second digits. Date-only cells, offset suffixes, malformed/unknown zones, nonexistent daylight-saving times and ambiguous repeated-hour times fail. The expense-tracker CSV importer may explicitly normalize date-only input to midnight before it reaches the Sheet. Its backend validates the same wall-time ambiguity and canonicalizes accepted IANA zone aliases/casing on writes; direct Sheet values still need a valid IANA key. Numeric offset zones are not a substitute for the IANA field.

The extractor binds aware datetimes to `TIMESTAMPTZ`: PostgreSQL stores an instant, while the separate IANA name supplies the source timezone. Its display may vary with SQL session timezone without changing that instant. Blank dates are not invented from audit timestamps or today's date. Weekly/monthly may omit both dates and timezone; quarterly/annual require a start timestamp and explicit timezone so the source scheduler has a stable cycle anchor. Any supplied end timestamp must not precede start.

| Concern | Expense-tracker source | Ledger-extract |
|---|---|---|
| Account | Requires a valid existing account UUID; new active use requires an active account, while retained/history references can remain. | Resolves the account under a shared lock; includes all lifecycle states so history remains representable. |
| Classification | Direction/major/minor remain independently optional. A full triplet must exist; active source writes require subscription eligibility. | Preserves optional keys and resolves only full triplets. Historical category lifecycle/eligibility does not invalidate an existing obligation. |
| Start and recurrence | Weekly/day-of-week; monthly/day-of-month; quarterly/annual additionally anchor to the start month. | Validates frequency, required anchor and ranges, including supplied unused anchors; requires start for quarterly/annual. |
| Computed schedule | Computes the next calendar date in the row timezone, inclusive of start/end; short months clamp the day. Undated blank-zone schedules use the source schema's London display default. | No next date or schedule status is persisted. An absent source timezone remains `NULL` when no dates exist. The extractor is not a scheduler. |
| Expiry | Read-only `schedule_status` describes expired/invalid/upcoming schedules; a read never changes stored lifecycle. Deleted rows remain available for restore/export. | Mirrors the explicit source lifecycle, including expired-but-active definitions; never expires or posts a payment. |
| Names and identity | Interactive create/update/restore checks duplicate nondeleted names; CSV uses UUID identity. | Uniqueness is on `subscription_id`, not `name`; repeated names with different UUIDs stay separate. |
| Audit | GAS owns Sheet audit timestamps; CSV metadata is ignored as input. | Database audit timestamps track ingestion independently; acknowledgements touch only the three sync columns. |

Older database dates may have been interpreted using the SQL session's timezone. A hard-sync of valid source values with explicit zones corrects those instants; missing historical zones are never inferred. The local 21-row CSV now has a blank timezone column for the user to fill per row before import.

Migrations 0012 and 0021 preserve optional start/classification. Migration 0021 backfills existing classification from resolved categories without changing IDs or audit timestamps. No new migration is required by this review. Subscription extraction is enabled in the supplied config, so the canonical `subscription_master` tab and all required source values must be ready before running it.

## Synchronization and identity

`create-pending`, `create-failed`, `update-pending` and `update-failed` all use the same stable-ID upsert. Each row locks its stored identity, reads/locks its current account currency, precision and resolved category, and checks the captured source immediately before commit. It never trusts a stale account-currency cache. A subscription and any counterparty change commit together; a validation or database-integrity error rolls the row back. Existing deleted or locked database records can be restored or unlocked when that is the source state. Missing records on an update are inserted through the same upsert. UUIDs are canonicalized before duplicate checks. An existing database UUID stored in a different TEXT spelling (uppercase, braces, compact or URN) fails with `database_subscription_identity_requires_reconciliation` instead of creating another logical record; reconcile it explicitly before retrying.

`in-sync` rows normally skip. A source identity missing after database recovery is requeued in memory, and `--reprocess` deliberately revalidates existing rows. A physically deleted Sheet row does not delete its database record; synchronize a `record_status=deleted` tombstone instead.

A source change aborts and rolls back the current row without queuing a stale success/failure acknowledgement. The subscription table write lock serializes competing writers through the check and commit; ordinary reads remain available. Only `sync_status`, `sync_date` and `sync_notes` are written back, using the original physical row and actual header positions, after the database commit and source-snapshot check. Success never rewrites the source audit timestamps. If acknowledgement fails, replay reuses the same database UUID and original database `created_at`. The complete job is not one database transaction; earlier valid rows may remain committed after a later row fails.

After all enabled entities finish successfully, shared registry cleanup preserves counterparties used by any nondeleted subscription or transaction, including inactive or locked references. It marks only unused active registry rows deleted. See [module behaviour](../README.md), [transactions and shared registries](transaction-master.md), and [usage](../_runbooks/USAGE-INSTRUCTIONS.md) for the full extraction and recovery contract.
