# TASK — accounts

**Status:** CHANGES IN PROGRESS — BIGINT minor unit storage required across all monetary fields
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
| Q10 | 2-word minimum column names | Enforced on all non-PK columns. PK stays `id`. Sheet `name` → `account_name`; sheet `type` → `account_type`; sheet `sub_type` → `account_subtype`; sheet `currency` → `local_currency`; sheet `opening_value` → `opening_amount_local_value`; sheet `description` → `account_description`. All other mappings follow the same pattern. |
| Q11 | `account_master` FK to `account_types` | `FOREIGN KEY (account_type, account_subtype) REFERENCES account_types(account_type, account_subtype)` |
| Q12 | Deletion model | `record_status TEXT NOT NULL` is the sole status field — mirrored verbatim from the sheet on every insert/update. When a user deletes an account via the app, GAS sets `record_status = 'deleted'` and `sync_status = 'update-pending'`; the extractor picks it up via the normal update path. No `is_deleted` flag, no `deleted_at` timestamp, no soft-delete pass. Same pattern as `category_master`. |
| Q13 | `opening_amount_local_value` sign convention | Stored in minor units — the sheet value (major units) is converted to `int` minor units by the extract job at write time. Negative for liabilities (the GAS backend negates user input on write; minor unit conversion preserves sign). `opening_amount_base_value` follows the same sign — computed as `int(local_major / rate_value × 10^9)` nanograms; since `rate_value > 0` (enforced by CHECK on `currency_rates`), sign is preserved. Extension tables use positive magnitudes (see Q14). |
| Q14 | Sign convention for monetary amounts in extension tables | All monetary amounts in extension tables stored as positive magnitudes. Liability nature implied by `account_type`. Net-worth at the reporting layer: `sum(asset/investment values) − sum(liability balances)`. |
| Q15 | Phase 1 extension table scope | Phase 1 writes `account_master` only. Extension table seeding (deposit, market investment, etc.) requires data beyond what the sheet provides (interest rates, credit limits, etc.) and is deferred to Phase 2. The migration creates all 8 tables; the Phase 1 extract job only writes `account_master`. |
| Q16 | Interest rate metadata | `rate_type TEXT` added to all 5 tables that carry an interest rate. Values: `fixed`, `variable`, `tracker`. Nullable on `account_deposit_details`, `account_p2p_lending_details`, `account_revolving_credit_details`. NOT NULL on `account_fixed_income_details` and `account_installment_loan_details`. `interest_payment_frequency TEXT` added to `account_deposit_details` and `account_fixed_income_details`. Values: `monthly`, `quarterly`, `semi_annual`, `annual`. |
| Q17 | Cost basis | `cost_basis_local_value BIGINT` added (nullable) to `account_market_investment_details`. Required to compute unrealised P&L. Stored in minor units (same as all other monetary fields). Nullable because historical accounts may not have this data. When non-null, `cost_basis_base_value` must also be non-null (enforced by CHECK). |
| Q18 | CHECK constraints on enumerated text fields | `rate_type IN ('fixed', 'variable', 'tracker')` on all 5 tables that carry it. `interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')` on `account_deposit_details` and `account_fixed_income_details`. NULL is valid for all — CHECK only fails on FALSE, not NULL. |
| Q19 | `principal_amount` naming in installment loans | `original_principal_amount_local_value` — fixed at drawdown, never changes. `outstanding_balance_local_value` is the moving figure. |
| Q20 | Units consistency | `CHECK ((units_held IS NULL AND unit_value_local_value IS NULL AND unit_type IS NULL) OR (units_held IS NOT NULL AND unit_value_local_value IS NOT NULL AND unit_type IS NOT NULL))` on `account_market_investment_details`. All three unit fields must be all NULL or all NOT NULL. |
| Q21 | `principal_amount` split in fixed income | Replaced with `face_value_local_value` (par/redemption value) and `purchase_price_local_value` (amount paid). Both NOT NULL. |
| Q22 | Overdraft modelling | Overdraft is modelled exclusively as `liability / overdraft → revolving_credit`. No overdraft field on deposit tables. |
| Q23 | Payment day range constraints | `CHECK (payment_due_day BETWEEN 1 AND 31)` and `CHECK (statement_day BETWEEN 1 AND 31)` on `account_revolving_credit_details`. Both nullable; CHECK only fires on non-NULL values. |
| Q24 | Rental income consistency | `CHECK (is_rental = TRUE OR monthly_rental_income_local_value IS NULL)` on `account_property_details`. |
| Q26 | Monetary field storage type | All `_local_value` and `_base_value` columns use `BIGINT` — stored in the currency's minor unit (`10^decimal_places` from `currency_master`; e.g., pence for GBP, nanograms for XAU, cents for USD, yen for JPY). `units_held` in `account_market_investment_details` remains `NUMERIC(19,6)` — it is a quantity, not a monetary amount. Sheet values (major units) are converted to minor units by the extract job at write time. |
| Q27 | Value range constraints | Strictly positive (`> 0`) on fields that cannot be zero: `face_value_local_value`, `purchase_price_local_value` (fixed income); `purchase_price_local_value`, `current_value_local_value` (property); `principal_lent_local_value` (p2p); `credit_limit_local_value` (revolving credit); `original_principal_amount_local_value`, `monthly_payment_local_value`, `term_months` (installment loan). Non-negative (`>= 0`) on fields that can reach zero: `interest_rate` (deposit, p2p, fixed income, installment); `units_held`, `current_value_local_value`, `cost_basis_local_value` (market investment); `current_value_local_value` (p2p); `current_balance_local_value`, `annual_percentage_rate`, `minimum_payment_local_value` (revolving credit); `outstanding_balance_local_value` (installment). `units_held >= 0` allows recording a fully liquidated position. All `_base_value` columns carry the same CHECK (`>= 0` or `> 0`) as their `_local_value` counterpart — base values follow extension table positive-magnitude convention. |
| Q29 | Date ordering constraints | `CHECK (maturity_date > start_date)` on `account_fixed_income_details`. `CHECK (end_date > start_date)` on `account_installment_loan_details`. |
| Q30 | SCD temporal ordering | `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)` on all 7 extension tables. |
| Q31 | `CHECK (account_type IN (...))` on `account_types` | Without this, a rogue row with an arbitrary `account_type` would propagate through the FK into `account_master`. |
| Q32 | Rate/rate_type co-presence | Deposit, revolving credit, p2p: both NULL or both NOT NULL. Fixed income, installment loan: rate_type NOT NULL (always known at issuance). `CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL)` on deposit — a payment schedule without a rate is meaningless. `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)` on fixed income — zero-coupon bonds carry `interest_rate = 0`; any non-zero rate implies a defined payment frequency. |
| Q33 | Entity type constraint | `CHECK (entity_type IN ('transaction'))` on all 7 extension tables — NULL remains valid. Each new entity type introduced in a future phase is added via migration. |
| Q34 | `local_currency` / `base_currency` format guard | `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))` and `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))` on `account_master` — enforces 3-char ISO code and prevents `'gbp'` and `'GBP'` being treated as different currencies. Extension tables carry the same columns and the same CHECKs. |
| Q35 | Dual-currency monetary fields | All monetary amounts in `account_master` are stored in both local currency (as recorded in the sheet) and base currency (XAU as of extract time). The base value is computed by the extract job using the prevailing rate from `currency_rates`. The `base_currency` column records which base currency was active at creation time so that future changes to the base currency leave historical rows unaffected. Extension tables follow the same dual-currency pattern for all monetary fields (Phase 2). |
| Q36 | `currency_rate_ref` nullability | NULL when `local_currency = base_currency` (no conversion needed — local IS the base). NOT NULL when they differ. A CHECK enforces: `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`. All tables (`account_master` and all 7 extension tables) carry the same nullable `currency_rate_ref`. |
| Q37 | FX rate lookup strategy | The extract job queries: `SELECT id, rate_value FROM currency_rates WHERE quote_currency_code = %s AND base_currency_code = %s AND rate_date <= CURRENT_DATE ORDER BY rate_date DESC LIMIT 1` (parameters: `local_currency`, `base_currency`). `rate_value` convention: local currency major units per 1 XAU gram (e.g., GBP rate ≈ 76 means 76 GBP per gram of gold). Therefore `local_major / rate_value` yields grams, which are then converted to nanograms by multiplying by `10^9`. The `base_currency_code` filter is explicit even though `chk_cr_base_is_xau` currently guarantees all rows are XAU-based — this makes the FK semantics future-proof. If no row is found, the row fails with `create-failed` and `sync_notes = "No rate found for {local_currency} — run currency-rates job first"`. If `local_currency = base_currency` (XAU account), skip the lookup entirely — `currency_rate_ref = NULL`, `base_minor = local_minor` (same minor unit value, since both are in nanograms). The lookup happens in `database/accounts.py` inside the create path only (never on the update path). |
| Q38 | `base_currency` column rationale | Explicitly stored on every table so that when the base currency changes in a future release, existing records retain their original base currency. New records written after the change carry the new base currency. Consistent column name across `account_master` and all extension tables — the reporting layer always reads `base_currency` regardless of which table it queries. |
| Q39 | Immutability of opening amount fields | `opening_amount_local_value`, `opening_amount_base_value`, `local_currency`, `base_currency`, `currency_rate_ref`, and `created_at` are immutable after the first successful sync. The ON CONFLICT DO UPDATE clause must NOT include these columns — if a row already exists in the DB, only `account_name`, `account_type`, `account_subtype`, `account_description`, `record_status`, and `updated_at` are updated. Note: `account_type` is mutable but its sign must be consistent with the immutable `opening_amount_local_value`. Changing `account_type` from `asset` to `liability` (or vice versa) would violate `chk_am_opening_value_sign` at the DB level. GAS must prevent this change in the sheet; the DB constraint is a safety net. |
| Q40 | Minor unit conversion formula | All `_local_value` and `_base_value` columns store `BIGINT` minor units. The extract job converts sheet major-unit values at write time. `_load_decimal_places(conn)` queries `SELECT currency_code, decimal_places FROM currency_master` once per batch and returns `{currency_code: decimal_places}`. Per row — local: `local_minor = int((local_major × Decimal(10)**local_decimal_places).to_integral_value(ROUND_HALF_UP))`; base (XAU always `decimal_places = 9`): if `local_currency == 'XAU'` then `base_minor = local_minor`; else `base_minor = int((local_major / rate_value × Decimal(10)**9).to_integral_value(ROUND_HALF_UP))`. All arithmetic uses `decimal.Decimal` — never `float`. Sign is preserved (negative integers for liabilities). If `local_currency` is absent from the preloaded dict: write back `create-failed` with `sync_notes = "Currency {local_currency} not found in currency_master"`; continue to next row. This is handled outside the psycopg2 except block — do NOT rollback. `units_held` in `account_market_investment_details` is a quantity (not a monetary amount) and remains `NUMERIC(19,6)` — it is not converted. |

