# Account Schema Design — PostgreSQL

**Status:** Draft — under discussion  
**Target:** PostgreSQL (primary store) → Spark (analytics / batch processing)  
**Source of truth for current app schema:** `forge/expense-tracker/api/account-schema.gs`

---

## 1. Target Architecture

```
Google Sheets (data entry / live balances)
        │
        │  sync job (Python)
        ▼
   PostgreSQL  ◄──── direct writes (future: app writes here first)
        │
        │  Spark reads via JDBC / Parquet export
        ▼
   Spark Jobs (amortisation, projections, insights)
        │
        │  write computed results back
        ▼
   Google Sheets (precomputed insight tables)
```

PostgreSQL is the **analytical source of truth**.  
Google Sheets remains the **entry interface** until a native API replaces it.

---

## 2. Design Principles

1. **Never use FLOAT for money.** All monetary values use `NUMERIC(19,4)`.  
   Rationale: floating-point arithmetic produces rounding errors that compound across Spark aggregations.

2. **All timestamps are `TIMESTAMPTZ`.** Always stored in UTC, displayed in local time.  
   `DATE` for calendar dates that have no time component (due dates, disbursement dates).

3. **UUID primary keys.** No sequential integers.  
   Rationale: Spark jobs can generate IDs without coordination; safe for eventual distributed writes; no hotspot on insert.

4. **TEXT + CHECK over ENUM for evolvable value sets.**  
   PostgreSQL ENUMs require `ALTER TYPE` to add values — an exclusive lock in older versions. New sub-types (e.g., a new liability product) should not require a schema migration ceremony.  
   Exception: truly fixed, closed sets may use ENUM.

5. **Validation at the database layer.** CHECK constraints encode business rules. The application validates too, but the database is the last line of defence — especially important when Spark or sync jobs write directly.

6. **Flat wide table over deep normalisation for Spark.**  
   Joins in Spark require shuffle operations (expensive). A single `accounts` table with nullable sub-type-specific columns is preferable to `accounts` + `account_liability_details` + `account_investment_details`.  
   Columnar storage (Parquet) handles sparse columns efficiently — nulls cost almost nothing.

7. **Balances stored as non-negative.** See Section 6.

8. **Soft delete always.** `is_deleted` + `deleted_at`. Hard deletes break historical joins and Spark replays.

9. **Audit columns on every table.** `created_at`, `updated_at` — enforced by trigger, not application.

10. **Provenance columns.** Every row records where it came from (`source_system`, `external_ref`). Essential for sync dedup and replay safety.

---

## 3. Sub-type Classification

```
ASSET sub-types:
  current, savings, cash

INVESTMENT sub-types:
  stocks_shares, isa, pension_sipp, crypto, fixed_deposit,
  bonds, property, commodities, p2p_lending, other

LIABILITY sub-types:
  credit_card, overdraft,                          ← revolving credit
  personal_loan, mortgage, auto_loan, heloc,        ← fixed-term loans
  student_loan, medical_loan, debt_consolidation    ← fixed-term loans

LOAN sub-types (liability, fixed-term — subset of above):
  personal_loan, mortgage, auto_loan, heloc,
  student_loan, medical_loan, debt_consolidation

REVOLVING sub-types (liability, no fixed term):
  credit_card, overdraft

YIELD-BEARING investment sub-types:
  fixed_deposit, bonds, savings (when interest_rate applies)
```

Note: HELOC is a hybrid — it has a credit limit (revolving draw period) AND a loan term (repayment period). It receives fields from both groups.

---

## 4. Table DDL

