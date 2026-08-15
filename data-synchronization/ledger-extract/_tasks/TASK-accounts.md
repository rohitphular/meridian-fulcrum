# TASK — accounts

**Status:** COMPLETE
**Build order:** 2 of 4 — no dependencies on other entities

---

## Open questions

None — all design decisions confirmed pending review of this document.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | Sheet tab name | `'accounts'` |
| Q2 | Modeling approach | Base `accounts` table (common columns) + per-structure-type extension tables (SCD Type 2 — multiple rows per account over time) |
| Q3 | `structure_type` source of truth | `account_types.structure_type` column — DB-driven routing; extract job preloads the full `(type, sub_type) → structure_type` map at startup |
| Q4 | Extension table PK | Surrogate `id UUID` — `(account_id, effective_from_dt)` UNIQUE. Not 1-to-1: multiple rows per account as state changes over time |
| Q5 | SCD pattern | `effective_from_dt TIMESTAMPTZ NOT NULL`, `effective_to_dt TIMESTAMPTZ NULL` — NULL means current record. Only one row per account may have `effective_to_dt IS NULL` at any time (enforced by partial unique index). No `_utc` suffix — all datetimes in the backend are stored and processed as UTC unless a column explicitly states otherwise. |
| Q6 | Entity linkage in extension tables | Polymorphic `entity_type TEXT` + `entity_id UUID` (both nullable, consistency enforced by CHECK). Phase 1: always `'transaction'`. Replaces single `transaction_id` FK. |
| Q7 | Transaction locking interaction | Transactions older than 3 months are locked (status = `locked`). No new history row may be inserted with `effective_from_dt` falling within a locked period |
| Q8 | Natural key | `{account_id}` — the sheet `id` column (single field) |
| Q9 | Sheet `id` naming in DB | `account_id TEXT NOT NULL UNIQUE` — avoids collision with surrogate `id UUID` PK |
| Q10 | `institution_name` placement | On base `account_master` table — universal across all account types |
| Q11 | `account_master` FK to `account_types` | Yes — `FOREIGN KEY (account_type, sub_type) REFERENCES account_types(account_type, sub_type)` |
| Q12 | Base table name | `account_master` — consistent with `category_master` naming pattern |
| Q13 | 2-word minimum column names | Enforced on all non-PK columns. PK stays `id`. `type` → `account_type`, `name` → `account_name`, `currency` → `currency_code`, `description` → `account_description`, `address` → `property_address`, `apr` → `annual_percentage_rate`. Loan principal field naming resolved in Q21 and Q23. |
| Q14 | Account lifecycle status | `account_status TEXT NOT NULL DEFAULT 'active'` on `account_master`. Values: `active`, `in_active`, `closed`, `deleted`. CHECK-enforced. `account_status = 'deleted'` is the sole soft-deletion signal; `deleted_at` records when it occurred. |
| Q15 | Interest rate metadata | `rate_type TEXT` added to all 5 tables that carry an interest rate. Values: `fixed`, `variable`, `tracker`. Nullable on `account_deposit_details`, `account_p2p_lending_details`, `account_revolving_credit_details` (rate may be unknown). NOT NULL on `account_fixed_income_details` and `account_installment_loan_details` — `interest_rate` is required on both; the rate classification is always known at issuance (see Q33). `interest_payment_frequency TEXT` added to `account_deposit_details` and `account_fixed_income_details`. Values: `monthly`, `quarterly`, `semi_annual`, `annual`. |
| Q16 | Account opening date | `account_opening_date DATE` on `account_master`. Optional (NULL if unknown). Date the account was opened at the institution — does not change over time. |
| Q17 | Sign convention for monetary amounts | All monetary amounts stored as positive magnitudes. Liability nature is implied by `account_type` (`liability`). Net-worth calculation at the reporting layer subtracts liability balances from asset/investment values. Industry standard: ISO 20022, personal finance platforms (YNAB, Monarch, Tiller). Avoids ambiguity where a negative balance could mean either owed or in credit. |
| Q18 | `is_deleted` removal | Dropped from `account_master`. `account_status = 'deleted'` is the single source of truth for soft-deletion. `deleted_at` is retained to record when the deletion occurred. Soft-delete pass now sets `account_status = 'deleted'`; re-activation on conflict resets `account_status = 'active'` and `deleted_at = NULL`. |
| Q19 | Cost basis on market investments | `cost_basis NUMERIC(19,6)` added (nullable) to `account_market_investment_details`. Required to compute unrealised P&L (`current_value − cost_basis`). Nullable because historical accounts may not have cost basis data. |
| Q20 | CHECK constraints on enumerated text fields | `rate_type IN ('fixed', 'variable', 'tracker')` CHECK added to all 5 tables that carry it. `interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')` CHECK added to `account_deposit_details` and `account_fixed_income_details`. NULL remains valid for all — CHECK only fails on FALSE, not NULL. |
| Q21 | `principal_amount` rename in installment loans | Renamed to `original_principal_amount` — fixed at drawdown, never changes. `outstanding_balance` is the moving figure. Removes the ambiguity where "current principal" and "remaining balance" appeared to describe the same thing. |
| Q22 | Units consistency constraint | `CHECK ((units_held IS NULL AND unit_value IS NULL AND unit_type IS NULL) OR (units_held IS NOT NULL AND unit_value IS NOT NULL AND unit_type IS NOT NULL))` added to `account_market_investment_details`. All three unit fields must be either all NULL (fund-based) or all NOT NULL (unit-based). |
| Q23 | `principal_amount` split in fixed income | Replaced with `face_value` (par/redemption value) and `purchase_price` (what was actually paid). For fixed deposits these are equal; for bonds bought at discount or premium they differ. Both NOT NULL. |
| Q24 | Overdraft modelling | Overdraft is modelled exclusively as `liability / overdraft → revolving_credit`. `account_deposit_details` carries no overdraft field. The overdraft balance is tracked as an explicit liability account — not as a field on the asset (current) account. |
| Q25 | Payment day range constraints | `CHECK (payment_due_day BETWEEN 1 AND 31)` and `CHECK (statement_day BETWEEN 1 AND 31)` added to `account_revolving_credit_details`. Both columns remain nullable — the CHECK fires only on non-NULL values, which PostgreSQL evaluates as NULL (not FALSE) for NULL inputs. |
| Q26 | Rental income consistency | `CHECK (is_rental = TRUE OR monthly_rental_income IS NULL)` added to `account_property_details`. Prevents a rental income figure sitting on an account that is not marked as a rental property. |
| Q27 | `deleted_at` consistency | `CHECK (account_status = 'deleted' OR deleted_at IS NULL)` added to `account_master`. Prevents `deleted_at` being set on a live account. The inverse (enforcing `deleted_at IS NOT NULL` when status is `deleted`) is intentionally omitted — the soft-delete pass always sets it, and a DB-level NOT NULL constraint would complicate bulk testing. |
| Q28 | Drop `is_active` | Removed from `account_master`, `transforms/accounts.py`, and all SQL. `account_status` owns the full lifecycle state — a separate boolean provided no independent signal once `account_status` was introduced. Hash column order updated to: `id, name, institution_name, type, sub_type, currency, description`. |
| Q29 | Date ordering constraints | `CHECK (maturity_date > start_date)` added to `account_fixed_income_details`. `CHECK (end_date > start_date)` added to `account_installment_loan_details`. A deposit/issue date after maturity, or a loan start after its projected end, is nonsensical and rejected at the DB level. |
| Q30 | `account_status` populate path | The extract job writes only `active` (on insert/re-activation) and `deleted` (on soft-delete). The values `in_active` and `closed` have no sheet source — they must be set by a manual DB operation or a future management tool outside the extract pipeline. The extract job will never overwrite a manually-set `in_active` or `closed` back to `active` unless the account disappears from the sheet and then reappears (triggering a full soft-delete / re-insert cycle). |
| Q31 | Monetary field precision — closed decision | All monetary amounts use `NUMERIC(19,6)`. `NUMERIC` is exact decimal — there are no floating-point rounding errors to fix. Lowest-denomination integer storage (pence/cents) is not used: it provides no accuracy benefit over `NUMERIC`, and a multi-currency schema has no single universal subunit (GBP: 2 dp, KWD: 3 dp, JPY: 0 dp, BTC: 8 dp). This decision is closed and will not be revisited. |
| Q32 | Value range constraints | Strictly positive (`> 0`) CHECKs added to fields that cannot logically be zero: `face_value`, `purchase_price` (fixed income); `purchase_price`, `current_value` (property); `principal_lent` (p2p); `credit_limit` (revolving credit); `original_principal_amount`, `monthly_payment`, `term_months` (installment loan). Non-negative (`>= 0`) CHECKs added to fields that can reach zero: `interest_rate` (deposit, p2p); `current_value`, `cost_basis` (market investment); `current_value` (p2p); `current_balance`, `annual_percentage_rate` (revolving credit); `outstanding_balance` (installment loan). |
| Q35 | Entity type constraint, coupon frequency, account_type guard | `CHECK (entity_type IN ('transaction'))` added to all 7 extension tables — NULL remains valid (PostgreSQL CHECK only fails on FALSE; NULL IN ('transaction') evaluates to NULL). Each new entity type introduced in a future phase is added to the CHECK via migration, making the valid set explicit and preventing silent typos. `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)` added to `account_fixed_income_details` — zero-coupon bonds carry `interest_rate = 0` with no periodic schedule; any non-zero coupon rate implies a defined payment frequency. `CHECK (account_type IN ('asset', 'investment', 'liability'))` added to `account_types` (migration 0002) — without this, a rogue `account_types` row with an arbitrary `account_type` would propagate through the FK into `account_master`. Soft-delete SCD close documented in extract behaviour: when extension table writes are implemented, the soft-delete pass must close the current SCD row atomically in the same transaction. |
| Q34 | SCD temporal ordering and rate consistency constraints | `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)` added to all 7 extension tables — a SCD row that ends before it starts is logically impossible and must be rejected at the DB level. Rate/rate_type consistency added to the three tables where both fields are nullable: deposit (`interest_rate` ↔ `rate_type`), revolving credit (`annual_percentage_rate` ↔ `rate_type`), p2p (`interest_rate` ↔ `rate_type`) — pattern: both NULL or both NOT NULL. `CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL)` added to deposit — a payment schedule without a rate is meaningless. `CHECK (units_held > 0)` and `CHECK (unit_value >= 0)` added to market investment — the units consistency CHECK already enforces all-or-nothing presence; these bound the values when set (negative holdings imply a short position, which this schema does not model). |
| Q33 | Additional value range and quality constraints | `CHECK (current_balance >= 0)` added to deposit (sign convention — overdraft is a separate liability account). `CHECK (interest_rate >= 0)` added to fixed income and installment loan (NOT NULL rate fields previously had no range guard). `CHECK (current_value >= 0)` added to fixed income (all other current_value fields had this; fixed income was the exception). `CHECK (monthly_rental_income > 0)` added to property (rental consistency CHECK already prevented it on non-rental accounts; this prevents 0 or negative values when it is set). `CHECK (minimum_payment >= 0)` added to revolving credit (nullable but a negative minimum payment is nonsensical). `CHECK (currency_code = upper(currency_code))` added to `account_master` (length was validated; case was not — `'gbp'` and `'GBP'` would have been treated as different currencies). `rate_type` made `NOT NULL` on `account_fixed_income_details` and `account_installment_loan_details` — for instruments where `interest_rate` is NOT NULL, the rate classification is always known (a fixed-rate mortgage is always `'fixed'`; a tracker mortgage is always `'tracker'`). |

