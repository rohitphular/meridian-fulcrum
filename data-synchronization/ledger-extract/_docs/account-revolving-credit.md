# Revolving credit account details

Implemented destination: `account_liability_credit_card` after migration 0018. The source describes credit-card terms. Nominal `interest_rate` is preserved separately from legacy `annual_percentage_rate`; no APR or rate type is invented. Current debt and minimum-payment amounts have no source. Legacy rows remain retained; current import eligibility follows each classification’s synchronized `detail_sheet` policy.

Sources of truth: [Sheet/import contract](../../../expense-tracker/_docs/account-imports.md), [field contracts](../core/account_detail_contracts.py), [transform](../transforms/account_details.py), [database writer](../database/account_details.py), [field migration 0015](../migrations/0015_account_detail_sheet_contracts.py), and [lifecycle migration 0016](../migrations/0016_account_detail_sync_metadata.py).

## Source → database mapping

Required means the extractor rejects a missing/blank source value. Optional blank values become SQL NULL; no zero, boolean or date is invented. Database nullability is shown separately because retained legacy rows and other source contracts may lack a field.

### `account_liability_credit_card`

Eligible accounts: their synchronized `account_types.detail_sheet` must equal `account_liability_credit_card`. See [account types](account-types.md).

| Sheet column | DB column | Required source | DB type / nullable | Transformation and validation |
|---|---|---|---|---|
| `id` | `account_liability_credit_card.id` | Yes | `UUID` / No | Same source UUID, canonical lowercase; explicit upsert key, never replaced with a generated UUID. |
| `account_id` | `account_liability_credit_card.account_master_id` | Yes | `UUID` / No | Same account UUID → FK `account_master.id`; referenced account must exist and its synchronized `detail_sheet` policy must select this tab. |
| `account_name` | `account_liability_credit_card.source_account_name` | No | `TEXT` / Yes | Trimmed descriptive source text; does not rename `account_master`. |
| `credit_limit_local` | `account_liability_credit_card.credit_limit_local_value` | Yes | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Nonnegative. |
| `interest_rate` | `account_liability_credit_card.interest_rate` | No | `NUMERIC(38,18)` / Yes | Percentage points, e.g. 4.25 means 4.25%; no division by 100. Exact NUMERIC(38,18); unrepresentable precision fails. Must be nonnegative. |
| `payment_month_day` | `account_liability_credit_card.payment_due_day` | No | `INTEGER` / Yes | Exact integer 1–31; fractional/out-of-range values fail. |
| `statement_month_day` | `account_liability_credit_card.statement_day` | No | `INTEGER` / Yes | Exact integer 1–31; fractional/out-of-range values fail. |
| `record_status` | `account_liability_credit_card.record_status` | Yes | `TEXT` / Yes | Required `active`, `inactive`, `deleted` or `locked`; mirrors lifecycle including tombstone and restore. Legacy DB rows remain nullable until replay. |
| `sync_status` | Not persisted | Yes | — | Processing control: pending/failed rows are actionable; existing in-sync rows skip unless missing from DB or hard-sync is selected. |
| `sync_date` | Not persisted | No | — | Extractor writes the UTC sync-attempt timestamp after the DB result is known. |
| `sync_notes` | Not persisted | No | — | Extractor writes a safe failure/rollback note or clears it after success. |
| `created_at` | Not copied to DB audit column | No | — | Importer-owned creation time; preserved on replacement. Blank on migrated historical rows when unknown. Extractor never writes it. |
| `updated_at` | Not copied to DB audit column | No | — | Importer/direct-edit timestamp. Extractor never writes it; DB updated_at separately describes ingestion. |

## Additional database columns

Together with the mapped columns above, this lists every column in the table after migration 0018. Legacy-only columns remain NULL on newly imported source rows; retained legacy rows keep their existing values.