```sql
-- ── Shared trigger function (reused across all tables) ─────────────────────────

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ── accounts ──────────────────────────────────────────────────────────────────

CREATE TABLE accounts (

  -- ── Identity ────────────────────────────────────────────────────────────────
  id                    UUID          NOT NULL DEFAULT gen_random_uuid(),
  name                  TEXT          NOT NULL,         -- short alias: "Axis Platinum"
  institution           TEXT,                           -- lender/bank: "Axis Bank"
  type                  TEXT          NOT NULL,         -- asset | investment | liability
  sub_type              TEXT          NOT NULL,         -- see sub-type classification above
  currency              CHAR(3)       NOT NULL,         -- ISO 4217: GBP, INR, USD

  -- ── Balances ─────────────────────────────────────────────────────────────────
  -- Always stored as non-negative. Liabilities: what you owe (positive).
  -- Assets/investments: what you hold (positive).
  -- Sign is inferred from `type` at query time.
  opening_balance       NUMERIC(19,4) NOT NULL DEFAULT 0,
  current_balance       NUMERIC(19,4) NOT NULL DEFAULT 0,

  -- ── Status ──────────────────────────────────────────────────────────────────
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  notes                 TEXT,

  -- ── Liability: universal ────────────────────────────────────────────────────
  -- Applies to: all liability sub-types
  interest_rate         NUMERIC(8,4),   -- APR % annualised, e.g. 18.9000
                                        -- Also used for investment yield (fixed_deposit, bonds, savings)
  payment_due_day       SMALLINT,       -- Day of month: 1–31

  -- ── Liability: revolving credit ─────────────────────────────────────────────
  -- Applies to: credit_card, overdraft, heloc
  credit_limit          NUMERIC(19,4),  -- Maximum available credit in account currency
  minimum_payment       NUMERIC(19,4),  -- Fixed minimum payment amount due per cycle

  -- ── Liability: fixed-term loans ─────────────────────────────────────────────
  -- Applies to: personal_loan, mortgage, auto_loan, heloc,
  --             student_loan, medical_loan, debt_consolidation
  loan_term_months      SMALLINT,       -- Total agreed term, e.g. 360 for 30-year mortgage
  emi_amount            NUMERIC(19,4),  -- Fixed monthly instalment (principal + interest)
  disbursement_date     DATE,           -- Actual loan start date (≠ created_at in app)

  -- ── Liability: mortgage-specific ────────────────────────────────────────────
  -- Applies to: mortgage
  rate_fix_end_date     DATE,           -- When fixed-rate period ends; NULL = variable/tracker
  property_value        NUMERIC(19,4),  -- Current estimated property value
  property_value_as_of  DATE,           -- Date property_value was last assessed

  -- ── Investment: yield-bearing ────────────────────────────────────────────────
  -- Applies to: fixed_deposit, bonds (interest_rate shared with liability above)
  maturity_date         DATE,           -- Instrument maturity / expiry date

  -- ── Provenance ──────────────────────────────────────────────────────────────
  source_system         TEXT          NOT NULL DEFAULT 'sheets',
                                        -- 'sheets' | 'direct' | 'import'
  external_ref          TEXT,           -- Sheets row ID / external system key
                                        -- Unique per source_system for dedup

  -- ── Audit ────────────────────────────────────────────────────────────────────
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  is_deleted            BOOLEAN       NOT NULL DEFAULT FALSE,
  deleted_at            TIMESTAMPTZ,

  -- ── Constraints: primary key ─────────────────────────────────────────────────
  CONSTRAINT accounts_pkey PRIMARY KEY (id),

  -- ── Constraints: type safety ─────────────────────────────────────────────────
  CONSTRAINT chk_accounts_type CHECK (
    type IN ('asset', 'investment', 'liability')
  ),
  CONSTRAINT chk_accounts_sub_type CHECK (
    sub_type IN (
      'current', 'savings', 'cash',
      'stocks_shares', 'isa', 'pension_sipp', 'crypto', 'fixed_deposit',
      'bonds', 'property', 'commodities', 'p2p_lending', 'other',
      'personal_loan', 'credit_card', 'mortgage', 'auto_loan', 'heloc',
      'student_loan', 'medical_loan', 'debt_consolidation', 'overdraft'
    )
  ),
  CONSTRAINT chk_accounts_source_system CHECK (
    source_system IN ('sheets', 'direct', 'import')
  ),
  CONSTRAINT chk_accounts_currency CHECK (
    char_length(currency) = 3
  ),

  -- ── Constraints: value ranges ─────────────────────────────────────────────────
  CONSTRAINT chk_accounts_opening_balance  CHECK (opening_balance >= 0),
  CONSTRAINT chk_accounts_current_balance  CHECK (current_balance >= 0),
  CONSTRAINT chk_accounts_interest_rate    CHECK (
    interest_rate IS NULL OR (interest_rate >= 0 AND interest_rate <= 100)
  ),
  CONSTRAINT chk_accounts_payment_due_day  CHECK (
    payment_due_day IS NULL OR (payment_due_day BETWEEN 1 AND 31)
  ),
  CONSTRAINT chk_accounts_credit_limit     CHECK (
    credit_limit IS NULL OR credit_limit > 0
  ),
  CONSTRAINT chk_accounts_minimum_payment  CHECK (
    minimum_payment IS NULL OR minimum_payment >= 0
  ),
  CONSTRAINT chk_accounts_loan_term        CHECK (
    loan_term_months IS NULL OR loan_term_months > 0
  ),
  CONSTRAINT chk_accounts_emi_amount       CHECK (
    emi_amount IS NULL OR emi_amount > 0
  ),
  CONSTRAINT chk_accounts_property_value   CHECK (
    property_value IS NULL OR property_value > 0
  ),
  CONSTRAINT chk_accounts_disbursement     CHECK (
    disbursement_date IS NULL OR disbursement_date <= CURRENT_DATE
  ),

  -- ── Constraints: soft delete integrity ────────────────────────────────────────
  CONSTRAINT chk_accounts_deleted_at CHECK (
    (is_deleted = FALSE AND deleted_at IS NULL)
    OR (is_deleted = TRUE AND deleted_at IS NOT NULL)
  )
);
```

