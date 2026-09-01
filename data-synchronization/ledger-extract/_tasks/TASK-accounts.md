# TASK — accounts

**Status:** READY TO BUILD
**Build order:** 2 of 4 — no dependencies on other entities

---

## Open questions

None — all design decisions confirmed.

---

## Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | Sheet tab name | `'accounts'` |
| Q2 | Modelling approach | Base `account_master` table (common columns) + per-subtype-group extension tables (SCD Type 2 — multiple rows per account over time) |
| Q3 | Extension table routing | Phase 1 writes `account_master` only — no routing needed. When Phase 2 extension table writes are implemented, `(account_subtype) → structure_type` will be a hardcoded constant dict in `database/accounts.py`. No DB column required. |
| Q4 | Extension table PK | Surrogate `id UUID` — `(account_master_id, effective_from_dt)` UNIQUE. Multiple rows per account as state changes over time. |
| Q5 | SCD pattern | `effective_from_dt TIMESTAMPTZ NOT NULL`, `effective_to_dt TIMESTAMPTZ NULL` — NULL means current record. Only one row per account may have `effective_to_dt IS NULL` at any time, enforced by a partial unique index. All datetimes stored and processed as UTC. |
| Q6 | Entity linkage in extension tables | Polymorphic `entity_type TEXT` + `entity_id UUID` (both nullable, consistency enforced by CHECK). Phase 1: always NULL (no entity-driven trigger at account-creation time). Replaces any single FK approach. |
| Q7 | Natural key | `{account_id}` — the sheet `id` column (`ACC-YYYYMMDD-NNN`) |
| Q8 | Sheet `id` naming in DB | `account_id TEXT NOT NULL UNIQUE` — avoids collision with surrogate `id UUID` PK |
| Q9 | Base table name | `account_master` — consistent with `category_master` naming pattern |
| Q10 | 2-word minimum column names | Enforced on all non-PK columns. PK stays `id`. Sheet `name` → `account_name`; sheet `type` → `account_type`; sheet `sub_type` → `account_subtype`; sheet `currency` → `currency_code`; sheet `description` → `account_description`. All other mappings follow the same pattern. |
| Q11 | `account_master` FK to `account_types` | `FOREIGN KEY (account_type, account_subtype) REFERENCES account_types(account_type, account_subtype)` |
| Q12 | Deletion model | `record_status TEXT NOT NULL` is the sole status field — mirrored verbatim from the sheet on every insert/update. When a user deletes an account via the app, GAS sets `record_status = 'deleted'` and `sync_status = 'update-pending'`; the extractor picks it up via the normal update path. No `is_deleted` flag, no `deleted_at` timestamp, no soft-delete pass. Same pattern as `category_master`. |
| Q13 | `opening_value` sign convention in `account_master` | Stored as raw sheet value — negative for liabilities (the GAS backend negates user input on write). Preserved verbatim to mirror the sheet accurately. Extension tables use `abs(opening_value)` as the seed balance (positive magnitudes — see Q14). |
| Q14 | Sign convention for monetary amounts in extension tables | All monetary amounts stored as positive magnitudes. Liability nature implied by `account_type`. Net-worth at the reporting layer: `sum(asset values) + sum(investment values) − sum(liability balances)`. |
| Q15 | Phase 1 extension table scope | Phase 1 writes `account_master` only. Extension table seeding (deposit, market investment, etc.) requires data beyond what the sheet provides (interest rates, credit limits, etc.) and is deferred to Phase 2. The migration creates all 8 tables; the Phase 1 extract job only writes `account_master`. |
| Q16 | Interest rate metadata | `rate_type TEXT` added to all 5 tables that carry an interest rate. Values: `fixed`, `variable`, `tracker`. Nullable on `account_deposit_details`, `account_p2p_lending_details`, `account_revolving_credit_details`. NOT NULL on `account_fixed_income_details` and `account_installment_loan_details`. `interest_payment_frequency TEXT` added to `account_deposit_details` and `account_fixed_income_details`. Values: `monthly`, `quarterly`, `semi_annual`, `annual`. |
| Q17 | Cost basis | `cost_basis NUMERIC(19,6)` added (nullable) to `account_market_investment_details`. Required to compute unrealised P&L. Nullable because historical accounts may not have this data. |
| Q18 | CHECK constraints on enumerated text fields | `rate_type IN ('fixed', 'variable', 'tracker')` on all 5 tables that carry it. `interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')` on `account_deposit_details` and `account_fixed_income_details`. NULL is valid for all — CHECK only fails on FALSE, not NULL. |
| Q19 | `principal_amount` naming in installment loans | `original_principal_amount` — fixed at drawdown, never changes. `outstanding_balance` is the moving figure. |
| Q20 | Units consistency | `CHECK ((units_held IS NULL AND unit_value IS NULL AND unit_type IS NULL) OR (units_held IS NOT NULL AND unit_value IS NOT NULL AND unit_type IS NOT NULL))` on `account_market_investment_details`. All three unit fields must be all NULL or all NOT NULL. |
| Q21 | `principal_amount` split in fixed income | Replaced with `face_value` (par/redemption value) and `purchase_price` (amount paid). Both NOT NULL. |
| Q22 | Overdraft modelling | Overdraft is modelled exclusively as `liability / overdraft → revolving_credit`. No overdraft field on deposit tables. |
| Q23 | Payment day range constraints | `CHECK (payment_due_day BETWEEN 1 AND 31)` and `CHECK (statement_day BETWEEN 1 AND 31)` on `account_revolving_credit_details`. Both nullable; CHECK only fires on non-NULL values. |
| Q24 | Rental income consistency | `CHECK (is_rental = TRUE OR monthly_rental_income IS NULL)` on `account_property_details`. |
| Q26 | Monetary field precision | All monetary amounts use `NUMERIC(19,6)`. Exact decimal — no floating-point rounding. Multi-currency schema has no universal subunit. |
| Q27 | Value range constraints | Strictly positive (`> 0`) on fields that cannot be zero: `face_value`, `purchase_price` (fixed income); `purchase_price`, `current_value` (property); `principal_lent` (p2p); `credit_limit` (revolving credit); `original_principal_amount`, `monthly_payment`, `term_months` (installment loan). Non-negative (`>= 0`) on fields that can reach zero: `interest_rate` (deposit, p2p, fixed income, installment); `units_held`, `current_value`, `cost_basis` (market investment); `current_value` (p2p); `current_balance`, `annual_percentage_rate`, `minimum_payment` (revolving credit); `outstanding_balance` (installment). `units_held >= 0` allows recording a fully liquidated position (0 units held) before closing the SCD row. |
| Q29 | Date ordering constraints | `CHECK (maturity_date > start_date)` on `account_fixed_income_details`. `CHECK (end_date > start_date)` on `account_installment_loan_details`. |
| Q30 | SCD temporal ordering | `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)` on all 7 extension tables. |
| Q31 | `CHECK (account_type IN (...))` on `account_types` | Without this, a rogue row with an arbitrary `account_type` would propagate through the FK into `account_master`. |
| Q32 | Rate/rate_type co-presence | Deposit, revolving credit, p2p: both NULL or both NOT NULL. Fixed income, installment loan: rate_type NOT NULL (always known at issuance). `CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL)` on deposit — a payment schedule without a rate is meaningless. `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)` on fixed income — zero-coupon bonds carry `interest_rate = 0`; any non-zero rate implies a defined payment frequency. |
| Q33 | Entity type constraint | `CHECK (entity_type IN ('transaction'))` on all 7 extension tables — NULL remains valid. Each new entity type introduced in a future phase is added via migration. |
| Q34 | `currency_code` format guard | `CHECK (char_length(currency_code) = 3 AND currency_code = upper(currency_code))` on `account_master` — enforces 3-char ISO code and prevents `'gbp'` and `'GBP'` being treated as different currencies. |