| DB column | SQL type / nullable | Origin for imported source rows |
|---|---|---|
| `account_liability_credit_card.entity_type` | `TEXT` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_liability_credit_card.entity_id` | `UUID` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_liability_credit_card.credit_limit_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |
| `account_liability_credit_card.current_balance_local_value` | `BIGINT` / Yes | NULL for imported rows; the source has no current balance. |
| `account_liability_credit_card.current_balance_base_value` | `BIGINT` / Yes | NULL for imported rows; the source has no current balance. |
| `account_liability_credit_card.minimum_payment_local_value` | `BIGINT` / Yes | NULL for imported rows; the source has no minimum-payment amount. |
| `account_liability_credit_card.minimum_payment_base_value` | `BIGINT` / Yes | NULL for imported rows; the source has no minimum-payment amount. |
| `account_liability_credit_card.local_currency` | `CHAR(3)` / No | From `account_master.local_currency`; must exist in `currency_master`. |
| `account_liability_credit_card.base_currency` | `CHAR(3)` / No | Constant `XAU` (one gram); base amounts use nine decimal places. |
| `account_liability_credit_card.currency_rate_id` | `UUID` / Yes | Selected existing rate used for current valuation. NULL without a valuation basis, and for XAU identity conversion. No rates are written. |
| `account_liability_credit_card.annual_percentage_rate` | `NUMERIC(38,18)` / Yes | NULL for imported rows; nominal source interest is not APR. |
| `account_liability_credit_card.rate_type` | `TEXT` / Yes | NULL when absent from the selected source contract; no fixed/variable assumption. |
| `account_liability_credit_card.effective_from_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; no source effective timestamp is invented. |
| `account_liability_credit_card.effective_to_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; current source rows do not create or close legacy SCD versions. |
| `account_liability_credit_card.source_sheet` | `TEXT` / Yes | Exact source tab name (listed above), set by the extractor and checked against the table’s source-name whitelist. NULL identifies retained legacy rows. |
| `account_liability_credit_card.created_at` | `TIMESTAMPTZ` / Yes | Database insertion time (now()); preserved on updates. Pre-migration legacy rows retain unknown NULL audit times. |
| `account_liability_credit_card.updated_at` | `TIMESTAMPTZ` / Yes | Database insertion/update time (now()); normal unchanged rows retain their prior value; hard-sync forces an update. |
| `account_liability_credit_card.applied_rate_value` | `NUMERIC(19,8)` / Yes | Snapshot of selected local-currency units per XAU gram; 1 for XAU identity, otherwise NULL without a valuation basis. |

## Valuation, identity and synchronization

Money is rounded once from source major units to the selected currency’s minor units (ROUND_HALF_UP), with BIGINT bounds checked. XAU identity conversion copies local minor units into the corresponding base columns and requires nine-decimal currency metadata. Decimal prices, quantities, interest and ownership percentages keep their own declared precision.

For foreign-currency current values, a supplied `evaluation_currency_rate_id` must reference a positive existing XAU-based rate for the effective local currency. If a valuation date is present, that rate cannot be later than the date. Without an explicit UUID, a supplied valuation date selects the latest existing compatible rate on or before that day. A requested rate/date with no compatible rate fails the tab; no rate/date means no base conversion. The valuation date is `current_value_evaluation_date` or, for stock positions, `price_asof_date`. Tables whose source lacks both fields do not invent a valuation date. Cost, principal, credit-limit, purchase-price, rent and payment amounts do not reuse a current-valuation rate. Currency-rates owns rate synchronization; this writer only reads it.

Every imported row keeps the Sheet detail UUID as the database primary key. Updates preserve that UUID and `created_at`; moving a UUID to another account or source tab fails. UUID collisions with retained legacy rows fail instead of overwriting them. Multiple source detail IDs may reference one account. Imported rows have `source_sheet` set and leave SCD effective dates NULL; pre-existing legacy rows (`source_sheet IS NULL`) and their SCD history remain intact.

Normal-sync processes `create-pending`, `create-failed`, `update-pending` and `update-failed`; existing `in-sync` rows skip. An in-sync UUID missing from this source's database rows is requeued for creation. Hard-sync (`--reprocess`) also processes existing in-sync rows. Pending rows whose mapped values already match the database can be acknowledged without changing financial values or DB audit times; rate-only corrections require hard-sync.

The selected rows in each tab commit atomically after validation and a source-snapshot check. Success queues only `sync_status=in-sync`, the UTC `sync_date`, and cleared `sync_notes`. If any selected row fails validation, the entire selected batch rolls back; every selected row receives its matching create/update-failed state and a safe failure or rollback note, and downstream entities stop. Earlier entities remain committed. A source-change or unexpected dependency error aborts without success acknowledgements. Sheet acknowledgements are guarded again before writeback; retries preserve UUIDs after a commit/writeback interruption.

The source `record_status` is required and mirrors `active`, `inactive`, `deleted` or `locked`, including deletion/restoration. Physical removal does not delete DB records. Importer-owned Sheet `created_at`/`updated_at` are never changed by extraction or copied over DB ingestion timestamps. No transaction-driven balance trail or SCD version is generated. See [the common detail contract](account-details.md) for schema upgrades and import ownership.

[All account detail families](account-details.md) · [Account master mapping](account-master.md)