---

## Sheet schema (14 columns)

| # | Column | Notes |
|---|--------|-------|
| 1 | `id` | Natural key — `ACC-YYYYMMDD-NNN` |
| 2 | `name` | |
| 3 | `type` | `asset`, `investment`, `liability` |
| 4 | `sub_type` | |
| 5 | `currency` | Stored uppercase — maps to `local_currency` |
| 6 | `opening_value` | Balance at import. Negative in sheet for liabilities (backend negates user input). Immutable after create. Maps to `opening_amount_local_value`. |
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

**Migration status:** `0004_create_accounts.py` must be rewritten — dual-currency schema implemented; BIGINT minor unit storage now required across all monetary columns.

---

### Base table — `account_master`

Common columns shared by every account regardless of account subtype.

| Column | Sheet col | DB type | Notes |
|--------|-----------|---------|-------|
| `id` | — | `UUID NOT NULL DEFAULT gen_random_uuid()` | Surrogate PK |
| `account_id` | 1 (`id`) | `TEXT NOT NULL` | Natural key — UNIQUE; `ACC-YYYYMMDD-NNN` |
| `account_name` | 2 (`name`) | `TEXT NOT NULL` | Hard error if empty |
| `account_type` | 3 (`type`) | `TEXT NOT NULL` | FK to account_types; hard error if not in `{'asset', 'investment', 'liability'}` |
| `account_subtype` | 4 (`sub_type`) | `TEXT NOT NULL` | FK to account_types; hard error if empty |
| `opening_amount_local_value` | 6 (`opening_value`) | `BIGINT NOT NULL` | Sheet value converted to minor units (e.g., pence for GBP, nanograms for XAU) — negative for liabilities; immutable after create |
| `opening_amount_base_value` | — | `BIGINT NOT NULL` | XAU equivalent of `opening_amount_local_value` in nanograms (`10^9` nanograms = 1 gram); computed by extract job; immutable after create |
| `local_currency` | 5 (`currency`) | `CHAR(3) NOT NULL` | 3-char uppercase ISO code; immutable after create |
| `base_currency` | — | `CHAR(3) NOT NULL` | Base currency active at create time (currently always `'XAU'`); immutable after create |
| `currency_rate_ref` | — | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency`; immutable after create |
| `account_description` | 8 (`description`) | `TEXT` | NULL if empty |
| `record_status` | 9 (`record_status`) | `TEXT NOT NULL` | Mirrors sheet verbatim; hard error if empty or not in `{'active', 'inactive', 'deleted', 'locked'}` |
| `created_at` | — | `TIMESTAMPTZ NOT NULL` | When first written by the extract job |
| `updated_at` | — | `TIMESTAMPTZ NOT NULL` | When last updated by the extract job |

Constraints:
- `CONSTRAINT pk_account_master PRIMARY KEY (id)`
- `CONSTRAINT uq_account_master_account_id UNIQUE (account_id)`
- `CONSTRAINT fk_am_account_type_subtype FOREIGN KEY (account_type, account_subtype) REFERENCES account_types(account_type, account_subtype)`
- `CONSTRAINT fk_am_rate_ref FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `CONSTRAINT chk_am_account_type CHECK (account_type IN ('asset', 'investment', 'liability'))`
- `CONSTRAINT chk_am_record_status CHECK (record_status IN ('active', 'inactive', 'deleted', 'locked'))`
- `CONSTRAINT chk_am_local_currency CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CONSTRAINT chk_am_base_currency CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CONSTRAINT chk_am_opening_value_sign CHECK ((account_type IN ('asset', 'investment') AND opening_amount_local_value >= 0) OR (account_type = 'liability' AND opening_amount_local_value <= 0))`
- `CONSTRAINT chk_am_base_value_sign CHECK ((account_type IN ('asset', 'investment') AND opening_amount_base_value >= 0) OR (account_type = 'liability' AND opening_amount_base_value <= 0))`
- `CONSTRAINT chk_am_rate_ref_required CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`