---

## Sheet schema (14 columns)

| # | Column | Notes |
|---|--------|-------|
| 1 | `id` | Natural key — `ACC-YYYYMMDD-NNN` |
| 2 | `name` | |
| 3 | `type` | `asset`, `investment`, `liability` |
| 4 | `sub_type` | |
| 5 | `currency` | Stored uppercase |
| 6 | `opening_value` | Balance at import. Negative in sheet for liabilities (backend negates user input). Immutable after create. |
| 7 | `current_value` | Virtual — always blank in sheet; injected at read time. Not stored in DB. |
| 8 | `description` | Optional |
| 9 | `record_status` | `active`, `inactive`, `deleted`, `locked` |
| 10 | `sync_status` | Written back by extract job |
| 11 | `sync_date_time` | Written back by extract job |
| 12 | `sync_notes` | Written back by extract job |
| 13 | `created_at` | Backend-stamped audit column — not stored in DB |
| 14 | `updated_at` | Backend-stamped audit column — not stored in DB |

---

## `account_types` — reference table (already built)

**Migration status:** `0002_create_account_types.py` is complete — no changes needed. Schema and seed data are defined in TASK-categories.md (Migration 1). Summary for reference:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | PK |
| `account_type` | `TEXT NOT NULL` | `asset`, `investment`, `liability` |
| `account_subtype` | `TEXT NOT NULL` | e.g. `current`, `savings`, `credit_card` |
| `description` | `TEXT` | Optional |
| `record_status` | `TEXT NOT NULL DEFAULT 'active'` | `active`, `inactive`, `deleted` |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |

