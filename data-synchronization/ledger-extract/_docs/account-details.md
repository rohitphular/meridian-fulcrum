# Account details: source inventory and unmapped database schema

**None of the six account detail tabs is read or written by ledger-extract.** The seven legacy `account_*_details` tables exist in migrations, but the current account and transaction writers do not seed them, update balances, or maintain SCD history. Every current source-to-database mapping below is therefore **None**. Similar names are candidate correspondences only, not a conversion specification.

Sources: [GAS import registry](../../../expense-tracker/api/import-registry.gs), [GAS import writer](../../../expense-tracker/api/import-core.gs), [account import documentation](../../../expense-tracker/_docs/account-imports.md), [extractor supported headers](../sheets/contracts.py), [original extension DDL](../migrations/0004_create_accounts.py), and [legacy rate-column rename](../migrations/0009_rename_currency_rate_ref_to_currency_rate_id.py). The implemented master mapping is in [accounts.md](accounts.md).

## How the current detail sheets behave

The registry declares **six tabs and 72 columns in total**. They are keyed by their own `id`, not by `account_id`. Re-import of a matching detail ID replaces every declared cell; omitted optional cells become blank. Multiple different detail IDs can reference the same account, including multiple stock positions. Required IDs are only checked for nonempty values in this GAS path; a valid UUID format is not enforced for detail `id`.

GAS validates the account reference and allowed account subtype, declared enums, finite numeric inputs, and a supplied mortgage/property link. It does not supply comprehensive numeric ranges, integer checks, date/boolean parsing, or instrument-specific completeness. All six tabs lack `sync_status`, `sync_date`, `sync_notes`, `created_at`, and `updated_at`; only stocks has `record_status`. The current Python snapshot/checkpoint/writeback contract cannot simply be pointed at these tabs.

## Every current detail sheet column

The last column identifies a possible legacy destination or an unresolved mismatch. It does **not** authorize dropping unmatched fields, inventing required values, treating a sheet detail ID as an SCD version ID, or overwriting one instrument with another.

### `account_deposit` — 7 columns

Allowed account subtypes: `current, savings, cash`. Closest legacy table: `account_deposit_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Detail identity has no implemented mapping; legacy DB generates a new version UUID, so source-ID retention needs a separate decision. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`; requires a resolved master UUID. |
| 3 | `account_name` | No | **None** | No extension column; master `account_name` exists, but detail text must not rename the master implicitly. |
| 4 | `is_interest_paid` | No | **None** | No legacy column; boolean interpretation and its relationship to rate/frequency are undefined. |
| 5 | `rate_type` | No | **None** | Candidate `rate_type`; sheet accepts `fixed`, `variable`; DB also permits `tracker`. |
| 6 | `interest_payment_frequency` | No | **None** | Candidate same-name column; sheet `annually` differs from DB `annual`; sheet `at_maturity` has no DB enum; DB `semi_annual` has no sheet enum. |
| 7 | `interest_rate` | No | **None** | Candidate `interest_rate NUMERIC(8,4)`; percentage/fraction convention and precision policy remain to define. |

### `account_liability_credit_card` — 7 columns

Allowed account subtypes: `credit_card`. Closest legacy table: `account_revolving_credit_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Source detail identity versus generated DB version UUID is unresolved. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`. |
| 3 | `account_name` | No | **None** | No extension column; redundant master label only. |
| 4 | `credit_limit_local` | Yes | **None** | Candidate `credit_limit_local_value` plus derived `credit_limit_base_value`; major-to-minor conversion, currency and valuation date required. |
| 5 | `interest_rate` | No | **None** | Possible `annual_percentage_rate`; nominal interest and APR are not automatically equivalent. Sheet has no paired `rate_type` required by DB when APR is present. |
| 6 | `payment_month_day` | No | **None** | Possible `payment_due_day`; sheet finite-number check does not enforce integer 1–31. |
| 7 | `statement_month_day` | No | **None** | Possible `statement_day`; sheet finite-number check does not enforce integer 1–31. |

### `account_liability_mortgage` — 10 columns