---

## 5. Indexes

```sql
-- Partial indexes exclude deleted rows — keeps them lean and cache-efficient

CREATE INDEX idx_accounts_type
  ON accounts (type)
  WHERE is_deleted = FALSE;

CREATE INDEX idx_accounts_sub_type
  ON accounts (sub_type)
  WHERE is_deleted = FALSE;

CREATE INDEX idx_accounts_currency
  ON accounts (currency)
  WHERE is_deleted = FALSE;

CREATE INDEX idx_accounts_type_sub_type
  ON accounts (type, sub_type)
  WHERE is_deleted = FALSE;

CREATE INDEX idx_accounts_is_active
  ON accounts (is_active)
  WHERE is_deleted = FALSE;

-- Sync dedup: prevents inserting the same Sheets row twice
CREATE UNIQUE INDEX idx_accounts_external_ref
  ON accounts (source_system, external_ref)
  WHERE external_ref IS NOT NULL AND is_deleted = FALSE;

-- Payment calendar: find upcoming due dates
CREATE INDEX idx_accounts_payment_due_day
  ON accounts (payment_due_day)
  WHERE type = 'liability' AND is_deleted = FALSE AND is_active = TRUE;

-- Remortgage alerts
CREATE INDEX idx_accounts_rate_fix_end
  ON accounts (rate_fix_end_date)
  WHERE sub_type = 'mortgage' AND is_deleted = FALSE;
```

---

## 6. Trigger

```sql
CREATE TRIGGER trg_accounts_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();
```

---

## 7. Balance Sign Convention

**Decision: balances stored as non-negative.**

| Type | Meaning of `current_balance` | Net worth contribution |
|------|------------------------------|------------------------|
| asset | Amount you hold | `+ current_balance` |
| investment | Market value you hold | `+ current_balance` |
| liability | Amount you owe | `- current_balance` |

**Why not store liabilities as negative (current GAS approach):**
- SQL aggregations and Spark operations require `ABS()` or sign-flipping scattered across every query
- Comparing balances across accounts of mixed types becomes error-prone
- Constraint `CHECK (current_balance >= 0)` is unambiguous and self-documenting
- Spark window functions (LAG, cumulative sum for paydown charts) work on natural values

**Net worth query:**
```sql
SELECT
  currency,
  SUM(CASE WHEN type IN ('asset', 'investment') THEN  current_balance
           WHEN type = 'liability'              THEN -current_balance
      END) AS net_worth
FROM accounts
WHERE is_deleted = FALSE AND is_active = TRUE
GROUP BY currency;
```

**Migration note:** when syncing from Sheets, flip sign for liability `current_value` on ingest:
```python
balance = abs(row['current_value'])  # Sheets stores liabilities negative
```

---

## 8. Views

Views are read by both the application and Spark. Spark reads via JDBC; the views provide a stable, computed interface so Spark jobs do not embed raw field arithmetic.