---

## `account_types` update — add `structure_type`, rename `type` → `account_type`

Migration `0002_create_account_types.py` updated: `structure_type TEXT NOT NULL` added; `type` column renamed to `account_type`.

> **Dev note:** migration 0002 is not yet released — update it directly; dev DB needs a clean reset.

Updated `account_types` columns:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK |
| `account_type` | `TEXT NOT NULL` | `asset`, `investment`, `liability` |
| `sub_type` | `TEXT NOT NULL` | |
| `structure_type` | `TEXT NOT NULL` | Determines which extension table this account writes to |
| `is_deleted` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |
| `deleted_at` | `TIMESTAMPTZ` | |

`UNIQUE (account_type, sub_type)`

`CHECK (account_type IN ('asset', 'investment', 'liability'))`

`CHECK (structure_type IN ('deposit', 'market_investment', 'fixed_income', 'property', 'p2p_lending', 'revolving_credit', 'installment_loan'))`

Full seed data with `structure_type`:

| `account_type` | `sub_type` | `structure_type` |
|----------------|-----------|-----------------|
| `asset` | `current` | `deposit` |
| `asset` | `savings` | `deposit` |
| `asset` | `cash` | `deposit` |
| `investment` | `stocks_shares` | `market_investment` |
| `investment` | `isa` | `market_investment` |
| `investment` | `pension_sipp` | `market_investment` |
| `investment` | `crypto` | `market_investment` |
| `investment` | `commodities` | `market_investment` |
| `investment` | `other` | `market_investment` |
| `investment` | `fixed_deposit` | `fixed_income` |
| `investment` | `bonds` | `fixed_income` |
| `investment` | `property` | `property` |
| `investment` | `p2p_lending` | `p2p_lending` |
| `liability` | `credit_card` | `revolving_credit` |
| `liability` | `heloc` | `revolving_credit` |
| `liability` | `overdraft` | `revolving_credit` |
| `liability` | `personal_loan` | `installment_loan` |
| `liability` | `auto_loan` | `installment_loan` |
| `liability` | `mortgage` | `installment_loan` |
| `liability` | `student_loan` | `installment_loan` |
| `liability` | `medical_loan` | `installment_loan` |
| `liability` | `debt_consolidation` | `installment_loan` |

