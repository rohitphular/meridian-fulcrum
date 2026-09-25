# Transactions — current Sheet-to-database mapping

This document describes the implemented contract as of 2026-09-24. The source is the expense-tracker `transaction_master` tab: one row per account movement. The primary destination is `transaction_master`; counterparties and beneficiary allocations are stored in related tables. The input CSV accepted by the UI is a different contract: one row per standalone transaction or complete transfer, with source/target account names. GAS resolves those accounts and expands transfers into their two stored legs before extraction.

Source definitions: [GAS field registry](../../../expense-tracker/api/transaction-schema.gs), [GAS validation](../../../expense-tracker/api/transaction-validation.gs), [GAS writers](../../../expense-tracker/api/transaction-core.gs), and [expense-tracker transaction documentation](../../../expense-tracker/_docs/transactions.md). Extract implementation: [transform](../transforms/transactions.py), [database writer](../database/transactions.py), [snapshot reader](../sheets/client.py), and [acknowledgements](../sheets/transactions.py).

## Source columns, in Sheet order

Positions below are the canonical GAS positions. The snapshot reader validates the complete header set and resolves actual header positions for reordered tabs. `NOT NULL` describes the destination column; optional source text is trimmed and stored as SQL `NULL` when blank. The snapshot reader validates source IDs; the transaction transform independently validates/canonicalizes both source IDs and nonblank parent references as UUID strings. Invalid parent references become controlled row/group failures. The database natural-key columns remain `TEXT`.