Allowed account subtypes: `mortgage`. Closest legacy table: `account_installment_loan_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Source detail identity versus generated DB version UUID is unresolved. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`. |
| 3 | `account_name` | No | **None** | No extension column; redundant master label only. |
| 4 | `linked_property_account_id` | No | **None** | No legacy column; GAS validates an existing property account, but DB has no mortgage/property relationship field. |
| 5 | `original_principal_local` | Yes | **None** | Candidate `original_principal_amount_local_value` plus base amount; major-to-minor conversion and origination-date FX are undefined. |
| 6 | `monthly_payment_local` | No | **None** | Candidate local/base monthly payment columns; optional in sheet but DB requires positive values. |
| 7 | `interest_rate` | No | **None** | Candidate `interest_rate`; optional in sheet but DB NOT NULL. |
| 8 | `rate_type` | No | **None** | Candidate `rate_type`; sheet optional `fixed`/`variable`; DB NOT NULL and additionally permits `tracker`. |
| 9 | `term_months` | Yes | **None** | Candidate same-name integer column; sheet requires a finite number, not a positive integer. |
| 10 | `maturity_date_local` | No | **None** | Candidate `end_date DATE`; optional/unvalidated date in sheet, required and after `start_date` in DB. |

### `account_liability_personal_loan` — 8 columns

Allowed account subtypes: `personal_loan`. Closest legacy table: `account_installment_loan_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Source detail identity versus generated DB version UUID is unresolved. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`. |
| 3 | `account_name` | No | **None** | No extension column; redundant master label only. |
| 4 | `original_principal_local` | Yes | **None** | Candidate `original_principal_amount_local_value` plus base amount; major-to-minor conversion and origination-date FX are undefined. |
| 5 | `monthly_payment_local` | No | **None** | Candidate local/base monthly payment columns; optional in sheet but DB requires positive values. |
| 6 | `interest_rate` | No | **None** | Candidate `interest_rate`; optional in sheet but DB NOT NULL. No sheet `rate_type` column exists. |
| 7 | `term_months` | Yes | **None** | Candidate same-name integer column; required finite sheet number can still be fractional/nonpositive. |
| 8 | `maturity_date_local` | No | **None** | Candidate `end_date DATE`; sheet optional/unvalidated, DB required and strictly after `start_date`. |

### `account_investment_property` — 18 columns

Allowed account subtypes: `property`. Closest legacy table: `account_property_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Source detail identity versus generated DB version UUID is unresolved. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`. |
| 3 | `account_name` | No | **None** | No extension column; redundant master label only. |
| 4 | `acquisition_type` | Yes | **None** | No legacy column. Required sheet `PURCHASED`, `INHERITED`, `GIFTED`; inherited/gifted property conflicts with assuming a required positive purchase price. |
| 5 | `acquisition_date_local` | No | **None** | Possible `purchase_date`, but acquisition is not always purchase; date semantics require a decision. |
| 6 | `is_rented` | No | **None** | Possible `is_rental`; sheet does not validate or normalize this as a boolean. |
| 7 | `rent_frequency` | No | **None** | No DB field; `MONTHLY`/`YEARLY` could inform conversion to monthly rent, but the policy is unimplemented. |
| 8 | `rent_day` | No | **None** | No DB field for rent payment day; sheet only checks finite number. |
| 9 | `rent_month` | No | **None** | No DB field for rent payment month; sheet only checks finite number. |
| 10 | `current_value_local` | No | **None** | Candidate current-value local/base columns; gross versus ownership-adjusted valuation must be specified. |
| 11 | `property_ownership_percentage` | No | **None** | No DB field. Percentage range and whether source valuation is whole-property or already attributable are undefined. |
| 12 | `rent_amount_local` | No | **None** | Possible monthly-rental local/base values after explicit frequency and ownership treatment; cannot copy yearly rent directly. |
| 13 | `rent_ownership_percentage` | No | **None** | No DB field; attribution may differ from property ownership. |
| 14 | `property_service_charge_frequency` | No | **None** | No DB field; sheet enum `MONTHLY`, `QUARTERLY`, `YEARLY`. |
| 15 | `property_service_charge_amount_local` | No | **None** | No DB monetary field for service charges. |
| 16 | `current_value_evaluation_date` | No | **None** | No dedicated legacy field; valuation date is not automatically SCD `effective_from_dt` or purchase date. |
| 17 | `evaluation_currency_rate_id` | No | **None** | Possible `currency_rate_id` for current valuation only; not validated as UUID/rate FK by the import path and insufficient for differently dated purchase/rent amounts. |
| 18 | `property_address` | No | **None** | Candidate `property_address TEXT`. |