`UNIQUE (account_type, account_subtype)` · `CHECK (record_status IN ('active', 'inactive', 'deleted'))`

---

## Tables to create — migration `0004_create_accounts.py`

All 8 tables created in a single migration in dependency order: `account_master` first, then all 7 extension tables (all FK to `account_master.id`).

**Migration status:** `0004_create_accounts.py` exists but is inconsistent with this task doc and must be fully rewritten. Specific divergences: uses `account_status` (wrong) not `record_status`; has extra columns `institution_name` and `account_opening_date` (not in scope for Phase 1); is missing `opening_value`; has `deleted_at` column (not needed — sync_status model); record_status CHECK has wrong values. See "What to build" checklist.

---

### Base table — `account_master`

Common columns shared by every account regardless of account subtype.

| Column | Sheet col | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | — | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_id` | 1 (`id`) | `TEXT NOT NULL` | Natural key — UNIQUE; `ACC-YYYYMMDD-NNN` |
| `account_name` | 2 (`name`) | `TEXT NOT NULL` | Transform hard errors if empty |
| `account_type` | 3 (`type`) | `TEXT NOT NULL` | FK to account_types; transform hard errors if not in `{'asset', 'investment', 'liability'}` |
| `account_subtype` | 4 (`sub_type`) | `TEXT NOT NULL` | FK to account_types; transform hard errors if empty |
| `currency_code` | 5 (`currency`) | `TEXT NOT NULL` | 3-char uppercase; transform hard errors if empty |
| `opening_value` | 6 (`opening_value`) | `NUMERIC(19,6) NOT NULL` | Raw sheet value — negative for liabilities; immutable after create |
| `account_description` | 8 (`description`) | `TEXT` | NULL if empty |
| `record_status` | 9 (`record_status`) | `TEXT NOT NULL` | Mirrors sheet verbatim; transform hard errors if empty or not in `{'active', 'inactive', 'deleted', 'locked'}` |
| `created_at` | — | `TIMESTAMPTZ NOT NULL` | When first written by the extract job |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL` | When last updated by the extract job |

Constraints:
- `PRIMARY KEY (id)`
- `UNIQUE (account_id)`
- `FOREIGN KEY (account_type, account_subtype) REFERENCES account_types(account_type, account_subtype)`
- `CHECK (char_length(currency_code) = 3 AND currency_code = upper(currency_code))`
- `CHECK (account_type IN ('asset', 'investment', 'liability'))`
- `CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))`
- `CHECK ((account_type IN ('asset', 'investment') AND opening_value >= 0) OR (account_type = 'liability' AND opening_value <= 0))`

Note: sheet col 7 (`current_value`) is virtual and always blank — not stored. Sheet cols 10–12 (`sync_status`, `sync_date_time`, `sync_notes`) are written back to the sheet by the extract job. Sheet cols 13–14 (`created_at`, `updated_at`) are not stored in the DB.

---

## Sign convention

`account_master.opening_value` stores the raw sheet value — negative for liabilities (the GAS backend negates user input on write). This mirrors the sheet accurately. A DB-level CHECK enforces the sign convention by `account_type` — see `account_master` constraints.

Extension table monetary fields use positive magnitudes (`abs(opening_value)` when seeding from the sheet). Liability nature is implied by `account_type`. Net-worth at the reporting layer: `sum(asset/investment values) − sum(liability balances)`.

