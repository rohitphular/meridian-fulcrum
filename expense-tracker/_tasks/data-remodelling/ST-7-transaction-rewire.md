# ST-7 — Transaction rewire

**Type:** Sheet migration + data migration + code + deploy
**Depends on:** ST-6

---

## Context

Abolish `money-transfer` as both a transaction type and a category classifier. Every transaction is either `money-in` or `money-out`. A transfer between accounts is a single `money-out` row with both `source_account` and `target_account` populated.

`source_amount` and `target_amount` replace the single `amount` field. The binding is strict:
- `source_amount` belongs to `source_account` — how much left that account
- `target_amount` belongs to `target_account` — how much arrived in that account
- When an account field is blank (external party), its corresponding amount is also blank
- `currency` = the source/primary currency of the transaction; for FX transfers the target currency is derived from the target account's defined currency

`workflow_type` on categories is removed. The Transfer form signal is derived at runtime:

```
is_transfer = (source_account_mandatory == TRUE AND target_account_mandatory == TRUE)
```

No standalone `money-in` or `money-out` category has both true. Every transfer category has both true. No extra column needed.

---

## Transaction shapes

| tx_type | source_account | source_amount | target_account | target_amount | currency | notes |
|---|---|---|---|---|---|---|
| money-in | blank | blank | Lloyds | 6,672.61 | GBP | Salary — external payer, no source account |
| money-out | Lloyds | 49.99 | blank | blank | GBP | Expense — external payee, no target account |
| money-out | Lloyds | 1,000 | Savings | 1,000 | GBP | Same-currency transfer |
| money-out | Lloyds | 1,401.99 | ICICI | 182,259 | GBP | FX transfer — target currency derived from ICICI account definition |

---

## Sheet changes

### 1. Transactions sheet — rename and add amount columns
- Rename column `amount` → `source_amount`
- Add column `target_amount` immediately after `source_amount`

### 2. Categories sheet — drop `workflow_type` and rename `money-transfer` tx_type
- Delete the `workflow_type` column
- Change `tx_type = money-transfer` → `money-out` on all 9 transfer categories

---

## Data migration

### 3. Update existing `money-transfer` rows in the transactions sheet
For every row where `tx_type = money-transfer`:
- Set `tx_type = money-out`
- `source_account` and `source_amount` already hold the correct values (rename only — the original `amount` column becomes `source_amount`)
- `target_account` already holds the correct value
- Set `target_amount` = `source_amount` (same value for non-FX historical rows; acceptable approximation since original data had no separate target amount)

No row splitting. No row deletion. One pass, in place.

> Note: historical forex `money-transfer` rows had a single amount in one currency. After migration both `source_amount` and `target_amount` will hold the same value, which is an approximation. Going forward, each FX transfer is entered with distinct `source_amount` (source currency) and `target_amount` (target currency).

---

## Category changes

### 4. The 8 transfer categories — final structure

All former `money-transfer` categories move to `tx_type = money-out`. Both account mandatory flags remain TRUE. The UI uses `source_account_mandatory AND target_account_mandatory` to render the Transfer form. `Investments → To pension` is dropped entirely.

| tx_type | major_category | minor_category | source_account_types | target_account_types | source_mandatory | target_mandatory |
|---|---|---|---|---|---|---|
| money-out | Own accounts | Account to account | current, savings, cash, investment | current, savings, cash, investment | TRUE | TRUE |
| money-out | Own accounts | Currency exchange | current, savings | current, savings | TRUE | TRUE |
| money-out | Cash management | ATM withdrawal | current, savings | cash | TRUE | TRUE |
| money-out | Cash management | Cash deposit | cash | current, savings | TRUE | TRUE |
| money-out | Debt repayment | Mortgage repayment | current, savings, cash | mortgage | TRUE | TRUE |
| money-out | Debt repayment | Loan repayment | current, savings, cash | auto_loan, heloc, personal_loan, student_loan, medical_loan, debt_consolidation | TRUE | TRUE |
| money-out | Debt repayment | Credit card payment | current, savings, cash | credit_card | TRUE | TRUE |
| money-out | Debt repayment | Overdraft repayment | current, savings, cash | overdraft | TRUE | TRUE |

---

## Categories sheet migration

### 5. Column changes

Apply in this order to avoid overwriting data before it is read:

| Step | Action | Detail |
|---|---|---|
| 5a | Delete column | `workflow_type` — drop entirely |
| 5b | Rename column | `tx_type` → `tx_type_key` |
| 5c | Insert column after `tx_type_key` | `tx_type_label` — derived: `money-in` → `Money In`, `money-out` → `Money Out` |
| 5d | Rename column | `major_category` → `major_category_label` |
| 5e | Insert column before `major_category_label` | `major_category_key` — slugified from `major_category_label`: lowercase, spaces and `&`/`/` → hyphens, no other special chars |
| 5f | Rename column | `minor_category` → `minor_category_label` |
| 5g | Insert column before `minor_category_label` | `minor_category_key` — same slugify rule as above |

### 6. Row-level data changes

Apply after column changes are in place.

**6a — Drop one row:**

| tx_type_key | major_category_label | minor_category_label |
|---|---|---|
| money-transfer | Investments | To pension |

**6b — Rename `tx_type_key` on 9 rows** (all former `money-transfer`):

`money-transfer` → `money-out` and `tx_type_label` → `Money Out`

**6c — Rename `major_category_label` on specific rows:**

| Match (current label) | New `major_category_label` | Affects rows |
|---|---|---|
| `Between own accounts` | `Own accounts` | 1 row (Account to account) |
| `Currency exchange` | `Own accounts` | 1 row (FX conversion) |
| `Cash` | `Cash management` | 2 rows (ATM withdrawal, Cash deposit) |
| `Gifts & other` | `Occasional income` | 2 money-in rows (Gift received, Sale of asset) |

**6d — Rename `minor_category_label` on specific rows:**

| Match (current label) | New `minor_category_label` | Major context |
|---|---|---|
| `FX conversion` | `Currency exchange` | Own accounts |
| `Streaming/TV` | `Streaming & TV` | Entertainment (also moves from Utilities) |
| `Subscriptions` | `Software & apps` | Entertainment |
| `Books & supplies` | `Study materials` | Education |

**6e — Move one row between majors:**

`Utilities → Streaming/TV` moves to `Entertainment → Streaming & TV` (covered by 6c/6d above; confirm `major_category_label` changes from `Utilities` to `Entertainment`)

**6f — Regenerate all key columns** after all label changes are applied:

- `major_category_key` = slugify(`major_category_label`)
- `minor_category_key` = slugify(`minor_category_label`)

### 7. Final column order

```
tx_type_key, tx_type_label,
major_category_key, major_category_label,
minor_category_key, minor_category_label,
description, is_active, tag_keywords, counterparty_examples,
source_account_types, target_account_types,
source_account_mandatory, target_account_mandatory,
is_subscription_eligible
```

Reference file: `meridian-fulcrum/local/files/categories_current_v2.csv`
