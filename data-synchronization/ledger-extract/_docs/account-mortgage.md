# Mortgage account details

Sheet and database table: `account_liability_mortgage`, after migration `0018`. The Sheet UUID remains the primary key and cannot be reassigned to another account. Mortgage and personal-loan tables are separate; their UUID namespaces are independent. Existing supported legacy loan history is preserved during the split, using source provenance checked against the owning account subtype. Ambiguous legacy rows stop the migration for reconciliation.

Sources of truth: [Sheet/import contract](../../../expense-tracker/_docs/account-imports.md), [field contracts](../core/account_detail_contracts.py), [transform](../transforms/account_details.py), [database writer](../database/account_details.py), and [table migration](../migrations/0018_align_account_detail_tables.py).

## Source → database mapping

Required means the extractor rejects a missing/blank source value. Optional blank values become SQL NULL; no zero, boolean or date is invented. Database nullability also accommodates retained legacy rows.

### `account_liability_mortgage`

Eligible accounts: their synchronized `account_types.detail_sheet` must equal `account_liability_mortgage`. See [account types](account-types.md).

| Sheet column | DB column | Required source | DB type / nullable | Transformation and validation |
|---|---|---|---|---|
| `id` | `account_liability_mortgage.id` | Yes | `UUID` / No | Same source UUID, canonical lowercase; explicit upsert key, never replaced with a generated UUID. |
| `account_id` | `account_liability_mortgage.account_master_id` | Yes | `UUID` / No | Same account UUID → FK `account_master.id`; referenced account must exist and its synchronized `detail_sheet` policy must select this tab. |
| `account_name` | `account_liability_mortgage.source_account_name` | No | `TEXT` / Yes | Trimmed descriptive source text; does not rename `account_master`. |
| `linked_property_account_id` | `account_liability_mortgage.linked_property_account_id` | No | `UUID` / Yes | Optional canonical UUID → FK `account_master.id`; referenced subtype must be `property`. |
| `original_principal_local` | `account_liability_mortgage.original_principal_amount_local_value` | Yes | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Must be positive both before and after conversion; positive amounts that round to zero minor units fail. |
| `monthly_payment_local` | `account_liability_mortgage.monthly_payment_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Nonnegative. |
| `interest_rate` | `account_liability_mortgage.interest_rate` | No | `NUMERIC(38,18)` / Yes | Percentage points, e.g. 4.25 means 4.25%; no division by 100. Exact NUMERIC(38,18); unrepresentable precision fails. Must be nonnegative. |
| `rate_type` | `account_liability_mortgage.rate_type` | No | `TEXT` / Yes | Allowed: `fixed`, `variable`. Preserved as supplied. |
| `term_months` | `account_liability_mortgage.term_months` | Yes | `INTEGER` / Yes | Exact integer 1–2147483647; fractional/out-of-range values fail. |
| `maturity_date_local` | `account_liability_mortgage.maturity_date_local` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `record_status` | `account_liability_mortgage.record_status` | Yes | `TEXT` / Yes | Required `active`, `inactive`, `deleted` or `locked`; mirrors lifecycle including tombstone and restore. Legacy DB rows remain nullable until replay. |
| `sync_status` | Not persisted | Yes | — | Processing control: pending/failed rows are actionable; existing in-sync rows skip unless missing from DB or hard-sync is selected. |
| `sync_date` | Not persisted | No | — | Extractor writes the UTC sync-attempt timestamp after the DB result is known. |
| `sync_notes` | Not persisted | No | — | Extractor writes a safe failure/rollback note or clears it after success. |
| `created_at` | Not copied to DB audit column | No | — | Importer-owned creation time; preserved on replacement. Blank on migrated historical rows when unknown. Extractor never writes it. |
| `updated_at` | Not copied to DB audit column | No | — | Importer/direct-edit timestamp. Extractor never writes it; DB updated_at separately describes ingestion. |

## Additional database columns

Together with the mapped columns above, this lists every column in the table after migration 0018. Legacy-only columns remain NULL on newly imported source rows; retained legacy rows keep their existing values.

| DB column | SQL type / nullable | Origin for imported source rows |
|---|---|---|
| `account_liability_mortgage.entity_type` | `TEXT` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_liability_mortgage.entity_id` | `UUID` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_liability_mortgage.original_principal_amount_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |
| `account_liability_mortgage.outstanding_balance_local_value` | `BIGINT` / Yes | NULL for imported rows; neither loan source has an outstanding balance. |
| `account_liability_mortgage.outstanding_balance_base_value` | `BIGINT` / Yes | NULL for imported rows; neither loan source has an outstanding balance. |
| `account_liability_mortgage.monthly_payment_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |
| `account_liability_mortgage.local_currency` | `CHAR(3)` / No | From `account_master.local_currency`; must exist in `currency_master`. |
| `account_liability_mortgage.base_currency` | `CHAR(3)` / No | Constant `XAU` (one gram); base amounts use nine decimal places. |
| `account_liability_mortgage.currency_rate_id` | `UUID` / Yes | Selected existing rate used for current valuation. NULL without a valuation basis, and for XAU identity conversion. No rates are written. |
| `account_liability_mortgage.start_date` | `DATE` / Yes | NULL for imported rows; no legacy DATE value is inferred from account or local source dates. |
| `account_liability_mortgage.end_date` | `DATE` / Yes | NULL for imported rows; local source maturity is preserved separately. |
| `account_liability_mortgage.effective_from_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; no source effective timestamp is invented. |
| `account_liability_mortgage.effective_to_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; current source rows do not create or close legacy SCD versions. |
| `account_liability_mortgage.source_sheet` | `TEXT` / Yes | Exact source tab name (listed above), set by the extractor and checked against the table’s source-name whitelist. NULL identifies retained legacy rows. |
| `account_liability_mortgage.created_at` | `TIMESTAMPTZ` / Yes | Database insertion time (now()); preserved on updates. Pre-migration legacy rows retain unknown NULL audit times. |
| `account_liability_mortgage.updated_at` | `TIMESTAMPTZ` / Yes | Database insertion/update time (now()); normal unchanged rows retain their prior value; hard-sync forces an update. |
| `account_liability_mortgage.applied_rate_value` | `NUMERIC(19,8)` / Yes | Snapshot of selected local-currency units per XAU gram; 1 for XAU identity, otherwise NULL without a valuation basis. |

Neither loan source supplies an outstanding balance or loan start date. Personal-loan imports have no property link or rate type; retained legacy values remain intact.

## Valuation, identity and synchronization

Money is rounded once from source major units to the selected currency’s minor units (ROUND_HALF_UP), with BIGINT bounds checked. XAU identity conversion copies local minor units into the corresponding base columns and requires nine-decimal currency metadata. Decimal prices, quantities, interest and ownership percentages keep their own declared precision.

Neither loan source supplies valuation dates or rate references. For foreign currency, principal/payment base amounts and applied-rate fields stay NULL; no conversion date is inferred from maturity or account dates. For XAU, the corresponding base/local minor-unit amounts are equal. Currency-rates owns rate synchronization; this extractor writes no rates.

Every imported row keeps the Sheet detail UUID as the database primary key. Updates preserve that UUID and `created_at`; moving a UUID to another account fails. UUID collisions with retained legacy rows fail instead of overwriting them. Multiple source detail IDs may reference one account. Imported rows have `source_sheet` set and leave SCD effective dates NULL; pre-existing legacy rows (`source_sheet IS NULL`) and their SCD history remain intact.

Normal-sync processes `create-pending`, `create-failed`, `update-pending` and `update-failed`; existing `in-sync` rows skip. An in-sync UUID missing from this source's database rows is requeued for creation. Hard-sync (`--reprocess`) also processes existing in-sync rows. Pending rows whose mapped values already match the database can be acknowledged without changing financial values or DB audit times; rate-only corrections require hard-sync.

The selected rows in each tab commit atomically after validation and a source-snapshot check. Success queues only `sync_status=in-sync`, the UTC `sync_date`, and cleared `sync_notes`. If any selected row fails validation, the entire selected batch rolls back; every selected row receives its matching create/update-failed state and a safe failure or rollback note, and downstream entities stop. Earlier entities remain committed. A source-change or unexpected dependency error aborts without success acknowledgements. Sheet acknowledgements are guarded again before writeback; retries preserve UUIDs after a commit/writeback interruption.

The source `record_status` is required and mirrors `active`, `inactive`, `deleted` or `locked`, including deletion/restoration. Physical removal does not delete DB records. Importer-owned Sheet `created_at`/`updated_at` are never changed by extraction or copied over DB ingestion timestamps. No transaction-driven balance trail or SCD version is generated. See [the common detail contract](account-details.md) for schema upgrades and import ownership.

[All account detail families](account-details.md) · [Account master mapping](account-master.md)