Note: sheet col 7 (`current_value`) is virtual and always blank — not stored. Sheet cols 10–12 (`sync_status`, `sync_date_time`, `sync_notes`) are written back to the sheet by the extract job. Sheet cols 13–14 (`created_at`, `updated_at`) are not stored in the DB. `local_currency` and `base_currency` are table-level columns shared by all monetary fields in the row — consistent naming with all extension tables.

---

## Sign convention

`account_master.opening_amount_local_value` stores the sheet value converted to minor units — negative for liabilities (GAS negates user input on write; minor unit conversion preserves sign). `opening_amount_base_value` stores the XAU nanogram equivalent: `int(local_major / rate_value × 10^9)`. Since `rate_value > 0`, sign is preserved. Both are `BIGINT` and are covered by the sign guard CHECKs on `account_master`.

Extension table monetary fields use positive magnitudes. Liability nature is implied by `account_type`. Net-worth at the reporting layer: `sum(asset/investment values) − sum(liability balances)`.

**Currency columns — consistent across all tables:** `account_master` and all 7 extension tables carry the same three currency columns: `local_currency CHAR(3) NOT NULL`, `base_currency CHAR(3) NOT NULL`, and `currency_rate_ref UUID` (nullable when local = base). These apply to ALL monetary fields in a given row. Per monetary field: `_{field}_local_value` (in local currency) and `_{field}_base_value` (in base currency / XAU). `local_currency` is technically derivable from `account_master` via JOIN but is kept on extension rows for readability.

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
| `current_balance_local_value` | `BIGINT NOT NULL` | Balance as of this record in local currency |
| `current_balance_base_value` | `BIGINT NOT NULL` | Balance as of this record in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `interest_rate` | `NUMERIC(8,4)` | Annual rate — NULL for current/cash accounts |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` — NULL if not applicable |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` — NULL for current/cash |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((interest_rate IS NULL AND rate_type IS NULL) OR (interest_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual'))`
- `CHECK (interest_payment_frequency IS NULL OR interest_rate IS NOT NULL)`
- `CHECK (interest_rate >= 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (current_balance_local_value >= 0)`
- `CHECK (current_balance_base_value >= 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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
| `current_value_local_value` | `BIGINT NOT NULL` | Market value in local currency |
| `current_value_base_value` | `BIGINT NOT NULL` | Market value in base currency (XAU) |
| `cost_basis_local_value` | `BIGINT` | Total acquisition cost in local currency — NULL if unknown |
| `cost_basis_base_value` | `BIGINT` | Total acquisition cost in base currency (XAU) — NULL if unknown |
| `units_held` | `NUMERIC(19,6)` | Quantity held (not a monetary amount — fractional units allowed) — NULL for fund-based accounts |
| `unit_value_local_value` | `BIGINT` | Price per unit in local currency — NULL for fund-based accounts |
| `unit_value_base_value` | `BIGINT` | Price per unit in base currency (XAU) — NULL for fund-based accounts |
| `unit_type` | `TEXT` | e.g. `shares`, `BTC` — NULL for fund-based accounts |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK ((units_held IS NULL AND unit_value_local_value IS NULL AND unit_type IS NULL) OR (units_held IS NOT NULL AND unit_value_local_value IS NOT NULL AND unit_type IS NOT NULL))`
- `CHECK ((cost_basis_local_value IS NULL AND cost_basis_base_value IS NULL) OR (cost_basis_local_value IS NOT NULL AND cost_basis_base_value IS NOT NULL))`
- `CHECK ((unit_value_local_value IS NULL AND unit_value_base_value IS NULL) OR (unit_value_local_value IS NOT NULL AND unit_value_base_value IS NOT NULL))`
- `CHECK (units_held >= 0)`
- `CHECK (unit_value_local_value >= 0)`
- `CHECK (unit_value_base_value >= 0)`
- `CHECK (current_value_local_value >= 0)`
- `CHECK (current_value_base_value >= 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (cost_basis_local_value >= 0)`
- `CHECK (cost_basis_base_value >= 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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
| `face_value_local_value` | `BIGINT NOT NULL` | Par / redemption value in local currency |
| `face_value_base_value` | `BIGINT NOT NULL` | Par / redemption value in base currency (XAU) |
| `purchase_price_local_value` | `BIGINT NOT NULL` | Amount paid in local currency |
| `purchase_price_base_value` | `BIGINT NOT NULL` | Amount paid in base currency (XAU) |
| `current_value_local_value` | `BIGINT NOT NULL` | Current value including accrued interest, in local currency |
| `current_value_base_value` | `BIGINT NOT NULL` | Current value in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual coupon or deposit rate |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `interest_payment_frequency` | `TEXT` | `monthly`, `quarterly`, `semi_annual`, `annual` — NULL for zero-coupon |
| `start_date` | `DATE NOT NULL` | Deposit/issue date |
| `maturity_date` | `DATE NOT NULL` | When principal is returned |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (interest_payment_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual'))`
- `CHECK (maturity_date > start_date)`
- `CHECK (face_value_local_value > 0)`
- `CHECK (face_value_base_value > 0)`
- `CHECK (purchase_price_local_value > 0)`
- `CHECK (purchase_price_base_value > 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (interest_rate >= 0)`
- `CHECK (current_value_local_value >= 0)`
- `CHECK (current_value_base_value >= 0)`
- `CHECK (interest_rate = 0 OR interest_payment_frequency IS NOT NULL)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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
| `purchase_price_local_value` | `BIGINT NOT NULL` | Original purchase price in local currency |
| `purchase_price_base_value` | `BIGINT NOT NULL` | Original purchase price in base currency (XAU) |
| `current_value_local_value` | `BIGINT NOT NULL` | Current estimated market value in local currency |
| `current_value_base_value` | `BIGINT NOT NULL` | Current estimated market value in base currency (XAU) |
| `monthly_rental_income_local_value` | `BIGINT` | NULL if not a rental property; in local currency |
| `monthly_rental_income_base_value` | `BIGINT` | NULL if not a rental property; in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `purchase_date` | `DATE` | NULL for inherited or undocumented acquisition |
| `property_address` | `TEXT` | |
| `is_rental` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (is_rental = TRUE OR monthly_rental_income_local_value IS NULL)`
- `CHECK ((monthly_rental_income_local_value IS NULL AND monthly_rental_income_base_value IS NULL) OR (monthly_rental_income_local_value IS NOT NULL AND monthly_rental_income_base_value IS NOT NULL))`
- `CHECK (monthly_rental_income_local_value > 0)`
- `CHECK (monthly_rental_income_base_value > 0)`
- `CHECK (purchase_price_local_value > 0)`
- `CHECK (purchase_price_base_value > 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (current_value_local_value > 0)`
- `CHECK (current_value_base_value > 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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
| `principal_lent_local_value` | `BIGINT NOT NULL` | Total amount deployed in local currency |
| `principal_lent_base_value` | `BIGINT NOT NULL` | Total amount deployed in base currency (XAU) |
| `current_value_local_value` | `BIGINT NOT NULL` | Outstanding principal + accrued interest in local currency |
| `current_value_base_value` | `BIGINT NOT NULL` | Outstanding principal + accrued interest in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `interest_rate` | `NUMERIC(8,4)` | Expected or realised annual rate |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((interest_rate IS NULL AND rate_type IS NULL) OR (interest_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK (principal_lent_local_value > 0)`
- `CHECK (principal_lent_base_value > 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (current_value_local_value >= 0)`
- `CHECK (current_value_base_value >= 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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
| `credit_limit_local_value` | `BIGINT NOT NULL` | Total credit limit in local currency |
| `credit_limit_base_value` | `BIGINT NOT NULL` | Total credit limit in base currency (XAU) |
| `current_balance_local_value` | `BIGINT NOT NULL` | Amount currently owed (positive = debt) in local currency |
| `current_balance_base_value` | `BIGINT NOT NULL` | Amount currently owed in base currency (XAU) |
| `minimum_payment_local_value` | `BIGINT` | Minimum monthly payment in local currency |
| `minimum_payment_base_value` | `BIGINT` | Minimum monthly payment in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `annual_percentage_rate` | `NUMERIC(8,4)` | Annual percentage rate |
| `rate_type` | `TEXT` | `fixed`, `variable`, `tracker` |
| `payment_due_day` | `INTEGER` | Day of month payment is due (1–31) |
| `statement_day` | `INTEGER` | Statement cut-off day of month (1–31) |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK ((annual_percentage_rate IS NULL AND rate_type IS NULL) OR (annual_percentage_rate IS NOT NULL AND rate_type IS NOT NULL))`
- `CHECK ((minimum_payment_local_value IS NULL AND minimum_payment_base_value IS NULL) OR (minimum_payment_local_value IS NOT NULL AND minimum_payment_base_value IS NOT NULL))`
- `CHECK (payment_due_day BETWEEN 1 AND 31)`
- `CHECK (statement_day BETWEEN 1 AND 31)`
- `CHECK (credit_limit_local_value > 0)`
- `CHECK (credit_limit_base_value > 0)`
- `CHECK (current_balance_local_value >= 0)`
- `CHECK (current_balance_base_value >= 0)`
- `CHECK (annual_percentage_rate >= 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (minimum_payment_local_value >= 0)`
- `CHECK (minimum_payment_base_value >= 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
- `CHECK (effective_to_dt IS NULL OR effective_to_dt > effective_from_dt)`

Note: No `CHECK (current_balance_local_value <= credit_limit_local_value)` — over-limit balances (penalty fees, rounding) are valid in practice and accepted by this schema.

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
| `original_principal_amount_local_value` | `BIGINT NOT NULL` | Principal at drawdown in local currency — fixed for the life of the loan |
| `original_principal_amount_base_value` | `BIGINT NOT NULL` | Principal at drawdown in base currency (XAU) — fixed for the life of the loan |
| `outstanding_balance_local_value` | `BIGINT NOT NULL` | Remaining balance in local currency |
| `outstanding_balance_base_value` | `BIGINT NOT NULL` | Remaining balance in base currency (XAU) |
| `monthly_payment_local_value` | `BIGINT NOT NULL` | Current scheduled monthly payment in local currency |
| `monthly_payment_base_value` | `BIGINT NOT NULL` | Current scheduled monthly payment in base currency (XAU) |
| `local_currency` | `CHAR(3) NOT NULL` | Local currency for all monetary fields in this row |
| `base_currency` | `CHAR(3) NOT NULL` | Base currency for all monetary fields in this row |
| `currency_rate_ref` | `UUID` | FK → `currency_rates(id)`; NULL when `local_currency = base_currency` |
| `interest_rate` | `NUMERIC(8,4) NOT NULL` | Annual rate |
| `rate_type` | `TEXT NOT NULL` | `fixed`, `variable`, `tracker` |
| `term_months` | `INTEGER NOT NULL` | Remaining term as of `effective_from_dt` |
| `start_date` | `DATE NOT NULL` | Original loan drawdown date — does not change |
| `end_date` | `DATE NOT NULL` | Projected final payment date |
| `effective_from_dt` | `TIMESTAMPTZ NOT NULL` | When this state became active |
| `effective_to_dt` | `TIMESTAMPTZ` | When this state ended — NULL = current record |

Constraints:
- `PRIMARY KEY (id)`
- `FOREIGN KEY (account_master_id) REFERENCES account_master(id)`
- `FOREIGN KEY (currency_rate_ref) REFERENCES currency_rates(id)`
- `UNIQUE (account_master_id, effective_from_dt)`
- `PARTIAL UNIQUE INDEX ON (account_master_id) WHERE effective_to_dt IS NULL`
- `CHECK ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type IS NOT NULL AND entity_id IS NOT NULL))`
- `CHECK (entity_type IN ('transaction'))`
- `CHECK (rate_type IN ('fixed', 'variable', 'tracker'))`
- `CHECK (end_date > start_date)`
- `CHECK (original_principal_amount_local_value > 0)`
- `CHECK (original_principal_amount_base_value > 0)`
- `CHECK (outstanding_balance_local_value >= 0)`
- `CHECK (outstanding_balance_base_value >= 0)`
- `CHECK (monthly_payment_local_value > 0)`
- `CHECK (monthly_payment_base_value > 0)`
- `CHECK (char_length(local_currency) = 3 AND local_currency = upper(local_currency))`
- `CHECK (char_length(base_currency) = 3 AND base_currency = upper(base_currency))`
- `CHECK (term_months > 0)`
- `CHECK (interest_rate >= 0)`
- `CHECK (local_currency = base_currency OR currency_rate_ref IS NOT NULL)`
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

**Before the per-row loop (once per batch):** Call `_load_decimal_places(conn)` — `SELECT currency_code, decimal_places FROM currency_master` — and store the result as `{currency_code: decimal_places}`. This dict is used for minor unit conversion on every create row (and update fallback row) processed in the batch. Must execute before the loop begins, not conditionally inside the create branch.

**Per-row pass (for each row read from sheet):**

0. Read `sync_status` from col 10. If `in-sync`, skip. If missing or not one of the 5 known values, log a `warning` (`unknown_sync_status`) and continue — do not call transform, do not write back.

1. Call transform (`transforms/accounts.py`): validate all column-level fields and produce the typed dict. Validation rules:
   - `account_id` (sheet col `id`): hard error if empty
   - `account_name` (sheet col `name`): hard error if empty
   - `account_type` (sheet col `type`): hard error if not in `{'asset', 'investment', 'liability'}`
   - `account_subtype` (sheet col `sub_type`): hard error if empty
   - `local_currency` (sheet col `currency`): hard error if empty; normalise to uppercase; hard error if `len != 3` after normalisation
   - `opening_amount_local_value` (sheet col `opening_value`): parse via `decimal.Decimal(raw_str)` inside `try/except decimal.InvalidOperation` — re-raise as `ValueError` on parse failure; call `.is_finite()` — re-raise as `ValueError` if not finite. Never use `float`.
   - `record_status`: hard error if empty or not in `{'active', 'inactive', 'deleted', 'locked'}`
   - `account_description` (sheet col `description`): NULL if empty
   - On `ValueError` from transform: write back `create-failed` / `update-failed` + `sync_notes` with the message; continue to next row.

2. Route by `sync_status`:

   **`create-pending` / `create-failed`:**

   Minor unit conversion and FX rate lookup (`database/accounts.py`):
   - Set `base_currency = 'XAU'`.
   - Look up `local_decimal_places` for `local_currency` from the preloaded dict. If absent: write back `create-failed` with `sync_notes = "Currency {local_currency} not found in currency_master"`; continue to next row. Not a DB integrity error — do NOT rollback.
   - Compute: `local_minor = int((opening_amount_local_value × Decimal(10)**local_decimal_places).to_integral_value(ROUND_HALF_UP))`. All arithmetic uses `decimal.Decimal` — never `float`. Sign is preserved (negative for liabilities).
   - If `local_currency == 'XAU'`: `base_minor = local_minor`, `currency_rate_ref = None` — skip rate lookup.
   - Otherwise: query `SELECT id, rate_value FROM currency_rates WHERE quote_currency_code = %s AND base_currency_code = %s AND rate_date <= CURRENT_DATE ORDER BY rate_date DESC LIMIT 1` (parameters: `local_currency`, `base_currency`).
     - If 0 rows returned: write back `create-failed` with `sync_notes = "No rate found for {local_currency} — run currency-rates job first"`; continue to next row. Not a DB integrity error — do NOT rollback, do NOT enter the psycopg2 except block.
     - If row found: `base_minor = int((opening_amount_local_value / rate_value × Decimal(10)**9).to_integral_value(ROUND_HALF_UP))`; `currency_rate_ref = rate_id`. XAU always has `decimal_places = 9` (nanogram).
   - The INSERT receives `local_minor` for `opening_amount_local_value` and `base_minor` for `opening_amount_base_value` (both Python `int`).
   - If ON CONFLICT fires on the subsequent INSERT (row already exists), the computed values are silently discarded — the DB retains the original immutable values. This is correct behaviour.

   ```sql
   INSERT INTO account_master (
       account_id, account_name, account_type, account_subtype,
       opening_amount_local_value, opening_amount_base_value,
       local_currency, base_currency,
       currency_rate_ref,
       account_description, record_status, created_at, updated_at
   ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
   ON CONFLICT (account_id) DO UPDATE SET
       account_name        = EXCLUDED.account_name,
       account_type        = EXCLUDED.account_type,
       account_subtype     = EXCLUDED.account_subtype,
       account_description = EXCLUDED.account_description,
       record_status       = EXCLUDED.record_status,
       updated_at          = now()
   RETURNING id
   ```
   Note: `opening_amount_*` fields, `local_currency`, `base_currency`, `currency_rate_ref`, and `created_at` are intentionally excluded from the DO UPDATE SET clause — they are immutable after the first successful sync (see Q39).

   **`update-pending` / `update-failed`:**

   No FX rate lookup — `opening_amount_base_value` and `currency_rate_ref` are immutable and excluded from the UPDATE SET clause (see Q39).

   ```sql
   UPDATE account_master SET
       account_name        = %s,
       account_type        = %s,
       account_subtype     = %s,
       account_description = %s,
       record_status       = %s,
       updated_at          = now()
   WHERE account_id = %s
   RETURNING id
   ```
   If 0 rows returned (account not yet in DB), fall back to the INSERT path and log `update_fallback_to_insert` at warning. The fallback INSERT applies the same minor unit conversion as the create path — the `_load_decimal_places` dict is already loaded (batch-level). **Rollback difference from create path:** the preceding UPDATE opened an implicit psycopg2 transaction even though it matched 0 rows. Therefore, if currency_master is absent or no rate is found during the fallback, call `conn.rollback()` before writing back `update-failed` and continuing — this closes the open transaction. The create path has no open transaction at that point and does not rollback.

3. On known DB integrity error (`UniqueViolation`, `ForeignKeyViolation`, `CheckViolation`, `NotNullViolation`): rollback, write back `create-failed` / `update-failed` + `_to_sync_notes(e)`. All other exceptions propagate and abort the job.

   **Pre-DB failure messages (handled outside the psycopg2 except block):**

   | Path | Condition | `sync_status` | Rollback? | `sync_notes` |
   |---|---|---|---|---|
   | Create | `local_currency` absent from `currency_master` dict | `create-failed` | No | `"Currency {local_currency} not found in currency_master"` |
   | Create | No rate row in `currency_rates` for `local_currency` | `create-failed` | No | `"No rate found for {local_currency} — run currency-rates job first"` |
   | Update fallback | `local_currency` absent from `currency_master` dict | `update-failed` | **Yes** | `"Currency {local_currency} not found in currency_master"` |
   | Update fallback | No rate row in `currency_rates` for `local_currency` | `update-failed` | **Yes** | `"No rate found for {local_currency} — run currency-rates job first"` |

   **`_to_sync_notes` mapping for accounts (psycopg2 integrity errors):**

   | Exception | Human-readable sync_notes |
   |---|---|
   | `UniqueViolation` | `"Duplicate account_id — already exists in DB"` |
   | `ForeignKeyViolation` (account type) | `"Unknown account type/subtype combination — check that account_type and account_subtype match a row in account_types"` |
   | `ForeignKeyViolation` (rate ref) | `"Invalid currency rate reference — rate row no longer exists in currency_rates"` |
   | `CheckViolation` (`chk_am_opening_value_sign`) | `"Opening value sign mismatch: liabilities must be ≤ 0, assets/investments must be ≥ 0"` |
   | `CheckViolation` (`chk_am_base_value_sign`) | `"Opening base value sign mismatch: liabilities must be ≤ 0, assets/investments must be ≥ 0"` |
   | `CheckViolation` (`chk_am_record_status`) | `"Invalid record_status — must be active, inactive, deleted, or locked"` |
   | `CheckViolation` (`chk_am_local_currency`) | `"local_currency must be a 3-character uppercase ISO code"` |
   | `CheckViolation` (`chk_am_base_currency`) | `"base_currency must be a 3-character uppercase ISO code"` |
   | `CheckViolation` (other) | `"DB constraint violation: {constraint_name}"` where `constraint_name = e.diag.constraint_name` (no fallback) |
   | `NotNullViolation` | `"Required field is null: {e.diag.column_name}"` |

   Note: FK disambiguation (`fk_am_account_type_subtype` vs `fk_am_rate_ref`) uses exact match on `e.diag.constraint_name`. CHECK constraint matching also uses exact match (`e.diag.constraint_name == "chk_am_..."`) — not substring matching. The catch-all (`CheckViolation` other) applies to any constraint name not explicitly listed.

4. On success: commit, write back `in-sync` + UTC timestamp + `''`.

Each row is committed independently. All write-backs for the batch are accumulated in a `list[WriteBack]` and flushed in a single `batch_update_rows` call at the end of the batch.

**Note on immutability:** `opening_amount_*` fields, `local_currency`, `base_currency`, `currency_rate_ref`, and `created_at` cannot be changed after the first successful sync. GAS prevents changes to `opening_amount_local_value` in the sheet; the extract job enforces this at the DB layer by excluding these columns from the ON CONFLICT DO UPDATE and from the UPDATE path SET clause.

**Phase 1 scope:** The extract job writes `account_master` only. Extension table seeding requires data unavailable from the sheet and is deferred to Phase 2.

---

## What to build

- [ ] **Rewrite `migrations/0004_create_accounts.py`** — full replacement required. Dual-currency schema implemented; BIGINT minor unit change now needed:
  - Change all `_local_value` and `_base_value` columns from `NUMERIC(19,6)` → `BIGINT` on `account_master` and all 7 extension tables
  - `units_held` in `account_market_investment_details` stays `NUMERIC(19,6)` — it is a quantity, not a monetary amount
  - All other dual-currency changes (named constraints, FKs, CHECKs) remain as currently implemented

- [ ] **Rewrite `database/accounts.py`** — add minor unit conversion and `currency_master` lookup:
  - Add `_load_decimal_places(conn)` helper: `SELECT currency_code, decimal_places FROM currency_master`; returns `{currency_code: decimal_places}`; called once per batch at the top of `upsert_accounts`
  - In create path: look up `local_decimal_places` from preloaded dict; if absent write back `create-failed` with `"Currency {local_currency} not found in currency_master"` and continue
  - Compute `local_minor = int((opening_amount_local_value × Decimal(10)**local_decimal_places).to_integral_value(ROUND_HALF_UP))`
  - If `local_currency == 'XAU'`: `base_minor = local_minor`; else after rate lookup: `base_minor = int((opening_amount_local_value / rate_value × Decimal(10)**9).to_integral_value(ROUND_HALF_UP))`
  - Pass `local_minor` and `base_minor` (Python `int`) to the INSERT — all other DB layer logic unchanged

- [x] **`transforms/accounts.py`** — DONE. Returns `local_currency` and `opening_amount_local_value` (major-unit `Decimal`). No change needed — minor unit conversion is the DB layer's responsibility.

- [x] **`sheets/accounts.py`** — DONE. No changes needed. `_SYNC_STATUS_COL = 10` is correct.

- [x] **`_runbooks/USAGE-INSTRUCTIONS.md`** — DONE. Accounts recovery section updated with `local_currency` rename and missing-rate failure cause. Still needs: add `"Currency {local_currency} not found in currency_master"` as a new failure cause bullet.