---

## Tables to create — Migration `0004_create_accounts.py`

All 8 tables created in a single migration in dependency order: `account_master` first, then all 7 extension tables (all FK to `account_master.id`).

---

### Base table — `account_master`

Common columns shared by every account regardless of structure_type. Contains no time-varying financial data — that lives in the extension tables.

| Column | Sheet column | DB type | Notes |
|--------|-------------|---------|-------|
| `id` | — | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_id` | `id` | `TEXT NOT NULL` | Natural key — UNIQUE |
| `account_name` | `name` | `TEXT NOT NULL` | |
| `institution_name` | `institution_name` | `TEXT` | Bank, broker, lender — NULL if not applicable |
| `account_type` | `type` | `TEXT NOT NULL` | FK to account_types |
| `sub_type` | `sub_type` | `TEXT NOT NULL` | FK to account_types |
| `currency_code` | `currency` | `TEXT NOT NULL` | 3-char code — CHECK |
| `account_status` | — | `TEXT NOT NULL DEFAULT 'active'` | `active`, `in_active`, `closed`, `deleted` — real-world lifecycle state |
| `account_opening_date` | — | `DATE` | Date account was opened at the institution — NULL if unknown |
| `account_description` | `description` | `TEXT` | NULL if empty |
| `row_hash` | — | `TEXT NOT NULL` | SHA-256 of source row |
| `created_at` | — | `TIMESTAMPTZ NOT NULL` | |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL` | |
| `deleted_at` | — | `TIMESTAMPTZ` | |

