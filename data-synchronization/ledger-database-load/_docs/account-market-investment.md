# Market investment account details

Implemented destination: `account_investment_stocks` after migration 0018. Each source UUID identifies one position; several positions may share an account. Quantities, prices, position side and contract multiplier are preserved independently. The importer does not calculate value from quantity × price, negate short positions, or apply a contract multiplier. Source prices stay decimal major units, separate from legacy integer per-unit fields. Eligibility comes from the configured `detail_sheet` policy; existing legacy rows remain retained independently of that policy.

Sources of truth: [Sheet/import contract](../../../expense-tracker/_docs/account-imports.md), [field contracts](../core/account_detail_contracts.py), [transform](../transforms/account_details.py), [database writer](../database/account_details.py), [field migration 0015](../migrations/0015_account_detail_sheet_contracts.py), and [lifecycle migration 0016](../migrations/0016_account_detail_sync_metadata.py).

## Source → database mapping

Required means the extractor rejects a missing/blank source value. Optional blank values become SQL NULL; no zero, boolean or date is invented. Database nullability is shown separately because retained legacy rows and other source contracts may lack a field.

### `account_investment_stocks`

Eligible accounts: their synchronized `account_types.detail_sheet` must equal `account_investment_stocks`. See [account types](account-types.md).

| Sheet column | DB column | Required source | DB type / nullable | Transformation and validation |
|---|---|---|---|---|
| `id` | `account_investment_stocks.id` | Yes | `UUID` / No | Same source UUID, canonical lowercase; explicit upsert key, never replaced with a generated UUID. |
| `account_id` | `account_investment_stocks.account_master_id` | Yes | `UUID` / No | Same account UUID → FK `account_master.id`; referenced account must exist and its synchronized `detail_sheet` policy must select this tab. |
| `instrument_symbol` | `account_investment_stocks.instrument_symbol` | No | `TEXT` / Yes | Trimmed text; optional blank → NULL. |
| `instrument_name` | `account_investment_stocks.instrument_name` | No | `TEXT` / Yes | Trimmed text; optional blank → NULL. |
| `instrument_type` | `account_investment_stocks.instrument_type` | Yes | `TEXT` / Yes | Allowed: `EQUITY`, `ETF`, `MUTUAL_FUND`, `OPTION`, `FUTURE`, `CASH`. Preserved as supplied. |
| `instrument_currency_local` | `account_investment_stocks.instrument_currency_local` | No | `TEXT` / Yes | Uppercase three-letter currency code, validated against `currency_master`. Blank → NULL here, while effective `local_currency` uses the account currency. |
| `holding_intent` | `account_investment_stocks.holding_intent` | No | `TEXT` / Yes | Allowed: `LONG_TERM`, `SHORT_TERM`, `TRADING`. Preserved as supplied. |
| `position_side` | `account_investment_stocks.position_side` | No | `TEXT` / Yes | Allowed: `LONG`, `SHORT`. Preserved as supplied. |
| `quantity` | `account_investment_stocks.units_held` | No | `NUMERIC(38,18)` / Yes | Decimal preserved without inferred sign, multiplier or ownership arithmetic. Exact NUMERIC(38,18); unrepresentable precision fails. |
| `avg_cost_price_local` | `account_investment_stocks.avg_cost_price_local` | No | `NUMERIC(38,18)` / Yes | Decimal major-unit price; no rounding to currency minor units. Exact NUMERIC(38,18); unrepresentable precision fails. |
| `cost_basis_local` | `account_investment_stocks.cost_basis_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Source sign retained. |
| `current_price_local` | `account_investment_stocks.current_price_local` | No | `NUMERIC(38,18)` / Yes | Decimal major-unit price; no rounding to currency minor units. Exact NUMERIC(38,18); unrepresentable precision fails. |
| `current_value_local` | `account_investment_stocks.current_value_local_value` | No | `BIGINT` / Yes | Finite decimal major units → BIGINT local minor units using the selected currency precision and ROUND_HALF_UP; overflow fails. Source sign retained. |
| `price_asof_date` | `account_investment_stocks.price_asof_date` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `evaluation_currency_rate_id` | `account_investment_stocks.evaluation_currency_rate_id` | No | `UUID` / Yes | Optional canonical UUID retained as supplied. Must resolve to a compatible existing XAU-based rate; see valuation rules below. |
| `underlying_symbol` | `account_investment_stocks.underlying_symbol` | No | `TEXT` / Yes | Trimmed text; optional blank → NULL. |
| `option_type` | `account_investment_stocks.option_type` | No | `TEXT` / Yes | Allowed: `CALL`, `PUT`. Preserved as supplied. |
| `strike_price_local` | `account_investment_stocks.strike_price_local` | No | `NUMERIC(38,18)` / Yes | Decimal major-unit price; no rounding to currency minor units. Exact NUMERIC(38,18); unrepresentable precision fails. |
| `expiry_date` | `account_investment_stocks.expiry_date` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `contract_multiplier` | `account_investment_stocks.contract_multiplier` | No | `NUMERIC(38,18)` / Yes | Decimal preserved without inferred sign, multiplier or ownership arithmetic. Exact NUMERIC(38,18); unrepresentable precision fails. Must be positive. |
| `opening_date` | `account_investment_stocks.opening_date` | No | `TEXT` / Yes | Valid ISO local date/datetime text without UTC offset; preserved in TEXT, no timezone conversion or invented time. |
| `record_status` | `account_investment_stocks.record_status` | Yes | `TEXT` / Yes | Required `active`, `inactive`, `deleted` or `locked`; mirrors lifecycle including tombstone and restore. |
| `sync_status` | Not persisted | Yes | — | Processing control: pending/failed rows are actionable; existing in-sync rows skip unless missing from DB or hard-sync is selected. |
| `sync_date` | Not persisted | No | — | Extractor writes the UTC sync-attempt timestamp after the DB result is known. |
| `sync_notes` | Not persisted | No | — | Extractor writes a safe failure/rollback note or clears it after success. |
| `created_at` | Not copied to DB audit column | No | — | Importer-owned creation time; preserved on replacement. Blank on migrated historical rows when unknown. Extractor never writes it. |
| `updated_at` | Not copied to DB audit column | No | — | Importer/direct-edit timestamp. Extractor never writes it; DB updated_at separately describes ingestion. |

## Additional database columns

Together with the mapped columns above, this lists every column in the table after migration 0018. Legacy-only columns remain NULL on newly imported source rows; retained legacy rows keep their existing values.

| DB column | SQL type / nullable | Origin for imported source rows |
|---|---|---|
| `account_investment_stocks.entity_type` | `TEXT` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_investment_stocks.entity_id` | `UUID` / Yes | NULL for imported rows; no transaction/version cause is inferred. |
| `account_investment_stocks.current_value_base_value` | `BIGINT` / Yes | Current local mark converted to XAU minor units using the supplied/dated existing valuation rate; NULL if local value or valuation basis is absent. XAU local values copy directly. |
| `account_investment_stocks.cost_basis_base_value` | `BIGINT` / Yes | Copies corresponding local minor units only when local currency is XAU. Otherwise NULL: no historical/payment-date conversion basis is provided. |
| `account_investment_stocks.unit_value_local_value` | `BIGINT` / Yes | NULL for imported rows; source unit prices are preserved as decimal fields. |
| `account_investment_stocks.unit_value_base_value` | `BIGINT` / Yes | NULL for imported rows; source unit prices are preserved as decimal fields. |
| `account_investment_stocks.unit_type` | `TEXT` / Yes | NULL for imported rows; instrument type is stored separately. |
| `account_investment_stocks.local_currency` | `CHAR(3)` / No | Effective currency: supplied instrument currency, otherwise `account_master.local_currency`; must exist in `currency_master`. |
| `account_investment_stocks.base_currency` | `CHAR(3)` / No | Constant `XAU` (one gram); base amounts use nine decimal places. |
| `account_investment_stocks.currency_rate_id` | `UUID` / Yes | Selected existing rate used for current valuation. NULL without a valuation basis, and for XAU identity conversion. No rates are written. |
| `account_investment_stocks.effective_from_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; no source effective timestamp is invented. |
| `account_investment_stocks.effective_to_dt` | `TIMESTAMPTZ` / Yes | NULL for imported rows; current source rows do not create or close legacy SCD versions. |
| `account_investment_stocks.source_sheet` | `TEXT` / Yes | Exact source tab name (listed above), set by the extractor and checked against the table’s source-name whitelist. NULL identifies retained legacy rows. |
| `account_investment_stocks.source_account_name` | `TEXT` / Yes | NULL for stock-position imports; the source has no account-name field. |
| `account_investment_stocks.created_at` | `TIMESTAMPTZ` / Yes | Database insertion time (now()); preserved on updates. Pre-migration legacy rows retain unknown NULL audit times. |
| `account_investment_stocks.updated_at` | `TIMESTAMPTZ` / Yes | Database insertion/update time (now()); normal unchanged rows retain their prior value; hard-sync forces an update. |
| `account_investment_stocks.applied_rate_value` | `NUMERIC(19,8)` / Yes | Snapshot of selected local-currency units per XAU gram; 1 for XAU identity, otherwise NULL without a valuation basis. |

## Valuation, identity and synchronization

Money is rounded once from source major units to the selected currency’s minor units (ROUND_HALF_UP), with BIGINT bounds checked. XAU identity conversion copies local minor units into the corresponding base columns and requires nine-decimal currency metadata. Decimal prices, quantities, interest and ownership percentages keep their own declared precision.

For foreign-currency current values, a supplied `evaluation_currency_rate_id` must reference a positive existing XAU-based rate for the effective local currency. If a valuation date is present, that rate cannot be later than the date. Without an explicit UUID, a supplied valuation date selects the latest existing compatible rate on or before that day. A requested rate/date with no compatible rate fails the tab; no rate/date means no base conversion. The valuation date is `current_value_evaluation_date` or, for stock positions, `price_asof_date`. Tables whose source lacks both fields do not invent a valuation date. Cost, principal, credit-limit, purchase-price, rent and payment amounts do not reuse a current-valuation rate. Currency-rates owns rate synchronization; this writer only reads it.

Every imported row keeps the Sheet detail UUID as the database primary key. Updates preserve that UUID and `created_at`; moving a UUID to another account or source tab fails. UUID collisions with retained legacy rows fail instead of overwriting them. Multiple source detail IDs may reference one account. Imported rows have `source_sheet` set and leave SCD effective dates NULL; pre-existing legacy rows (`source_sheet IS NULL`) and their SCD history remain intact.

Normal-sync processes `create-pending`, `create-failed`, `update-pending` and `update-failed`; existing `in-sync` rows skip. An in-sync UUID missing from this source's database rows is requeued for creation. Hard-sync (`--reprocess`) also processes existing in-sync rows. Pending rows whose mapped values already match the database can be acknowledged without changing financial values or DB audit times; rate-only corrections require hard-sync.

The selected rows in each tab commit atomically after validation against the staged snapshot. Success stores only `sync_status=in-sync`, the UTC `sync_date`, and cleared `sync_notes` as the row outcome. If any selected row fails validation, the entire selected batch rolls back; every selected row receives its matching create/update-failed state and a safe failure or rollback note, and downstream entities stop. Earlier entities remain committed. An unexpected dependency error aborts without success outcomes. `ledger-sheet-extract acknowledge` writes the outcomes back and skips rows edited since the snapshot; retries preserve UUIDs after a commit/acknowledgement interruption.

The source `record_status` is required and mirrors `active`, `inactive`, `deleted` or `locked`, including deletion/restoration. Physical removal does not delete DB records. Importer-owned Sheet `created_at`/`updated_at` are never changed by extraction or copied over DB ingestion timestamps. No transaction-driven balance trail or SCD version is generated. See [the common detail contract](account-details.md) for schema upgrades and import ownership.

[All account detail families](account-details.md) · [Account master mapping](account-master.md)