```sql
-- ── Active accounts (primary Spark read target) ───────────────────────────────

CREATE VIEW v_accounts_active AS
SELECT
  id,
  name,
  institution,
  type,
  sub_type,
  currency,
  opening_balance,
  current_balance,

  -- Sign-adjusted balance for net worth calculations
  CASE
    WHEN type IN ('asset', 'investment') THEN  current_balance
    WHEN type = 'liability'             THEN -current_balance
  END AS signed_balance,

  -- Liability computed fields
  interest_rate,
  payment_due_day,
  credit_limit,
  minimum_payment,
  loan_term_months,
  emi_amount,
  disbursement_date,
  rate_fix_end_date,
  property_value,
  property_value_as_of,
  maturity_date,

  -- Derived: CC utilisation %
  CASE
    WHEN credit_limit IS NOT NULL AND credit_limit > 0
    THEN ROUND((current_balance / credit_limit) * 100, 2)
  END AS utilisation_pct,

  -- Derived: estimated monthly interest cost
  CASE
    WHEN interest_rate IS NOT NULL
    THEN ROUND(current_balance * (interest_rate / 12 / 100), 4)
  END AS est_monthly_interest,

  -- Derived: LTV for mortgages
  CASE
    WHEN sub_type = 'mortgage'
     AND property_value IS NOT NULL
     AND property_value > 0
    THEN ROUND((current_balance / property_value) * 100, 2)
  END AS ltv_pct,

  is_active,
  notes,
  source_system,
  external_ref,
  created_at,
  updated_at

FROM accounts
WHERE is_deleted = FALSE;


-- ── Liability summary (debt dashboard) ────────────────────────────────────────

CREATE VIEW v_liability_summary AS
SELECT
  id,
  name,
  institution,
  sub_type,
  currency,
  current_balance                                             AS outstanding,
  credit_limit,
  CASE WHEN credit_limit > 0
       THEN ROUND((current_balance / credit_limit) * 100, 2)
  END                                                         AS utilisation_pct,
  interest_rate,
  ROUND(current_balance * (interest_rate / 12 / 100), 4)     AS est_monthly_interest,
  emi_amount,
  minimum_payment,
  payment_due_day,
  loan_term_months,
  disbursement_date,
  rate_fix_end_date,
  property_value,
  property_value_as_of,
  CASE WHEN property_value > 0
       THEN ROUND((current_balance / property_value) * 100, 2)
  END                                                         AS ltv_pct,
  is_active,
  updated_at
FROM accounts
WHERE type = 'liability'
  AND is_deleted = FALSE;


-- ── Net worth by currency ─────────────────────────────────────────────────────

CREATE VIEW v_net_worth_by_currency AS
SELECT
  currency,
  SUM(CASE WHEN type IN ('asset', 'investment') THEN  current_balance
           WHEN type = 'liability'              THEN -current_balance
      END)                                                    AS net_worth,
  SUM(CASE WHEN type IN ('asset', 'investment')
           THEN current_balance ELSE 0 END)                   AS total_assets,
  SUM(CASE WHEN type = 'liability'
           THEN current_balance ELSE 0 END)                   AS total_liabilities
FROM accounts
WHERE is_deleted = FALSE AND is_active = TRUE
GROUP BY currency;
```

---

## 9. Field Reference

| Field | PostgreSQL Type | Nullable | Applies to | Description |
|-------|----------------|----------|-----------|-------------|
| `id` | UUID | No | all | System-generated primary key |
| `name` | TEXT | No | all | Short display alias |
| `institution` | TEXT | Yes | all | Bank / broker / lender name |
| `type` | TEXT | No | all | `asset` \| `investment` \| `liability` |
| `sub_type` | TEXT | No | all | See sub-type classification |
| `currency` | CHAR(3) | No | all | ISO 4217 code |
| `opening_balance` | NUMERIC(19,4) | No | all | Balance at account creation (≥ 0) |
| `current_balance` | NUMERIC(19,4) | No | all | Live balance, always ≥ 0 |
| `is_active` | BOOLEAN | No | all | FALSE = archived |
| `notes` | TEXT | Yes | all | Free text |
| `interest_rate` | NUMERIC(8,4) | Yes | liability, fixed_deposit, bonds, savings | APR / yield % p.a. |
| `payment_due_day` | SMALLINT | Yes | liability | Day of month 1–31 |
| `credit_limit` | NUMERIC(19,4) | Yes | credit_card, overdraft, heloc | Maximum credit line |
| `minimum_payment` | NUMERIC(19,4) | Yes | credit_card, overdraft | Minimum monthly payment amount |
| `loan_term_months` | SMALLINT | Yes | loan sub-types | Total term in months |
| `emi_amount` | NUMERIC(19,4) | Yes | loan sub-types | Fixed monthly instalment |
| `disbursement_date` | DATE | Yes | loan sub-types | Actual loan start date |
| `rate_fix_end_date` | DATE | Yes | mortgage | Fixed rate expiry date |
| `property_value` | NUMERIC(19,4) | Yes | mortgage | Estimated property value |
| `property_value_as_of` | DATE | Yes | mortgage | Date of last property valuation |
| `maturity_date` | DATE | Yes | fixed_deposit, bonds | Instrument maturity date |
| `source_system` | TEXT | No | all | `sheets` \| `direct` \| `import` |
| `external_ref` | TEXT | Yes | all | Sheets row ID or external key |
| `created_at` | TIMESTAMPTZ | No | all | Record creation timestamp (UTC) |
| `updated_at` | TIMESTAMPTZ | No | all | Last update timestamp (UTC), trigger-managed |
| `is_deleted` | BOOLEAN | No | all | Soft delete flag |
| `deleted_at` | TIMESTAMPTZ | Yes | all | Soft delete timestamp (UTC) |