Constraints:
- `PRIMARY KEY (id)`
- `UNIQUE (account_id)`
- `FOREIGN KEY (account_type, sub_type) REFERENCES account_types(account_type, sub_type)`
- `CHECK (char_length(currency_code) = 3 AND currency_code = upper(currency_code))`
- `CHECK (account_status IN ('active', 'in_active', 'closed', 'deleted'))`
- `CHECK (account_status = 'deleted' OR deleted_at IS NULL)`

---

## Sign convention

All monetary amounts are stored as **positive magnitudes**. The liability nature of an account is implied by its `account_type` (`liability`) — no negative signs are used in the DB.

Net-worth calculation at the reporting layer:

```
net_worth = sum(asset values) + sum(investment values) − sum(liability balances)
```

This is the industry standard (ISO 20022, YNAB, Monarch Money, Tiller) and avoids the ambiguity where a negative balance could mean either "amount owed" or "account in credit".

---

## SCD Type 2 pattern

All extension tables implement SCD Type 2: multiple rows per account over time. `effective_to_dt IS NULL` = current record. A partial unique index enforces exactly one current record per account at all times.

`entity_type` / `entity_id` are a polymorphic reference to whichever entity triggered the state change. Phase 1: always `'transaction'`. NULL pair = non-entity-driven change (e.g. manual rate update, valuation adjustment).