### `account_investment_stocks` — 22 columns

Allowed account subtypes: `stocks_shares`. Closest legacy table: `account_market_investment_details`; mapping is unimplemented.

| # | Sheet column | Required by GAS | Current DB mapping | Candidate / unresolved conversion |
|---|---|---|---|---|
| 1 | `id` | Yes | **None** | Source position identity has no legacy column; generated version ID cannot by itself identify the same instrument through time. |
| 2 | `account_id` | Yes | **None** | Candidate `account_master_id`, but many instrument rows may share one account. |
| 3 | `instrument_symbol` | No | **None** | No legacy instrument-identity column. |
| 4 | `instrument_name` | No | **None** | No legacy instrument-name column. |
| 5 | `instrument_type` | Yes | **None** | No equivalent typed field; sheet `EQUITY`, `ETF`, `MUTUAL_FUND`, `OPTION`, `FUTURE`, `CASH` is not automatically DB `unit_type`. |
| 6 | `instrument_currency_local` | No | **None** | Possible `local_currency`; decide instrument versus account currency, validate currency master, and support conversion between them. |
| 7 | `holding_intent` | No | **None** | No legacy field; sheet `LONG_TERM`, `SHORT_TERM`, `TRADING`. |
| 8 | `position_side` | No | **None** | No legacy field; sheet `LONG`/`SHORT` conflicts with assuming unsigned units/value without an explicit position model. |
| 9 | `quantity` | No | **None** | Possible `units_held NUMERIC(19,6)`; instrument quantity, short positions and contract multipliers need defined precision/sign treatment. |
| 10 | `avg_cost_price_local` | No | **None** | No distinct average-cost-per-unit field; cannot share `unit_value_local_value` with current price. |
| 11 | `cost_basis_local` | No | **None** | Candidate local/base cost-basis columns; currency, ownership/position scope and historical FX date unresolved. |
| 12 | `current_price_local` | No | **None** | Possible unit-value local/base columns; instrument price scale/multiplier differs from total value. |
| 13 | `current_value_local` | No | **None** | Candidate current-value local/base columns; one row per instrument does not fit one current row per account. |
| 14 | `price_asof_date` | No | **None** | No dedicated price observation timestamp; cannot silently treat it as transaction or SCD effective time. |
| 15 | `evaluation_currency_rate_id` | No | **None** | Possible current-valuation `currency_rate_id`; no sheet FK validation and no separate historical cost-basis rate. |
| 16 | `underlying_symbol` | No | **None** | No legacy derivatives underlying field. |
| 17 | `option_type` | No | **None** | No legacy call/put field; sheet `CALL`, `PUT`. |
| 18 | `strike_price_local` | No | **None** | No legacy strike-price field. |
| 19 | `expiry_date` | No | **None** | No legacy instrument-expiry field. |
| 20 | `contract_multiplier` | No | **None** | No legacy contract-size field; required to interpret many derivative prices/values. |
| 21 | `opening_date` | No | **None** | No dedicated position opening date; not automatically account opening or SCD effective date. |
| 22 | `record_status` | No | **None** | No extension status column; sheet allows `active`, `inactive`, `deleted`, `locked`. An SCD close alone does not encode all four states. |

## Every legacy extension database column

The migration defines **seven tables and 123 columns in total**. The inventories below list every column, SQL type, nullability, and origin/gap. **No current extractor populates any of these columns**; “candidate” describes data that a future approved contract might use. `NOT NULL` is a schema requirement, not evidence the current sheets supply a value. Monetary BIGINTs are intended as minor units; none of the candidate conversions runs today.

All seven tables have a generated UUID primary key, an account FK, nullable `entity_type`/`entity_id` that must be either both absent or both present, and optional rate FK. The allowed non-null entity type is `transaction`, but `entity_id` is not itself a transaction FK. The account FK checks existence only; it does not enforce that the account subtype belongs in that extension table. Currency codes must be uppercase length three. Foreign-currency rows require a rate reference even for zero amounts; the zero-balance exception added to `account_master` does not apply here.