---

## 10. Spark Consumption Notes

- **Read target:** `v_accounts_active` via JDBC. Pre-computed fields (utilisation, interest, LTV) avoid re-implementing formulas in Spark.
- **Partition hint:** partition Spark reads on `type` — most Spark jobs filter to a single type (liabilities for debt jobs, assets for net worth jobs).
- **No JSONB columns.** Spark cannot push predicates into JSONB; all analytical fields are flat columns.
- **NUMERIC maps to `DecimalType(19,4)` in Spark.** Preserves full precision across aggregations.
- **UUID maps to `StringType` in Spark JDBC by default.** Cast to string explicitly if needed; do not use as a sort key in Spark (use `created_at` instead).
- **Soft-delete filter:** Spark jobs always add `WHERE is_deleted = FALSE` — this is enforced in the view; jobs reading the view do not need to add it explicitly.

---

## 11. Sync from Google Sheets

The Python sync job ingests account rows from Sheets into this table.

```
Sheets column       → PostgreSQL column         Notes
──────────────────────────────────────────────────────────────────
id                  → external_ref              Sheets row identifier
name                → name
(embedded)          → institution               Extracted from name (e.g. "CC - Axis Bank" → institution = "Axis Bank", name = "Axis Platinum CC")
type                → type
sub_type            → sub_type
currency            → currency
opening_value       → opening_balance           abs() — Sheets stores liabilities negative
current_value       → current_balance           abs()
is_active           → is_active                 boolean coercion: 'TRUE' / TRUE → true
description         → notes
created_at          → created_at                parse ISO string to TIMESTAMPTZ
(new fields)        → interest_rate, etc.       populated once Sheets captures them
```

**Dedup strategy:** `UPSERT ON CONFLICT (source_system, external_ref)` — safe to run sync job repeatedly without creating duplicates.

---

## 12. Open Decisions

- [ ] **`institution` extraction from existing `name` values** — current names like "CC - Axis Bank" embed the institution. Decision: extract institution on sync, leave name as-is until a UI cleanup pass normalises it. Does not block schema work.
- [ ] **HELOC fields** — receives both revolving fields (`credit_limit`, `minimum_payment`) and loan fields (`loan_term_months`, `emi_amount`, `disbursement_date`). Confirm this is the right model for your HELOC accounts.
- [ ] **`minimum_payment` as fixed amount** — keeping as a fixed monetary amount (not % of balance). Revisit if any CC uses a percentage-of-balance minimum.
- [ ] **`property_value` update workflow** — manually updated, will drift. Confirm `property_value_as_of` is sufficient to surface staleness, or if a separate property valuation log table is needed later.
- [ ] **Multiple currencies per account type** — net worth view aggregates by currency. No cross-currency conversion at the DB layer (rates table handles this). Confirm this is acceptable for Spark jobs.

---

## 13. Implementation Checklist

- [ ] Create `fn_set_updated_at()` trigger function (shared across all tables)
- [ ] Create `accounts` table with full DDL above
- [ ] Create all indexes
- [ ] Create trigger `trg_accounts_updated_at`
- [ ] Create views: `v_accounts_active`, `v_liability_summary`, `v_net_worth_by_currency`
- [ ] Write Python sync job: Sheets → `accounts` (upsert on `external_ref`)
- [ ] Extend GAS account schema with new liability fields (columns 11+) for data capture
- [ ] Update app Add/Edit Account forms to show sub-type-specific fields
- [ ] Validate sync output against Sheets source
- [ ] Confirm Spark JDBC read against `v_accounts_active` returns expected schema
