# Account CSV imports

The Accounts import panel sends `import_account_data` with `{ file_type, rows }`. Select the file type explicitly. This is a header-based import; keep the exact names below.

`accounts_master` delegates to account validation and ID-based replacement; see [accounts.md](accounts.md#csv-import). Six detail types are supported:

## `account_deposit`

Tab: `account_deposit`. Account subtypes: `current`, `savings`, `cash`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `account_name` | No |  |
| `is_interest_paid` | No |  |
| `rate_type` | No | `fixed`, `variable` |
| `interest_payment_frequency` | No | `monthly`, `quarterly`, `annually`, `at_maturity` |
| `interest_rate` | No | Finite number when supplied |

## `account_liability_credit_card`

Tab: `account_liability_credit_card`. Account subtypes: `credit_card`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `account_name` | No |  |
| `credit_limit_local` | Yes | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `payment_month_day` | No | Finite number when supplied |
| `statement_month_day` | No | Finite number when supplied |

## `account_liability_mortgage`

Tab: `account_liability_mortgage`. Account subtypes: `mortgage`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `account_name` | No |  |
| `linked_property_account_id` | No | Existing property account when supplied |
| `original_principal_local` | Yes | Finite number when supplied |
| `monthly_payment_local` | No | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `rate_type` | No | `fixed`, `variable` |
| `term_months` | Yes | Finite number when supplied |
| `maturity_date_local` | No |  |

## `account_liability_personal_loan`

Tab: `account_liability_personal_loan`. Account subtypes: `personal_loan`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `account_name` | No |  |
| `original_principal_local` | Yes | Finite number when supplied |
| `monthly_payment_local` | No | Finite number when supplied |
| `interest_rate` | No | Finite number when supplied |
| `term_months` | Yes | Finite number when supplied |
| `maturity_date_local` | No |  |

## `account_investment_property`

Tab: `account_investment_property`. Account subtypes: `property`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `account_name` | No |  |
| `acquisition_type` | Yes | `PURCHASED`, `INHERITED`, `GIFTED` |
| `acquisition_date_local` | No |  |
| `is_rented` | No |  |
| `rent_frequency` | No | `MONTHLY`, `YEARLY` |
| `rent_day` | No | Finite number when supplied |
| `rent_month` | No | Finite number when supplied |
| `current_value_local` | No | Finite number when supplied |
| `property_ownership_percentage` | No | Finite number when supplied |
| `rent_amount_local` | No | Finite number when supplied |
| `rent_ownership_percentage` | No | Finite number when supplied |
| `property_service_charge_frequency` | No | `MONTHLY`, `QUARTERLY`, `YEARLY` |
| `property_service_charge_amount_local` | No | Finite number when supplied |
| `current_value_evaluation_date` | No |  |
| `evaluation_currency_rate_id` | No |  |
| `property_address` | No |  |

## `account_investment_stocks`

Tab: `account_investment_stocks`. Account subtypes: `stocks_shares`.

| Column | Required | Validation |
|---|---|---|
| `id` | Yes |  |
| `account_id` | Yes | Existing account of an allowed subtype |
| `instrument_symbol` | No |  |
| `instrument_name` | No |  |
| `instrument_type` | Yes | `EQUITY`, `ETF`, `MUTUAL_FUND`, `OPTION`, `FUTURE`, `CASH` |
| `instrument_currency_local` | No |  |
| `holding_intent` | No | `LONG_TERM`, `SHORT_TERM`, `TRADING` |
| `position_side` | No | `LONG`, `SHORT` |
| `quantity` | No | Finite number when supplied |
| `avg_cost_price_local` | No | Finite number when supplied |
| `cost_basis_local` | No | Finite number when supplied |
| `current_price_local` | No | Finite number when supplied |
| `current_value_local` | No | Finite number when supplied |
| `price_asof_date` | No |  |
| `evaluation_currency_rate_id` | No |  |
| `underlying_symbol` | No |  |
| `option_type` | No | `CALL`, `PUT` |
| `strike_price_local` | No | Finite number when supplied |
| `expiry_date` | No |  |
| `contract_multiplier` | No | Finite number when supplied |
| `opening_date` | No |  |
| `record_status` | No | `active`, `inactive`, `deleted`, `locked` |

## Replacement and validation

Detail rows require their own `id` and an `account_id`. A matching detail ID replaces the entire row; omitted optional columns become blank. Unknown columns are not persisted. Repeating a detail ID later in the same batch replaces its earlier value. Import the account master before its detail rows.

Validation checks required fields, account existence/subtype, enumerations, finite numeric values, and linked-property references. Financial ranges, boolean/date semantics, and conditional completeness beyond these checks are not yet comprehensively validated.

Response: `{ ok, file_type, created, updated, failed, results }`. Each result has `{ key, ok, action?, error? }`; `ok` is true only if no row failed. Errors include `missing_file_type`, `unknown_file_type`, `missing_rows`, `invalid_row`, `unknown_account`, `sub_type_mismatch`, `invalid_linked_property`, and field-specific `missing_*` / `invalid_*` codes.

## Extraction boundary

These six detail tabs differ from the seven `account_*_details` tables in the older ledger-extract Phase 2 specification. They currently have no sync audit block and are not wired into the Python extractor. Stocks are instrument positions, so several rows can reference one account. Do not assume a one-to-one mapping to the old extension schema. Reconcile the extraction contract before implementing that integration.