SCD constraints enforce unique `(account_master_id, effective_from_dt)`, at most one row with `effective_to_dt IS NULL` per account/table, and end > start when an end exists. They do not implement a snapshot writer, ensure one version for every sheet position, or prevent overlapping closed intervals. No extension has `applied_rate_value`; migration `0013` adds that snapshot only to account/transaction masters.

### `account_deposit_details` — 14 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `current_balance_local_value` | `BIGINT` | NOT NULL | Required nonnegative balance; not present in `account_deposit`. Master opening balance and virtual current value are different concepts. |
| `current_balance_base_value` | `BIGINT` | NOT NULL | Required base valuation of that balance; source balance/date/currency policy missing. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `interest_rate` | `NUMERIC(8,4)` | NULL | Candidate deposit `interest_rate`; percentage convention and scale policy unimplemented. |
| `rate_type` | `TEXT` | NULL | Candidate deposit `rate_type`; DB permits fixed/variable/tracker and requires co-presence with interest_rate. |
| `interest_payment_frequency` | `TEXT` | NULL | Candidate same-name sheet field; DB monthly/quarterly/semi_annual/annual differs from sheet annually/at_maturity. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_market_investment_details` — 17 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `current_value_local_value` | `BIGINT` | NOT NULL | Possible stock-position current value, but DB models one current row per account rather than per instrument. |
| `current_value_base_value` | `BIGINT` | NOT NULL | Derived valuation candidate; account-versus-instrument currency and observation date unresolved. |
| `cost_basis_local_value` | `BIGINT` | NULL | Candidate stock `cost_basis_local`; optional pair with base value; lot/position scope unresolved. |
| `cost_basis_base_value` | `BIGINT` | NULL | Historical FX conversion candidate; cannot assume current valuation rate is the acquisition rate. |
| `units_held` | `NUMERIC(19,6)` | NULL | Possible stock `quantity`; nonnegative DB quantity lacks short/contract representation. |
| `unit_value_local_value` | `BIGINT` | NULL | Possible stock `current_price_local`; no separate average-cost price column, multiplier or instrument key. |
| `unit_value_base_value` | `BIGINT` | NULL | Derived per-unit base price candidate; currency and pricing conventions unresolved. |
| `unit_type` | `TEXT` | NULL | No agreed source mapping. Free text, co-present with units and unit values; not defined as sheet instrument_type. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_fixed_income_details` — 20 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `face_value_local_value` | `BIGINT` | NOT NULL | Required positive face value; no current fixed-income detail tab provides it. |
| `face_value_base_value` | `BIGINT` | NOT NULL | Required positive derived face value; no source or valuation-date policy. |
| `purchase_price_local_value` | `BIGINT` | NOT NULL | Required positive purchase price; no current source tab. |
| `purchase_price_base_value` | `BIGINT` | NOT NULL | Required positive purchase-date valuation; no current source/rate. |
| `current_value_local_value` | `BIGINT` | NOT NULL | Required nonnegative current mark; no current source tab. |
| `current_value_base_value` | `BIGINT` | NOT NULL | Required nonnegative mark valuation; no current source/rate. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `interest_rate` | `NUMERIC(8,4)` | NOT NULL | Required nonnegative coupon/interest value; no current source tab or convention. |
| `rate_type` | `TEXT` | NOT NULL | Required fixed/variable/tracker; no current source tab. |
| `interest_payment_frequency` | `TEXT` | NULL | Optional monthly/quarterly/semi_annual/annual, required if interest_rate is nonzero; no source tab. |
| `start_date` | `DATE` | NOT NULL | Required instrument start date; not safely inferred from account opening/tracking date. |
| `maturity_date` | `DATE` | NOT NULL | Required maturity strictly after start_date; no current source tab. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_property_details` — 18 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `purchase_price_local_value` | `BIGINT` | NOT NULL | Required strictly positive purchase price absent from property sheet; incompatible with silently assuming a price for inherited/gifted property. |
| `purchase_price_base_value` | `BIGINT` | NOT NULL | Required historical purchase-price valuation; cannot derive from current-value rate alone. |
| `current_value_local_value` | `BIGINT` | NOT NULL | Candidate property current_value_local; gross versus attributable ownership value unresolved; DB requires >0. |
| `current_value_base_value` | `BIGINT` | NOT NULL | Derived current-value candidate; observation date/rate and ownership policy unresolved; DB requires >0. |
| `monthly_rental_income_local_value` | `BIGINT` | NULL | Possible rent_amount_local after monthly/yearly and ownership conversion; no implemented rule. |
| `monthly_rental_income_base_value` | `BIGINT` | NULL | Derived monthly rent candidate, paired with local value; appropriate valuation date not specified. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `purchase_date` | `DATE` | NULL | Possible acquisition_date_local only if acquisition semantics agree; inherited/gifted events are not purchases. |
| `property_address` | `TEXT` | NULL | Candidate same-name optional sheet text. |
| `is_rental` | `BOOLEAN` | NOT NULL | DB default FALSE on insert; candidate is_rented lacks source boolean validation. Non-rental rows cannot carry rental income. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_p2p_lending_details` — 15 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `principal_lent_local_value` | `BIGINT` | NOT NULL | Required positive principal; no current P2P detail tab. |
| `principal_lent_base_value` | `BIGINT` | NOT NULL | Required principal valuation; no source or origination-rate policy. |
| `current_value_local_value` | `BIGINT` | NOT NULL | Required nonnegative current value; no current P2P source. |
| `current_value_base_value` | `BIGINT` | NOT NULL | Required current-value valuation; source/rate policy absent. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `interest_rate` | `NUMERIC(8,4)` | NULL | Optional nonnegative rate, paired with rate_type; no current P2P source. |
| `rate_type` | `TEXT` | NULL | Optional fixed/variable/tracker, paired with interest_rate; no current P2P source. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_revolving_credit_details` — 19 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `credit_limit_local_value` | `BIGINT` | NOT NULL | Candidate card credit_limit_local; required positive minor-unit amount, not a current raw copy. |
| `credit_limit_base_value` | `BIGINT` | NOT NULL | Required converted limit; effective date and FX policy absent. |
| `current_balance_local_value` | `BIGINT` | NOT NULL | Required nonnegative debt magnitude; card detail has no balance; master liability opening amount is signed and not a current snapshot. |
| `current_balance_base_value` | `BIGINT` | NOT NULL | Required current debt valuation; source balance/date/rate policy absent. |
| `minimum_payment_local_value` | `BIGINT` | NULL | Optional nonnegative minimum payment; no card detail field. |
| `minimum_payment_base_value` | `BIGINT` | NULL | Optional converted minimum payment, co-present with local value; no source. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `annual_percentage_rate` | `NUMERIC(8,4)` | NULL | Potential card interest_rate correspondence only after confirming APR semantics; requires paired rate_type. |
| `rate_type` | `TEXT` | NULL | No card detail field. Fixed/variable/tracker required when APR exists; cannot invent fixed. |
| `payment_due_day` | `INTEGER` | NULL | Possible payment_month_day; DB integer 1–31 validation exceeds current sheet checks. |
| `statement_day` | `INTEGER` | NULL | Possible statement_month_day; DB integer 1–31 validation exceeds current sheet checks. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

### `account_installment_loan_details` — 20 columns

| DB column | SQL type | Nullability | Origin / unresolved source requirement — no current writer |
|---|---|---|---|
| `id` | `UUID` | NOT NULL | DB default `gen_random_uuid()` on a future insertion; no current write or source-detail identity mapping. |
| `account_master_id` | `UUID` | NOT NULL | FK to `account_master.id`; candidate from detail `account_id`, not currently resolved/written. |
| `entity_type` | `TEXT` | NULL | Optional version cause; CHECK allows only `transaction`. No current producer; not a sheet field. |
| `entity_id` | `UUID` | NULL | Optional cause ID paired with `entity_type`; no source column and no FK to the transaction table. |
| `original_principal_amount_local_value` | `BIGINT` | NOT NULL | Candidate mortgage/personal-loan original_principal_local; positive minor-unit amount required. |
| `original_principal_amount_base_value` | `BIGINT` | NOT NULL | Required origination-date principal valuation; no date/rate mapping implemented. |
| `outstanding_balance_local_value` | `BIGINT` | NOT NULL | Required nonnegative debt magnitude; neither loan detail tab supplies current outstanding balance. |
| `outstanding_balance_base_value` | `BIGINT` | NOT NULL | Required outstanding-balance valuation; absent balance/effective date/rate source. |
| `monthly_payment_local_value` | `BIGINT` | NOT NULL | Candidate monthly_payment_local; optional source versus required strictly positive DB amount. |
| `monthly_payment_base_value` | `BIGINT` | NOT NULL | Required payment valuation; source/date/rate completeness unresolved. |
| `local_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Usually would require master currency, but instrument currency may differ; decision required. |
| `base_currency` | `CHAR(3)` | NOT NULL | No default or current producer. Legacy design intended XAU; DDL only checks uppercase three-character format. |
| `currency_rate_id` | `UUID` | NULL | FK to `currency_rates.id`; no implemented date/rate selection. A single ID may not represent every economic date in the row. |
| `interest_rate` | `NUMERIC(8,4)` | NOT NULL | Candidate source interest_rate, but DB NOT NULL and source optional; percentage convention undefined. |
| `rate_type` | `TEXT` | NOT NULL | DB NOT NULL fixed/variable/tracker; mortgage source optional fixed/variable, personal-loan source has no column. |
| `term_months` | `INTEGER` | NOT NULL | Candidate same-name source field; DB positive INTEGER, source validation only finite numeric. |
| `start_date` | `DATE` | NOT NULL | Required loan start; neither detail tab includes it. Account opening/tracking cannot automatically substitute. |
| `end_date` | `DATE` | NOT NULL | Possible maturity_date_local; DB required DATE strictly after start, source optional and not date-validated. |
| `effective_from_dt` | `TIMESTAMPTZ` | NOT NULL | Required UTC-aware version start; no general source effective timestamp or implemented SCD creation policy. |
| `effective_to_dt` | `TIMESTAMPTZ` | NULL | Optional UTC-aware version close; NULL denotes current. No implemented closing/replay/deletion policy. |

