# Mapping conventions and unresolved decisions

This file records current mapping semantics. It replaces historical implementation notes that described obsolete column names and load paths. Consult each [entity mapping](README.md) for the complete column-level contract.

## Naming does not imply a direct copy

| Sheet input | Database output | Meaning |
|---|---|---|
| `account_master.id`, `category_master.id` | `account_master.id`, `category_master.id` | Same canonical source UUID; not regenerated. |
| Detail `id`, `account_id` | Detail `id`, `account_master_id` | Preserve both source UUIDs. No generated version ID or inferred SCD timestamp. |
| `transaction_master.id`, `subscription_master.id` | `transaction_master.transaction_id`, `subscription_master.subscription_id` | Source IDs stored separately from generated database PK `id`. |
| `transaction_master.account_id`, `subscription_master.source_account` | Target entity `account_id` | Resolve `account_master.id`; do not generate or resolve by account name. |
| `tx_type` + `major_category` + `minor_category` | Target entity `category_id` | Resolve the category classification. These three fields are not separately stored on the transaction/subscription master. |
| `opening_value_local`, `tx_amount_local`, `subscription_amount_local` | BIGINT amount columns | Input major units become currency-specific minor units. Identical-looking names can hold different units. |
| Sheet `created_at`, `updated_at` | No direct destination | Identically named DB columns instead record ingestion time. This is a deliberate omission, not a timestamp copy. |
| Sheet `sync_status`, `sync_date`, `sync_notes` | No destination | Source acknowledgement/control metadata, not row-level DB audit columns. |
| `transaction_master.user_location_*` | `transaction_master.user_location_*` | User location only; never infer counterparty location from it. |

## Monetary provenance

Amounts use `currency_master.decimal_places`; XAU means one gram and uses nine decimal places (nanograms). First round local major units to local minor units using HALF_UP; derive base money from those stored local units. `applied_rate_value` captures the Decimal rate actually used. `currency_rate_id` identifies the mutable provider observation row, so the FK alone is not immutable evidence of the conversion.

Account opening valuation uses the tracking date, with real opening date as a legacy fallback, and selects a rate on or before that **local date**. Transactions require a rate for their **UTC date**. These are different implemented policies. Neither the column mapping nor the current job invents absent crypto weekend rates. Old applied-rate snapshots are unknown until replay, not automatically reconstructed.

## Source-to-database differences requiring explicit decisions

- Six detail tabs map to identically named tables through migration 0018, including separate mortgage and personal-loan tables. Source UUIDs are the primary keys and multiple positions per account are supported. Legacy-only balance/history fields remain NULL for imported rows; old rows are retained separately by `source_sheet IS NULL`. Missing financial facts are not guessed. See [account details](account-details.md).
- Source application validation and database extraction validation are different layers. For example, the DB requires particular category/account references while some subscription fields can be blank in GAS; see [subscriptions](subscription-master.md). A source-valid row is not automatically database-valid.
- Account opening balances preserve the source sign for assets/investments after migration 0017. Liabilities remain nonpositive. No existing stored amount is rewritten by the constraint migration.
- Local datetimes are not copied blindly into TIMESTAMPTZ. Ambiguous/nonexistent daylight-saving wall times fail because the source format lacks an explicit offset/fold. Subscription `_local` columns are historically named TIMESTAMPTZ fields, not timezone-free wall timestamps.
- Source audit timestamps are not retained in the DB. Exact source edit history needs dedicated source-audit columns or an event design, not reuse of ingestion timestamps.
- Physically removed rows are not detected as deletions. Master and six detail-tab in-sync contents are not compared by hash; tombstones and queued statuses—or deliberate `--reprocess`—are required. All six supported detail sources require lifecycle and sync metadata. The unused checksums table does not drive either path.
- Counterparty normalisation can merge differently punctuated names into one key; original per-transaction counterparty spellings are not separately persisted. The registry label can change on later upserts.

## Rules for extending the mapping

For each change, list every Sheet column and every target column, including nullable unpopulated DB fields. Distinguish implemented transformations from proposed mappings. Define units, precision, foreign-key identity, date/zone semantics, source omission policy, lifecycle and row cardinality before adding writes. A field with a similar name is not proof that it holds the same quantity.

Use the GAS schema/import registry and the executed migration chain as the primary contracts; README prose and generated models can lag. Account classification identities begin with the existing database catalog; their source-owned labels and processing policies must synchronize before dependent entities. Currency metadata and externally synchronized rates remain separate prerequisites. The [review checklist](../_runbooks/CODE-REVIEW-INSTRUCTIONS.md) and regression suites apply when mapping changes become code.