| # | Sheet column / value | Database destination / type | Mapping and validation |
|---|---|---|---|
| 1 | `id` — UUID string | `transaction_master.transaction_id` — `TEXT NOT NULL UNIQUE` | Stable source identity, retained across updates and retries. This is separate from the database-generated `transaction_master.id`. The extractor never writes an ID back to the Sheet. |
| 2 | `tx_date_local` — local datetime | `transaction_master.tx_date_time_base` — `TIMESTAMPTZ NOT NULL` | Required. Parse local wall time in the resolved row timezone and convert to UTC. Also supplies the derived local timestamp and weekdays listed below. A date-only value or a timestamp with an offset suffix is rejected. |
| 3 | `tx_timezone_local` — IANA zone string | `transaction_master.tx_timezone_local` — `TEXT NOT NULL` | Validate the IANA zone. Blank, whitespace or `NULL` uses the existing extractor default `Europe/London`; GAS itself stores blank when no timezone is supplied. Numeric/boolean values are invalid and cannot silently select that default. |
| 4 | `parent_tx_id` — parent source UUID or blank | `transaction_master.parent_tx_id` — nullable `TEXT`, FK to `transaction_master.transaction_id` | Blank becomes `NULL`. A child refers to the parent's **source identity**, not its database surrogate UUID. Self-links, cycles, nested parents and invalid live pairs fail. |
| 5 | `tx_type` — `money-in` / `money-out` | `transaction_master.category_id` — `UUID NOT NULL`, FK to `category_master.id` | Required lookup component: matches `category_master.tx_type_key` together with columns 8 and 9. There is no `transaction_master.tx_type` column; direction is obtained through the category. |
| 6 | `account_id` — account UUID | `transaction_master.account_id` — `UUID NOT NULL`, FK to `account_master.id` | Required valid UUID, canonicalized before lookup. The same account UUID is retained. The account provides local currency; missing accounts fail the row/group. |
| 7 | `tx_amount_local` — major-unit number or numeric text | `transaction_master.tx_amount_local` — `BIGINT NOT NULL` | Parse a finite positive `Decimal`; multiply by `10^currency_master.decimal_places`; round `ROUND_HALF_UP` to integer minor units. Reject zero after rounding or BIGINT overflow. Also supplies the derived base amount. |
| 8 | `major_category` — category key | `transaction_master.category_id` — `UUID NOT NULL` | Required lookup component matching `category_master.major_category_key`; no separate major-category string is stored on the transaction. |
| 9 | `minor_category` — subcategory key | `transaction_master.category_id` — `UUID NOT NULL` | Required lookup component matching `category_master.minor_category_key`. All three classification keys must resolve to one existing category. Transfer children retain the initiating major/minor keys but reverse direction, so the reverse-direction classification must exist too; there is no fallback to the parent's category. |
| 10 | `description` — text or blank | `transaction_master.tx_description` — nullable `TEXT` | Trim; blank becomes `NULL`. Renamed in the destination. |
| 11 | `counterparty_name` — text or blank | `transaction_master.counterparty_id` — nullable `UUID`, FK to `counterparty_master.id` | Resolve/upsert the normalized key in [counterparty storage](#counterparty-storage). Blank gives a `NULL` FK. The name itself is not stored on `transaction_master`. |
| 12 | `tx_tags` — text or blank | `transaction_master.tx_tags` — nullable `TEXT` | Trim and retain the source string, normally semicolon-separated. The extractor does not split tags into a child table or renormalize their contents. |
| 13 | `beneficiaries` — semicolon-separated names or allocations | `beneficiaries_master.beneficiary_name` — `TEXT NOT NULL`; `transaction_beneficiaries.split_percentage` — `NUMERIC(7,4) NOT NULL` | Drives the registry and junction described under [beneficiary storage](#beneficiary-storage). No raw beneficiaries string is stored on the transaction. Blank means no allocations and removes previous junction rows on a successful update. |
| 14 | `user_location_area` — text or blank | `transaction_master.user_location_area` — nullable `TEXT` | Trim; blank becomes `NULL`. This describes the user's location, not the counterparty's location. |
| 15 | `user_location_city` — text or blank | `transaction_master.user_location_city` — nullable `TEXT` | Trim; blank becomes `NULL`. |
| 16 | `user_location_country` — text or blank | `transaction_master.user_location_country` — nullable `TEXT` | Trim; blank becomes `NULL`; no country-code conversion is performed. |
| 17 | `user_location_latitude` — number or blank | `transaction_master.user_location_latitude` — nullable `NUMERIC(10,6)` | Parse finite `Decimal`, require `-90 ≤ value ≤ 90`, and require longitude too. PostgreSQL stores six fractional digits. |
| 18 | `user_location_longitude` — number or blank | `transaction_master.user_location_longitude` — nullable `NUMERIC(10,6)` | Parse finite `Decimal`, require `-180 ≤ value ≤ 180`, and require latitude too. Both coordinates blank gives two `NULL` values. |
| 19 | `record_status` — lifecycle string | `transaction_master.record_status` — `TEXT NOT NULL` | Required member of `active`, `inactive`, `deleted`, `locked`. Mirror the source, including restoration or unlocking of an existing database row. |
| 20 | `sync_status` — synchronization string | **Not persisted in an entity table; read and written back to the Sheet** | Four pending/failed statuses are actionable. Success writes `in-sync`; a controlled failure writes `create-failed` or `update-failed`. Invalid statuses fail snapshot validation. |
| 21 | `sync_date` — ISO timestamp or blank | **Not persisted in an entity table; written back to the Sheet** | UTC timestamp of the recorded processing outcome. Does not determine the transaction date or FX rate. |
| 22 | `sync_notes` — text or blank | **Not persisted in an entity table; written back to the Sheet** | Cleared on success; contains the controlled failure reason on failure. |
| 23 | `created_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | Remains owned by GAS. `transaction_master.created_at` has the same name but a different, database-ingestion meaning. |
| 24 | `updated_at` — source audit timestamp | **Not copied to PostgreSQL and not written back** | Remains owned by GAS. It is not the value stored in `transaction_master.updated_at`. |

## Additional `transaction_master` columns

Together with the destinations in the source table, these rows account for all **28 columns** in the current primary table after migration 0013. These fields have no direct source-column copy, even where a source field supplies their inputs.

| Qualified database column | Type / nullability | Origin and meaning |
|---|---|---|
| `transaction_master.id` | `UUID NOT NULL`, primary key | PostgreSQL `gen_random_uuid()` on first insertion. Preserved on every upsert. Referenced by beneficiary junctions. |
| `transaction_master.tx_date_time_local` | `TIMESTAMP NOT NULL` | UTC instant converted back into `tx_timezone_local`, then stored without timezone information. Represents the validated source wall time. |
| `transaction_master.tx_timezone_base` | `TEXT NOT NULL` | Constant `UTC`, enforced by a CHECK constraint. |
| `transaction_master.tx_day_of_week_base` | `day_of_week_enum NOT NULL` | Weekday of the UTC instant: `MONDAY` through `SUNDAY`. |
| `transaction_master.tx_day_of_week_local` | `day_of_week_enum NOT NULL` | Weekday of the local wall time; may differ from the UTC weekday. |
| `transaction_master.tx_amount_base` | `BIGINT NOT NULL`, positive | Computed XAU nanograms using the already-rounded local minor-unit amount and selected rate. |
| `transaction_master.local_currency` | `TEXT NOT NULL` | Copied from the resolved `account_master.local_currency`. CHECK requires three uppercase characters. |
| `transaction_master.base_currency` | `TEXT NOT NULL` | Constant `XAU`, representing one gram of gold as a major unit. |
| `transaction_master.currency_rate_id` | Nullable `UUID`, FK to `currency_rates.id` | Selected exact-UTC-date source-rate row. Required for non-XAU accounts; `NULL` for XAU accounts. The referenced rate row may later be corrected. |
| `transaction_master.applied_rate_value` | Nullable `NUMERIC(19,8)` | Snapshot of the exact rate selected for this write; `1.00000000` for XAU. New/replayed rows set it. Historical rows remain `NULL` after migration until deliberately reprocessed. Non-NULL values must be positive and finite. |
| `transaction_master.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` at first ingestion; preserved by `ON CONFLICT`. Not copied from the source audit column. |
| `transaction_master.updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on each successful upsert, including replay. Not copied from the source audit column. |

The table is created by [migration 0005](../migrations/0005_create_transactions.py), receives its counterparty FK in [0006](../migrations/0006_create_counterparty_master.py), and receives `applied_rate_value` in [0013](../migrations/0013_capture_applied_rates.py). [Migration 0009](../migrations/0009_rename_currency_rate_ref_to_currency_rate_id.py) addresses the historical `currency_rate_ref` name; the current contract uses `currency_rate_id`.

## Money, rate dates and precision

Let `A` be the source amount in local major units, `d` its currency's `decimal_places`, and `R` the selected rate in local major units **per gram of gold**:

```text
local_minor = ROUND_HALF_UP(A × 10^d)
base_minor  = ROUND_HALF_UP((local_minor / 10^d) / R × 10^9)
```

Both stored amounts must be positive and fit signed PostgreSQL BIGINT (`1` through `9,223,372,036,854,775,807` for these positive columns). Decimal conversion occurs in [the money helper](../transforms/financial.py); invalid/nonfinite inputs, unsupported precision, overflow, and a result that rounds to zero fail the row/group. Source numeric cells may already have lost precision in Sheets; the extractor cannot recover those digits.

`currency_master` must contain the local currency and XAU with `decimal_places = 9`. For a non-XAU account, the lookup requires `currency_rates.quote_currency_code = local_currency`, `base_currency_code = 'XAU'`, and `rate_date = tx_date_time_base.date()`. This is the **UTC date**, not necessarily the source wall-date. There is no nearest-date fallback. A missing crypto date or missing historical rate therefore blocks the affected row/group. The extractor accepts an existing exact-date rate regardless of `rate_source`, including a rate that the currency module has forward-filled.

For an XAU account, local and base amounts are the same integer nanograms; no rate lookup occurs, `currency_rate_id` is `NULL`, and `applied_rate_value` is `1`. For other currencies, the rate UUID and snapshot value come from the same SQL result. A later correction to `currency_rates.rate_value` leaves the stored base amount and applied-rate snapshot unchanged until that transaction is processed again. `--reprocess` recalculates them and replaces the previous snapshot; there is no version-history table preserving earlier valuations. See the [currency-rates module](../../currency-rates/README.md).

## Time and transfer semantics

[Local-date validation](../transforms/dates.py) accepts `YYYY-MM-DD HH:MM:SS` or the equivalent `T` separator, optionally with up to six fractional-second digits. It rejects timezone suffixes, invalid zones, nonexistent local times during a daylight-saving jump, and ambiguous local times during a repeated hour. No offset is guessed for those ambiguous values. The legacy London default applies only when the transaction timezone field is blank.

Transfers are a root row and a child whose `parent_tx_id` refers to the root's source UUID. Either money direction can be the parent. The extractor groups the union of existing database relationships and incoming Sheet relationships, so reassignment of a child joins its former and new parents into one atomic group. It processes actionable roots before children while retaining original physical row numbers for acknowledgements. All actionable legs in a group commit together; a child failure rolls back the group's parent write and all registry/junction changes. Unrelated groups may already have committed.

The final database state is checked before commit, including siblings that were already `in-sync`: a nondeleted child needs a nondeleted root, a different account, and the opposite category direction. Here nondeleted includes `inactive` and `locked`. A root may have at most one nondeleted child. Deleted child tombstones may retain a former relationship even when their former parent has since become a child itself. Self-links, source cycles and live nested parent chains are rejected. The GAS schema comment mentions possible future chains, but the current extractor supports the implemented two-leg transfer contract only. It does not require equal leg amounts or equal base valuations; cross-currency transfers and explicitly supplied target amounts can differ.

Interactive delete/restore in expense-tracker changes one selected leg and validates the resulting pair before writing. Delete a child before its parent; restore a parent before its child. The source rejects deleting a root with a nondeleted child or restoring a child under a deleted root. Ledger-extract independently rejects invalid pairs introduced by older clients or direct Sheet edits, without partially changing the database pair; it never invents a deletion or restoration on another source row.

Each actionable group takes a PostgreSQL `SHARE ROW EXCLUSIVE` lock on `transaction_master` through commit, protecting against concurrent insertion of a second child. Referenced accounts, categories, currency precision and selected rates are read under shared row locks. Account currency is reloaded for the group instead of trusting the earlier job cache. If related parent links change between planning and locking, the job stops with `database_transfer_relationships_changed_retry`; retry from a fresh snapshot. A legacy database `transaction_id` that spells a source UUID noncanonically fails with `database_transaction_identity_requires_reconciliation` instead of inserting a second logical transaction.

## Counterparty storage

`counterparty_master` is shared with subscriptions. Both source `counterparty_name` fields follow the same resolution path. The trimmed source name becomes `counterparty_label`. The key keeps Unicode alphanumeric characters and whitespace, removes punctuation, trims, uppercases, and replaces whitespace runs with underscores. For example, `Acme & Co` becomes `ACME_CO`. Distinct names can intentionally collide under this normalization; there is no separate source counterparty ID.

A blank source name sets the parent record's FK to `NULL`. A nonblank name whose normalized key is empty fails instead of silently discarding the name. An existing key reuses its UUID, updates the label to the latest processed source value and sets status to `active`; enrichment fields are left untouched.

All **11 columns** are accounted for below; their schema is [migration 0006](../migrations/0006_create_counterparty_master.py).

| Qualified database column | Type / nullability | Origin and update behaviour |
|---|---|---|
| `counterparty_master.id` | `UUID NOT NULL`, primary key | Database-generated UUID; reused on normalized-key conflict. Referenced by `transaction_master.counterparty_id` and `subscription_master.counterparty_id`. |
| `counterparty_master.counterparty_key` | `TEXT NOT NULL UNIQUE` | Normalized source name as described above. |
| `counterparty_master.counterparty_label` | `TEXT NOT NULL` | Latest processed trimmed source name for that key. |
| `counterparty_master.location_area` | Nullable `TEXT` | Database enrichment only; not populated from transaction user-location fields and not overwritten by the extractor. |
| `counterparty_master.location_city` | Nullable `TEXT` | Database enrichment only. |
| `counterparty_master.location_country` | Nullable `TEXT` | Database enrichment only. |
| `counterparty_master.location_latitude` | Nullable `NUMERIC(10,6)` | Database enrichment only; CHECK range `[-90,90]` and paired with longitude. |
| `counterparty_master.location_longitude` | Nullable `NUMERIC(10,6)` | Database enrichment only; CHECK range `[-180,180]` and paired with latitude. |
| `counterparty_master.record_status` | `TEXT NOT NULL` | `active` on resolution. Cleanup may change an active registry row to `deleted` when neither a nondeleted transaction nor a nondeleted subscription references it. Database enum CHECK also permits `inactive` and `locked`. |
| `counterparty_master.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on first insertion; preserved on conflict. |
| `counterparty_master.updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on resolution or cleanup change. |

## Beneficiary storage

The optional `beneficiaries` string supports either `Alice;Bob` for equal shares or `Alice:60;Bob:40` for explicit shares. Names are trimmed and matched exactly, including case, against `beneficiaries_master.beneficiary_name`. Explicit percentages use ASCII decimal notation, optionally scientific notation; underscores and Unicode digits are rejected. Duplicate names within a row, empty entries, mixed percentage/no-percentage syntax, nonfinite/nonpositive shares and incorrect totals fail the whole transaction group.

Percentages are stored at four decimal places. Explicit shares are rounded `ROUND_HALF_UP` and must then total exactly `100`; a share rounding to zero is rejected. Equal shares round the first `n−1` allocations and put the remainder on the last name, so `Alice;Bob;Carol` becomes `33.3333`, `33.3333`, `33.3334`. No split monetary amount is materialized. Consumers may calculate allocations from the stored transaction amount and percentages, but this job does not implement a monetary-remainder allocation rule.

Each successful transaction upsert replaces that transaction's junction rows in the same database transaction. Master transaction identity remains stable, but junction UUIDs and junction creation times are regenerated. Blank beneficiaries removes existing junction rows. Registry enrichment is retained.

All **6 beneficiary-registry columns** are defined by [migration 0007](../migrations/0007_create_beneficiaries_master.py):

| Qualified database column | Type / nullability | Origin and update behaviour |
|---|---|---|
| `beneficiaries_master.id` | `UUID NOT NULL`, primary key | Database-generated UUID; reused for an existing exact beneficiary name. |
| `beneficiaries_master.beneficiary_name` | `TEXT NOT NULL UNIQUE` | Trimmed name parsed from the Sheet's `beneficiaries` string. |
| `beneficiaries_master.beneficiary_details` | Nullable `TEXT` | Database enrichment only; never populated or overwritten by this extractor. |
| `beneficiaries_master.record_status` | `TEXT NOT NULL` | Set to `active` on resolution. Cleanup marks an active registry row `deleted` if no nondeleted transaction references it. CHECK also permits `inactive` and `locked`. |
| `beneficiaries_master.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on first insertion; preserved on name conflict. |
| `beneficiaries_master.updated_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` on resolution or cleanup change. |

All **5 junction columns** are defined by [migration 0008](../migrations/0008_create_transaction_beneficiaries.py):

| Qualified database column | Type / nullability | Origin and update behaviour |
|---|---|---|
| `transaction_beneficiaries.id` | `UUID NOT NULL`, primary key | New database-generated UUID for each allocation insertion. |
| `transaction_beneficiaries.transaction_ref` | `UUID NOT NULL`, FK to `transaction_master.id` | The transaction's stable **database UUID**, not the Sheet source UUID. |
| `transaction_beneficiaries.beneficiary_id` | `UUID NOT NULL`, FK to `beneficiaries_master.id` | UUID resolved by the exact parsed name. Together with `transaction_ref`, forms the unique allocation pair. |
| `transaction_beneficiaries.split_percentage` | `NUMERIC(7,4) NOT NULL` | Computed or explicit share; CHECK requires `0 < value ≤ 100`. Total-of-100 validation is performed in Python. |
| `transaction_beneficiaries.created_at` | `TIMESTAMPTZ NOT NULL` | PostgreSQL `now()` when the junction row is inserted. No junction `updated_at` or lifecycle column exists. |

## Synchronization and current boundaries

Only `sync_status`, `sync_date` and `sync_notes` are acknowledged to the source. The job rechecks all captured tabs before each transaction-group commit and again before acknowledgements. A detected source change rolls back the current group and stops processing. Database audit timestamps record ingestion and are deliberately independent of the untouched GAS audit timestamps. `ON CONFLICT (transaction_id)` updates the existing master row in place; deleted/locked database state does not block a source restore or unlock.

Expense-tracker's edit trigger queues manual transaction business/lifecycle edits, including multirow pastes, by advancing pending status, clearing old sync date/notes and updating source `updated_at`. It preserves transaction values, IDs and `created_at`; metadata-only edits do not requeue a row. Deploy the updated GAS backend to activate this trigger behaviour. Existing edits made before that deployment need a hard-sync or an explicit pending status to be included. Invalid dates, unsupported DST wall times, bad numeric/beneficiary values and invalid references remain strict ETL failures even if an older app or a direct Sheet edit allowed them into the source.

Historical account/category references remain resolvable irrespective of their lifecycle status. This mirrors history and does not repeat the source application's account eligibility, overdraft or loan checks. Transactions do not maintain current account balances or mutate account-detail snapshots; those snapshots sync independently from the six supported detail tabs. Removing a row physically from the Sheet does not remove its database record; source tombstones must be synchronized.

An `in-sync` row is normally skipped, except that missing database identities are automatically requeued and `--reprocess` deliberately revalidates existing rows. Related-registry cleanup runs after all enabled entities complete successfully and considers both transactions and subscriptions. Acknowledgement failure after commit is recovered by replaying the same identity. The whole job is not one database transaction, and Sheets cannot provide an atomic compare-and-swap acknowledgement. See [module behaviour](../README.md) and [usage](../_runbooks/USAGE-INSTRUCTIONS.md) for operational details.
