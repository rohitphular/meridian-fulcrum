# Overview

A personal-finance ledger. Tracks money in, money out, and movement between owned accounts, with multi-currency support and a category-driven taxonomy.

## What it does

1. **Capture** — log income, expenses, and transfers, either through the app form or by typing rows directly into the underlying spreadsheet/database.
2. **Maintain** — keep account balances accurate. Balances are computed at read time by scanning all non-deleted transactions; no write-back occurs on transaction create/edit/delete.
3. **Classify** — every income or expense is tagged with a two-level category (major → minor).
4. **Normalise** — convert all amounts to a single base currency for cross-account comparison.
5. **Analyse** — summarise income/expense, savings rate, and break down spend by category and account.

The store is the source of truth. The app is a capture-and-analysis layer on top.

## Domain entities

| Entity | Owns | Cardinality |
|---|---|---|
| **Account** | A pool of money with a currency, balance, and type (asset or liability) | Many |
| **Transaction** | A single-leg money movement, dated and linked to one account via `account_id` | Many |
| **Category** | A `(transaction_type, major, minor)` taxonomy entry for classifying income/expense | Many |
| **Rate** | An FX rate per currency, expressed as `units of that currency per 1 XAU (1g gold)` | One per currency |
| **Subscription** | A recurring payment obligation with frequency, amount, account, and category linkage | Many |
| **AuditEntry** | A login attempt — IP, status, lock state | Many |

The base currency is **XAU (1 gram of gold, rate = 1, never editable)**. All cross-currency arithmetic uses the rates table.

## Transaction types

Transactions use a **single-leg model**: each row represents one account movement. The field `account_id` identifies the affected account and `tx_amount` holds the movement amount. Transfers between owned accounts are represented as two linked rows sharing a `parent_tx_id`.

| Type | Direction | `account_id` | Categorised |
|---|---|---|---|
| `money-in` | inflow into one owned account | the account receiving funds | yes (major + minor) |
| `money-out` | outflow from one owned account | the account losing funds | yes (major + minor) |

Transfers use two `money-out` / `money-in` rows linked via `parent_tx_id`. Cross-currency transactions require an FX rate.

## Account groups

| Type | Sub-types | Balance convention |
|---|---|---|
| **asset** | current, savings, cash | Positive = funds held |
| **investment** | stocks_shares, isa, pension_sipp, crypto, fixed_deposit, bonds, property, commodities, p2p_lending, other | Positive = funds held |
| **liability** | personal_loan, credit_card, mortgage, auto_loan, heloc, student_loan, medical_loan, debt_consolidation, overdraft | Stored **negative** (double-entry convention); UI displays `abs(current_value_local)` labelled "owed" — user always inputs and sees positive numbers |

Liabilities are modelled as accounts with negative balances. There is no separate debt entity.

## Capabilities

| Area | Capability |
|---|---|
| Authentication | PIN + optional TOTP, IP rate-limit, audit log |
| Accounts | CRUD; archive without delete; per-type fields (loan terms, credit limits, overdraft, investment platform, etc.); utilisation and repayment-progress derived fields |
| Transactions | CRUD; single-leg model (`account_id` + `tx_amount`); eight filter dimensions; client-side date range; sort; pagination; CSV/JSON export; cascading category dropdowns; FX rate when accounts differ in currency |
| Categories | CRUD; two-level taxonomy scoped per transaction type; archive without delete; auto-seed on first run |
| Rates | Upsert per currency; XAU base currency read-only (rate = 1); auto-seed on first run |
| Subscriptions | Registry of recurring payment obligations; frequency, amount, account, and category linkage; 22-column schema |
| Insight | Income/Expense/Net/Savings-rate cards; monthly bar chart; spend by category (drillable major → minor); spend by account |
| Multi-currency | Per-account currency; XAU base currency conversion via rates table; effective exchange rate for cross-currency transfers is implicit in the two stored `tx_amount` values |
| Theming | Light + dark, persisted per user |

## Out of scope

- Budget limits / envelopes
- Bank or open-banking integrations
- Multi-user / role-based access
- Historical FX rates (a single current rate per currency applies to all transactions regardless of date)

## Non-functional posture

- **Single-user.** No tenancy model. Auth gate is a shared secret (PIN + TOTP).
- **Append-friendly store.** Sheets/database is the durable record; the app re-reads after every mutation rather than maintaining a cache delta.
- **Eventual consistency is not a concern.** All writes are synchronous within one request; one user means no contention.
- **Language-agnostic.** The reference implementation runs on Google Apps Script + a static JS frontend, but every requirement in `docs/` is described in terms of logic and data — not framework or platform.