**Currency:** No `currency_code` column exists in any extension table — all monetary amounts are implicitly in `account_master.currency_code`. Every reporting query that aggregates extension table values must JOIN to `account_master` to resolve the currency.

---

## SCD Type 2 pattern

All extension tables implement SCD Type 2: multiple rows per account over time. `effective_to_dt IS NULL` = current record. A partial unique index enforces exactly one current record per account at all times.

`entity_type` / `entity_id` are a polymorphic reference to whichever entity triggered the state change. Phase 1: always NULL (opening row, not triggered by a specific entity). A future phase will set `entity_type = 'transaction'` when a transaction mutates the account state.

---

### Extension table — `account_deposit_details`

account_subtype values: `current`, `savings`, `cash`. Extension table routing is a Phase 2 hardcoded dict in `database/accounts.py` — no `structure_type` DB column (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | `'transaction'` when entity-driven; NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `current_balance` | `NUMERIC(19,6) NOT NULL` | Balance as of this record |
| `interest_rate` | `NUMERIC(8,4)` | Annual rate — NULL for current/cash accounts |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` — NULL if not applicable |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` — NULL for current/cash |
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

account_subtype values: `stocks_shares`, `isa`, `pension_sipp`, `crypto`, `commodities`, `other`. Extension table routing deferred to Phase 2 (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Market value as of this record |
| `cost_basis` | `NUMERIC(19,6)` | Total acquisition cost — NULL if unknown |
| `units_held` | `NUMERIC(19,6)` | Quantity held — NULL for fund-based accounts |
| `unit_value` | `NUMERIC(19,6)` | Price per unit — NULL for fund-based accounts |
| `unit_type` | `TEXT` | e.g. `shares`, `BTC` — NULL for fund-based accounts |
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
- `CHECK (units_held >= 0)`
- `CHECK (unit_value >= 0)`
- `CHECK (current_value >= 0)`
- `CHECK (cost_basis >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_fixed_income_details`

account_subtype values: `fixed_deposit`, `bonds`. Extension table routing deferred to Phase 2 (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `face_value` | `NUMERIC(19,6) NOT NULL` | Par / redemption value |
| `purchase_price` | `NUMERIC(19,6) NOT NULL` | Amount actually paid |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual coupon or deposit rate |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` — NULL for zero-coupon |
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
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual'))`
- `CHECK (maturity_date > start_date)`
- `CHECK (face_value > 0)`
- `CHECK (purchase_price > 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (current_value >= 0)`
- `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

### Extension table — `account_property_details`

account_subtype values: `property`. Extension table routing deferred to Phase 2 (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `purchase_price` | `NUMERIC(19,6) NOT NULL` | Original purchase price |
| `current_value` | `NUMERIC(19,6) NOT NULL` | Current estimated market value |
| `purchase_date` | `DATE` | NULL for inherited or undocumented acquisition |
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

account_subtype values: `p2p_lending`. Extension table routing deferred to Phase 2 (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
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

account_subtype values: `credit_card`, `heloc`, `overdraft`. Extension table routing deferred to Phase 2 (see Q3).

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `credit_limit` | `NUMERIC(19,6) NOT NULL` | Total credit limit |
| `current_balance` | `NUMERIC(19,6) NOT NULL` | Amount currently owed (positive = debt) |
| `annual_percentage_rate` | `NUMERIC(8,4)` | Annual percentage rate |
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
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((annual_percentage_rate IS NULL AND rate_type IS NULL) OR (annual_percentage_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (payment_due_day BETWEEN 1 AND 31)`
- `CHECK (statement_day BETWEEN 1 AND 31)`
- `CHECK (credit_limit > 0)`
- `CHECK (current_balance >= 0)`
- `CHECK (annual_percentage_rate >= 0)`
- `CHECK (minimum_payment >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

Note: No `CHECK (current_balance <= credit_limit)` — over-limit balances (penalty fees, rounding) are valid in practice and accepted by this schema.

---

### Extension table — `account_installment_loan_details`

account_subtype values: `personal_loan`, `auto_loan`, `mortgage`, `student_loan`, `medical_loan`, `debt_consolidation`. Extension table routing deferred to Phase 2 (see Q3).

All columns are time-varying — extra payments can reduce principal or tenure; refinancing changes rate, term, and monthly payment.

| Column | DB type | Notes |
|--------|---------|-------|
| `id` | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_master_id` | `UUID NOT NULL` | FK → `account_master.id` |
| `entity_type` | `TEXT` | NULL for non-entity-driven changes |
| `entity_id` | `UUID` | NULL when `entity_type` is NULL |
| `original_principal_amount` | `NUMERIC(19,6) NOT NULL` | Principal at drawdown — fixed for the life of the loan |
| `outstanding_balance` | `NUMERIC(19,6) NOT NULL` | Remaining balance — decreases with each payment |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual rate |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `term_months` | `INTEGER NOT NULL` | Remaining term as of `effective_from_dt` — decreases as payments are made |
| `monthly_payment` | `NUMERIC(19,6) NOT NULL` | Current scheduled monthly payment |
| `start_date` | `DATE NOT NULL` | Original loan drawdown date — does not change |
| `end_date` | `DATE NOT NULL` | Projected final payment date |
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
- `CHECK (end_date > start_date)`
- `CHECK (original_principal_amount > 0)`
- `CHECK (outstanding_balance >= 0)`
- `CHECK (monthly_payment > 0)`
- `CHECK (term_months > 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

---

## Referenced by

- `transactions` — FK to `account_master` (design pending in TASK-transactions.md); accounts must be extracted before transactions
- `subscriptions` — FK to `account_master` (design pending in TASK-subscriptions.md); accounts must be extracted before subscriptions

---

## Extract behaviour

**Sheet tab:** `'accounts'`

**Model:** sync_status (same pattern as categories). The extract job reads `sync_status` from col 10 and writes back `sync_status`, `sync_date_time`, `sync_notes` (cols 10–12) in batch at the end of each batch.

**Batch size:** `_BATCH_SIZE = 1000` (same as all other entities).

**Zero-row guard:** If the sheet tab returns 0 rows on the first batch, abort the job run with a `RuntimeError` — the job must never proceed on an empty first read.

**sync_status routing:**

| sync_status | Action |
|---|---|
| `in-sync` | Skip |
| `create-pending` | INSERT path |
| `create-failed` | Retry INSERT |
| `update-pending` | UPDATE path |
| `update-failed` | Retry UPDATE |

Missing or unrecognised `sync_status` → skip with a `warning` log; do not write back.

**Natural key:** `account_id` — the sheet `id` value (`ACC-YYYYMMDD-NNN`). Hard error if empty after stripping whitespace.

**Per-row pass (for each row read from sheet):**

0. Read `sync_status` from col 10. If `in-sync`, skip. If missing or not one of the 5 known values (`create-pending`, `create-failed`, `update-pending`, `update-failed`, `in-sync`), log a `warning` (`unknown_sync_status`) and continue to the next row — do not call transform, do not write back.
1. Call transform: validate all column-level fields and produce the typed dict. Validation rules:
   - `account_id` (sheet col `id`): hard error if empty
   - `account_name` (sheet col `name`): hard error if empty
   - `account_type` (sheet col `type`): hard error if not in `{'asset', 'investment', 'liability'}`
   - `account_subtype` (sheet col `sub_type`): hard error if empty
   - `currency_code` (sheet col `currency`): hard error if empty; normalise to uppercase; hard error if `len(currency_code) != 3` after normalisation
   - `opening_value`: parse from raw sheet string via `decimal.Decimal(raw_str)` inside a `try/except decimal.InvalidOperation` — re-raise as `ValueError` on parse failure; then call `.is_finite()` — re-raise as `ValueError` if not finite. Do not use `float` — `NUMERIC(19,6)` requires exact decimal semantics.
   - `record_status`: hard error if empty or not in `{'active', 'inactive', 'deleted', 'locked'}`
   - `account_description` (sheet col `description`): NULL if empty
   - On `ValueError` from transform: write back `create-failed` (or `update-failed` if `sync_status` was an update variant) + `sync_notes` with the validation message; continue to next row.
2. Route by `sync_status`:
   - `create-pending` / `create-failed`:
     ```sql
     INSERT INTO account_master (account_id, account_name, account_type, account_subtype, currency_code, opening_value, account_description, record_status, created_at, updated_at)
     VALUES (..., now(), now())
     ON CONFLICT (account_id) DO UPDATE SET
         account_name = EXCLUDED.account_name,
         account_type = EXCLUDED.account_type,
         account_subtype = EXCLUDED.account_subtype,
         currency_code = EXCLUDED.currency_code,
         opening_value = EXCLUDED.opening_value,
         account_description = EXCLUDED.account_description,
         record_status = EXCLUDED.record_status,
         updated_at = now()
     RETURNING id
     ```
   - `update-pending` / `update-failed`:
     ```sql
     UPDATE account_master SET
         account_name = $account_name,
         account_type = $account_type,
         account_subtype = $account_subtype,
         currency_code = $currency_code,
         opening_value = $opening_value,
         account_description = $account_description,
         record_status = $record_status,
         updated_at = now()
     WHERE account_id = $account_id
     RETURNING id
     ```
     If 0 rows returned (account not yet in DB), fall back to the INSERT path and log `update_fallback_to_insert` at warning.
3. On known DB integrity error (`UniqueViolation`, `ForeignKeyViolation`, `CheckViolation`, `NotNullViolation`): rollback, write back `create-failed` / `update-failed` + `_to_sync_notes(e)`. All other exceptions propagate and abort the job.

   **`_to_sync_notes` mapping for accounts:**

   | Exception | Human-readable sync_notes |
   |---|---|
   | `UniqueViolation` | `"Duplicate account_id — already exists in DB"` |
   | `ForeignKeyViolation` | `"Unknown account type/subtype combination: {account_type}/{account_subtype}"` |
   | `CheckViolation` (sign guard) | `"Opening value sign mismatch: liabilities must be ≤ 0, assets/investments must be ≥ 0"` |
   | `CheckViolation` (record_status) | `"Invalid record_status value — must be active, inactive, deleted, or locked"` |
   | `CheckViolation` (currency_code) | `"currency_code must be a 3-character uppercase ISO code"` |
   | `CheckViolation` (other) | `"DB constraint violation: {str(e)}"` |
   | `NotNullViolation` | `"Required field is null: {column name from e.diag.column_name}"` |

4. On success: commit, write back `in-sync` + UTC timestamp + `''`.

Each row is committed independently. All write-backs for the batch are accumulated in a `list[WriteBack]` and flushed in a single `batch_update_rows` call at the end of the batch.

**Note on `opening_value` immutability:** `opening_value` is immutable in the GAS backend — it cannot be changed after account creation. GAS enforces this; the extract job writes `opening_value = EXCLUDED.opening_value` in the ON CONFLICT clause for consistency but this value will never actually differ.

**Phase 1 scope:** The extract job writes `account_master` only. Extension table seeding requires data unavailable from the sheet and is deferred to Phase 2.

---

## What to build

- [ ] **Rewrite `migrations/0004_create_accounts.py`** — current file is inconsistent with this task doc and must be fully replaced. Specific issues to fix:
  - `account_status` → `record_status` (column rename throughout)
  - Remove `institution_name` and `account_opening_date` (not in Phase 1 scope)
  - Add `opening_value NUMERIC(19,6) NOT NULL`
  - Fix CHECK: `record_status IN ('active', 'inactive', 'deleted', 'locked')` (not `'closed'`)
  - Remove `deleted_at` column and its CHECK constraint (not needed — sync_status model)
  - Add `CHECK (account_type IN ('asset', 'investment', 'liability'))` on `account_master`
  - Add `CHECK (char_length(currency_code) = 3 AND currency_code = upper(currency_code))` on `account_master`
  - Add `CHECK ((account_type IN ('asset', 'investment') AND opening_value >= 0) OR (account_type = 'liability' AND opening_value <= 0))` on `account_master`
  - Create all 7 extension tables per schema in this task doc (deposit, market_investment, fixed_income, property, p2p_lending, revolving_credit, installment_loan) — the migration must create all 8 tables (account_master + 7), not just the base table

- [ ] `sheets/accounts.py` — `_SYNC_STATUS_COL = 10`, `WriteBack` type alias, `write_back()`, `flush()` (same structure as `sheets/categories.py`)

- [ ] `transforms/accounts.py` — row dict → typed dict; validates and type-converts all source columns; raises `ValueError` on invalid input

- [ ] `database/accounts.py` — `upsert_accounts(conn, rows)` (Phase 1 only; no extension table writes)

- [ ] Wire `_extract_accounts` into `core/extractor.py` — already partially wired; confirm signature matches `upsert_accounts(conn, rows)`