---

### Extension table — `account_deposit_details`

For `structure_type = 'deposit'` — sub_types: `current`, `savings`, `cash`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `current_balance` | `NUMERIC(19,6) NOT NULL` | Balance as of this record |
| `interest_rate` | `NUMERIC(8,4)` | Annual rate — NULL for current/cash accounts |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` — NULL if not applicable |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` — NULL for current/cash accounts |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((interest_rate IS NULL AND rate_type IS NULL) OR (interest_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual'))`
- `CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL)`
- `CHECK (interest_rate >= 0)`
- `CHECK (current_balance >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_market_investment_details`

For `structure_type = 'market_investment'` — sub_types: `stocks_shares`, `isa`, `pension_sipp`, `crypto`, `commodities`, `other`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Market value as of this record |
| `cost_basis` | `NUMERIC(19,6)` | Total acquisition cost — NULL if unknown for historical accounts. Used to compute unrealised P&L (`current_value − cost_basis`) |
| `units_held` | `NUMERIC(19,6)` | Quantity of units held — NULL for fund-based accounts |
| `unit_value` | `NUMERIC(19,6)` | Price per unit as of this record — NULL for fund-based accounts |
| `unit_type` | `TEXT` | Unit denomination e.g. `shares`, `BTC`, `oz` — NULL for fund-based accounts |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK ((units_held IS NULL AND unit_value IS NULL AND unit_type IS NULL) OR (units_held IS NOT NULL AND unit_value IS NOT NULL AND unit_type IS NOT NULL))`
- `CHECK (units_held > 0)`
- `CHECK (unit_value >= 0)`
- `CHECK (current_value >= 0)`
- `CHECK (cost_basis >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_fixed_income_details`

For `structure_type = 'fixed_income'` — sub_types: `fixed_deposit`, `bonds`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `face_value` | `NUMERIC(19,6) NOT NULL` | Par / redemption value — amount returned at maturity. For fixed deposits equals `purchase_price`; for bonds may differ (discount/premium) |
| `purchase_price` | `NUMERIC(19,6) NOT NULL` | Amount actually paid to acquire the instrument |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual coupon or deposit rate |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` |
| `start_date` | `DATE NOT NULL` | Deposit/issue date |
| `maturity_date` | `DATE NOT NULL` | When principal is returned |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Current value including accrued interest |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual'))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (maturity_date > start_date)`
- `CHECK (face_value > 0)`
- `CHECK (purchase_price > 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (current_value >= 0)`
- `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_property_details`

For `structure_type = 'property'` — sub_type: `property`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `purchase_price` | `NUMERIC(19,6) NOT NULL` | Original purchase price |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Current estimated market value |
| `purchase_date` | `DATE` | |
| `property_address` | `TEXT` | |
| `is_rental` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `monthly_rental_income` | `NUMERIC(19,6)` | NULL if not a rental property |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (is_rental = TRUE OR monthly_rental_income IS NULL)`
- `CHECK (monthly_rental_income > 0)`
- `CHECK (purchase_price > 0)`
- `CHECK (current_value > 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_p2p_lending_details`

For `structure_type = 'p2p_lending'` — sub_type: `p2p_lending`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `principal_lent` | `NUMERIC(19,6) NOT NULL` | Total amount deployed on platform |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Outstanding principal + accrued interest |
| `interest_rate` | `NUMERIC(8,4)` | Expected or realised annual rate |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((interest_rate IS NULL AND rate_type IS NULL) OR (interest_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (principal_lent > 0)`
- `CHECK (current_value >= 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_revolving_credit_details`

For `structure_type = 'revolving_credit'` — sub_types: `credit_card`, `heloc`, `overdraft`.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `credit_limit` | `NUMERIC(19,6) NOT NULL` | Total credit limit — can change (bank increase/decrease) |
| `current_balance` | `NUMERIC(19,6) NOT NULL` | Amount currently owed (positive = debt) |
| `annual_percentage_rate` | `NUMERIC(8,4)` | Annual percentage rate — can change |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` |
| `minimum_payment` | `NUMERIC(19,6)` | Minimum monthly payment due |
| `payment_due_day` | `INTEGER` | Day of month payment is due (1–31) |
| `statement_day` | `INTEGER` | Statement cut-off day of month (1–31) |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (payment_due_day BETWEEN 1 AND 31)`
- `CHECK (statement_day BETWEEN 1 AND 31)`
- `CHECK (credit_limit > 0)`
- `CHECK (current_balance >= 0)`
- `CHECK (annual_percentage_rate >= 0)`
- `CHECK (minimum_payment >= 0)`
- `CHECK ((annual_percentage_rate IS NULL AND rate_type IS NULL) OR (annual_percentage_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_installment_loan_details`

For `structure_type = 'installment_loan'` — sub_types: `personal_loan`, `auto_loan`, `mortgage`, `student_loan`, `medical_loan`, `debt_consolidation`.

All columns are time-varying — extra payments can reduce principal or tenure; refinancing changes rate, term, and monthly payment.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` in phase 1; NULL if not entity-driven |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `original_principal_amount` | `NUMERIC(19,6) NOT NULL` | Principal at drawdown — fixed for the life of the loan; does not change with payments |
| `outstanding_balance` | `NUMERIC(19,6) NOT NULL` | Remaining balance as of this record — decreases with each payment |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual rate — changes on refinancing or variable rate adjustment |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `term_months` | `INTEGER NOT NULL` | Remaining term — reduces with tenure-reducing extra payments |
| `monthly_payment` | `NUMERIC(19,6) NOT NULL` | Current scheduled monthly payment |
| `start_date` | `DATE NOT NULL` | Original loan drawdown date — does not change |
| `end_date` | `DATE NOT NULL` | Projected final payment date — changes with tenure adjustments |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (end_date > start_date)`
- `CHECK (original_principal_amount > 0)`
- `CHECK (outstanding_balance >= 0)`
- `CHECK (monthly_payment > 0)`
- `CHECK (term_months > 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

## Referenced by

- `transactions` — will FK to `account_master` (design pending in TASK-transactions.md); accounts must be extracted before transactions
- `subscriptions` — will FK to `account_master` (design pending in TASK-subscriptions.md); accounts must be extracted before subscriptions

---

## Extract behaviour

**Sheet tab:** `'accounts'`

**Zero-row guard:** If the sheet tab returns 0 rows, abort — do not soft-delete.

**Startup:** Preload `(account_type, sub_type) → structure_type` map from `account_types` into memory before the per-row loop.

**Per-row pass:**
1. Transform and validate common columns
2. Look up `structure_type` from preloaded map — hard error if combo not found
3. Write base row to `account_master`
4. Insert opening extension row with `effective_from_dt = created_at` (the job's insert timestamp), `effective_to_dt = NULL`, `entity_type = NULL`, `entity_id = NULL`

**Soft-delete pass:** Same pattern as categories, with one additional step: when extension table writes are implemented, the soft-delete must also close the current SCD row atomically in the same transaction. Extend the `RETURNING` clause to include `id, account_type, sub_type`, resolve `structure_type` via the preloaded map, then `UPDATE <extension_table> SET effective_to_dt = now() WHERE account_master_id = <id> AND effective_to_dt IS NULL`. This ensures `WHERE effective_to_dt IS NULL` queries on extension tables never return deleted accounts.

**`account_status` lifecycle:** The extract job sets `account_status = 'active'` on insert/re-activation and `account_status = 'deleted'` on soft-delete. The values `in_active` and `closed` are not populated by the extract job — they require a manual DB update or a future management operation outside this pipeline (see Q30).

---

## What to build

- [x] Update `migrations/0002_create_account_types.py` — add `structure_type` column + update seed data
- [x] `migrations/0004_create_accounts.py` — `account_master` base table + 7 extension tables
- [x] `transforms/accounts.py` — row dict → typed dict + SHA-256 hash
- [x] `database/accounts.py` — accounts upsert (base + extension routing)
- [x] Wire `_extract_accounts` into `core/extractor.py`
