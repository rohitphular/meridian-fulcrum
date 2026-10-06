# Property account details

Implemented destination: `account_investment_property` after migration 0018. Acquisition can be `PURCHASED`, `INHERITED` or `GIFTED`; it does not imply a purchase price/date. The importer preserves source value, ownership percentages and rent/service-charge schedules independently. It does not multiply amounts by ownership, annualize/monthly-normalize rent, or derive the legacy rental fields.

Sources of truth: [Sheet/import contract](../../../expense-tracker/_docs/account-imports.md), [field contracts](../core/account_detail_contracts.py), [transform](../transforms/account_details.py), [database writer](../database/account_details.py), [field migration 0015](../migrations/0015_account_detail_sheet_contracts.py), and [lifecycle migration 0016](../migrations/0016_account_detail_sync_metadata.py).

## Source → database mapping

Required means the extractor rejects a missing/blank source value. Optional blank values become SQL NULL; no zero, boolean or date is invented. Database nullability is shown separately because retained legacy rows and other source contracts may lack a field.

### `account_investment_property`

Eligible accounts: their synchronized `account_types.detail_sheet` must equal `account_investment_property`. See [account types](account-types.md).

| Sheet column | DB column | Required source | DB type / nullable | Transformation and validation |
|---|---|---|---|---|
| `id` | `account_investment_property.id` | Yes | `UUID` / No | Same source UUID, canonical lowercase; explicit upsert key, never replaced with a generated UUID. |
| `account_id` | `account_investment_property.account_master_id` | Yes | `UUID` / No | Same account UUID → FK `account_master.id`; referenced account must exist and its synchronized `detail_sheet` policy must select this tab. |
| `account_name` | `account_investment_property.source_account_name` | No | `TEXT` / Yes | Trimmed descriptive source text; does not rename `account_master`. |
| `acquisition_type` | `account_investment_property.acquisition_type` | Yes | `TEXT` / Yes | Allowed: `PURCHASED`, `INHERITED`, `GIFTED`. Preserved as supplied. |
| `acquisition_date_local` | `account_investment_property.acquisition_date_local` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `is_rented` | `account_investment_property.is_rented` | No | `BOOLEAN` / Yes | Boolean; accepts true/false, yes/no or 1/0 (case-insensitive). Blank → NULL. |
| `rent_frequency` | `account_investment_property.rent_frequency` | No | `TEXT` / Yes | Allowed: `MONTHLY`, `YEARLY`. Preserved as supplied. |
| `rent_day` | `account_investment_property.rent_day` | No | `INTEGER` / Yes | Exact integer 1–31; fractional/out-of-range values fail. |
| `rent_month` | `account_investment_property.rent_month` | No | `INTEGER` / Yes | Exact integer 1–12; fractional/out-of-range values fail. |
| `current_value_local` | `account_investment_property.current_value_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Nonnegative. |
| `property_ownership_percentage` | `account_investment_property.property_ownership_percentage` | No | `NUMERIC(38,18)` / Yes | Decimal preserved without inferred sign, multiplier or ownership arithmetic. Exact NUMERIC(38,18); unrepresentable precision fails. Must be 0–100 percentage points. |
| `rent_amount_local` | `account_investment_property.rent_amount_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Nonnegative. |
| `rent_ownership_percentage` | `account_investment_property.rent_ownership_percentage` | No | `NUMERIC(38,18)` / Yes | Decimal preserved without inferred sign, multiplier or ownership arithmetic. Exact NUMERIC(38,18); unrepresentable precision fails. Must be 0–100 percentage points. |
| `property_service_charge_frequency` | `account_investment_property.property_service_charge_frequency` | No | `TEXT` / Yes | Allowed: `MONTHLY`, `QUARTERLY`, `YEARLY`. Preserved as supplied. |
| `property_service_charge_amount_local` | `account_investment_property.property_service_charge_amount_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Nonnegative. |
| `current_value_evaluation_date` | `account_investment_property.current_value_evaluation_date` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `property_address` | `account_investment_property.property_address` | No | `TEXT` / Yes | Trimmed text; optional blank → NULL. |
| `record_status` | `account_investment_property.record_status` | Yes | `TEXT` / Yes | Required `active`, `inactive`, `deleted` or `locked`; mirrors lifecycle including tombstone and restore. Legacy DB rows remain nullable until replay. |
| `sync_status` | Not persisted | Yes | — | Processing control: pending/failed rows are actionable; existing in-sync rows skip unless missing from DB or hard-sync is selected. |
| `sync_date` | Not persisted | No | — | Extractor writes the UTC sync-attempt timestamp after the DB result is known. |
| `sync_notes` | Not persisted | No | — | Extractor writes a safe failure/rollback note or clears it after success. |
| `created_at` | Not copied to DB audit column | No | — | Importer-owned creation time; preserved on replacement. Blank on migrated historical rows when unknown. Extractor never writes it. |
| `updated_at` | Not copied to DB audit column | No | — | Importer/direct-edit timestamp. Extractor never writes it; DB updated_at separately describes ingestion. |

## Additional database columns

Together with the mapped columns above, this lists every column in the table after migration 0018. Legacy-only columns remain NULL on newly imported source rows; retained legacy rows keep their existing values.

| DB column | SQL type / nullable | Origin for imported source rows |
|---|---|---|
| `account_investment_property.evaluation_currency_rate_id` | `UUID` / Yes | Retired source field retained only for historical data. NULL on new property rows; existing values are neither consulted nor overwritten by the extractor. Current valuation uses the date and derived rate fields below. |
| `account_investment_property.entity_type` | `TEXT` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_investment_property.entity_id` | `UUID` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_investment_property.purchase_price_local_value` | `BIGINT` / Yes | NULL for property imports; source has no purchase-price amount. |
| `account_investment_property.purchase_price_base_value` | `BIGINT` / Yes | NULL for property imports; source has no purchase-price amount. |
| `account_investment_property.current_value_base_value` | `BIGINT` / Yes | Current local mark converted to XAU minor units using the latest existing compatible rate on or before current_value_evaluation_date; NULL if local value or valuation basis is absent. XAU local values copy directly. |
| `account_investment_property.monthly_rental_income_local_value` | `BIGINT` / Yes | NULL for imported rows; rent frequency and amount are preserved without monthly normalization. |
| `account_investment_property.monthly_rental_income_base_value` | `BIGINT` / Yes | NULL for imported rows; rent frequency and amount are preserved without monthly normalization. |
| `account_investment_property.local_currency` | `CHAR(3)` / No | From `account_master.local_currency`; must exist in `currency_master`. |
| `account_investment_property.base_currency` | `CHAR(3)` / No | Constant `XAU` (one gram); base amounts use nine decimal places. |
| `account_investment_property.currency_rate_id` | `UUID` / Yes | Selected existing rate used for current valuation. NULL without a valuation basis, and for XAU identity conversion. No rates are written. |
| `account_investment_property.purchase_date` | `DATE` / Yes | NULL for imported rows; an acquisition is not necessarily a purchase. |
| `account_investment_property.is_rental` | `BOOLEAN` / Yes | NULL for imported rows; source `is_rented` is stored separately; no default FALSE is inferred. |
| `account_investment_property.effective_from_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; no source effective timestamp is invented. |
| `account_investment_property.effective_to_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; current source rows do not create or close legacy SCD versions. |
| `account_investment_property.source_sheet` | `TEXT` / Yes | Exact source tab name (listed above), set by the extractor and checked against the table’s source-name whitelist. NULL identifies retained legacy rows. |
| `account_investment_property.created_at` | `TIMESTAMPTZ` / Yes | Database insertion time (now()); preserved on updates. Pre-migration legacy rows retain unknown NULL audit times. |
| `account_investment_property.updated_at` | `TIMESTAMPTZ` / Yes | Database insertion/update time (now()); normal unchanged rows retain their prior value; hard-sync forces an update. |
| `account_investment_property.applied_rate_value` | `NUMERIC(19,8)` / Yes | Snapshot of selected local-currency units per XAU gram; 1 for XAU identity, otherwise NULL without a valuation basis. |
| `account_investment_property.rent_amount_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |
| `account_investment_property.property_service_charge_amount_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |

## Valuation, identity and synchronization

Money is rounded once from source major units to the selected currency’s minor units (ROUND_HALF_UP), with BIGINT bounds checked. XAU identity conversion copies local minor units into the corresponding base columns and requires nine-decimal currency metadata. Decimal prices, quantities, interest and ownership percentages keep their own declared precision.

Property valuations use `current_value_evaluation_date` only. The writer selects the latest positive XAU-based rate for the account currency on or before that local date. A supplied date with no compatible rate fails the tab; an absent date leaves foreign current base value, derived rate ID and applied rate NULL. The removed `evaluation_currency_rate_id` is not read from input and cannot override this selection. Any historical value retained in that database column is also ignored. Cost, rent and payment amounts do not reuse the current-value rate. Currency-rates owns rate synchronization; this writer only reads it.

Every imported row keeps the Sheet detail UUID as the database primary key. Updates preserve that UUID and `created_at`; moving a UUID to another account or source tab fails. UUID collisions with retained legacy rows fail instead of overwriting them. Multiple source detail IDs may reference one account. Imported rows have `source_sheet` set and leave SCD effective dates NULL; pre-existing legacy rows (`source_sheet IS NULL`) and their SCD history remain intact.

Normal-sync processes `create-pending`, `create-failed`, `update-pending` and `update-failed`; existing `in-sync` rows skip. An in-sync UUID missing from this source's database rows is requeued for creation. Hard-sync (`--reprocess`) also processes existing in-sync rows. Pending rows whose mapped values already match the database can be acknowledged without changing financial values or DB audit times; rate-only corrections require hard-sync.

The selected rows in each tab commit atomically after validation against the staged snapshot. Success stores only `sync_status=in-sync`, the UTC `sync_date`, and cleared `sync_notes` as the row outcome. If any selected row fails validation, the entire selected batch rolls back; every selected row receives its matching create/update-failed state and a safe failure or rollback note, and downstream entities stop. Earlier entities remain committed. An unexpected dependency error aborts without success outcomes. `ledger-sheet-extract acknowledge` writes the outcomes back and skips rows edited since the snapshot; retries preserve UUIDs after a commit/acknowledgement interruption.

The source `record_status` is required and mirrors `active`, `inactive`, `deleted` or `locked`, including deletion/restoration. Physical removal does not delete DB records. Importer-owned Sheet `created_at`/`updated_at` are never changed by extraction or copied over DB ingestion timestamps. No transaction-driven balance trail or SCD version is generated. See [the common detail contract](account-details.md) for schema upgrades and import ownership.

## Removing the old Sheet column

Deploy the updated backend and run `migrateAccountPropertyRateColumn()` before importing or extracting an existing property tab with the retired column. The helper validates the old layout and removes the interior column without shifting address or metadata values into incorrect fields. It also initializes missing metadata and queues the affected rows. Run **hard-sync once** to apply date-only valuation to existing DB rows: normal-sync can acknowledge identical mapped content without recalculating an old valuation. See the [source migration guide](../../../expense-tracker/_docs/account-imports.md). No database column is dropped and no live migration was run by this code change.

[All account detail families](account-details.md) · [Account master mapping](account-master.md)