## Decisions required before implementing detail extraction

1. **Identity and cardinality:** preserve each source detail/position ID separately from any generated version ID. Decide whether deposit/loan/property tabs allow multiple rows per account. Stocks already needs many positions per account, which conflicts with the legacy unique-current-row index and absence of instrument keys.
2. **Source completeness:** choose actual sources for current balances, loan start dates, required payments/rates, purchase prices, fixed-income terms and P2P principal. No fixed-income or P2P detail tab exists. Do not treat a master opening amount or account opening date as an unrelated missing economic value/date.
3. **Schema coverage:** retain property acquisition/ownership/rent schedules/service charges and mortgage linkage, and instrument identity/currency/position side/derivative terms. The legacy tables cannot preserve these source fields as written. Decide whether to replace, extend, or retire those tables.
4. **Units and valuation:** define percentages, currencies, minor-unit precision, positive liability magnitudes, quantity precision, multipliers and short positions. Establish per-amount FX dates: original cost/principal, current market value and rent/payment are not necessarily contemporaneous. One mutable rate FK for all monetary fields cannot fully document these conversions; extensions also lack captured applied rates.
5. **Enums and validation:** reconcile annually/annual and at_maturity, loan/card rate types, boolean parsing, date formats, integer day/month/term constraints, ownership percentages, and source-optional/DB-required differences. GAS finite-number checks alone are insufficient.
6. **Change and history protocol:** add an explicit supported snapshot/audit/sync contract or a separate detail-ingestion protocol. Decide what replacement, missing rows, source deletion, locked/inactive states, and historical correction mean for SCD versions. Never infer deletion solely from absence in a source read.
7. **Transaction effects versus market values:** classify postings before updating debt/principal or investment/property values. Cash movements cannot generally be added directly to market valuations. Current ledger-extract intentionally performs no extension side effects, so repeated extraction cannot append duplicate detail history.

These are source/data-model gaps, not failed extraction of an otherwise supported tab. Until the contract and migrations are implemented, a successful ledger-extract run certifies only its four configured master entities; it does not certify account detail synchronization or current account valuations.
