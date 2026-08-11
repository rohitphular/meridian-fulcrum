# Overview

A personal-finance ledger. Tracks money in, money out, and movement between owned accounts, with multi-currency support and a category-driven taxonomy.

## What it does

1. **Capture** — log income, expenses, and transfers, either through the app form or by typing rows directly into the underlying spreadsheet/database.
2. **Maintain** — keep account balances accurate by adjusting them on every transaction create/edit/delete.
3. **Classify** — every income or expense is tagged with a two-level category (major → minor).
4. **Normalise** — convert all amounts to a single base currency for cross-account comparison.
5. **Analyse** — summarise income/expense, savings rate, and break down spend by category and account.

The store is the source of truth. The app is a capture-and-analysis layer on top.

## Domain entities

| Entity | Owns | Cardinality |
|---|---|---|
| **Account** | A pool of money with a currency, balance, and type (asset or liability) | Many |
| **Transaction** | A single money movement, dated and linked to one or two accounts | Many |
| **Category** | A `(transaction_type, major, minor)` taxonomy entry for classifying income/expense | Many |
| **Rate** | An FX rate per currency, expressed as `units per 1 base currency` | One per currency |
| **AuditEntry** | A login attempt — IP, status, lock state | Many |

The base currency is configurable (default GBP). All cross-currency arithmetic uses the rates table.

## Transaction types

| Type | Direction | Source | Target | Categorised |
|---|---|---|---|---|
| `money-in` | inflow | external (not stored) | one owned account | yes (major + minor) |
| `money-out` | outflow | one owned account | external, or an owned account for repayments | yes (major + minor) |
| `money-transfer` | between owned accounts | one owned account | one other owned account | no |

A `money-out` may credit a *target* owned account when the spend lands as a repayment (e.g. paying a credit card or loan from a current account). Cross-currency `money-out` and `money-transfer` require an FX rate.

## Account groups

| Type | Sub-types | Balance convention |
|---|---|---|
| **asset** | current, savings, cash | Positive = funds held |
| **investment** | stocks_shares, isa, pension_sipp, crypto, fixed_deposit, bonds, property, commodities, p2p_lending, other | Positive = funds held |
| **liability** | personal_loan, credit_card, mortgage, auto_loan, heloc, student_loan, medical_loan, debt_consolidation, overdraft | Stored **negative** (double-entry convention); UI displays `abs(current_value)` labelled "owed" — user always inputs and sees positive numbers |

Liabilities are modelled as accounts with negative balances. There is no separate debt entity.

## Capabilities

| Area | Capability |
|---|---|
| Authentication | PIN + optional TOTP, IP rate-limit, audit log |
| Accounts | CRUD; archive without delete; per-type fields (loan terms, credit limits, overdraft, investment platform, etc.); utilisation and repayment-progress derived fields |
| Transactions | CRUD; eight filter dimensions; client-side date range; sort; pagination; CSV/JSON export; cascading category dropdowns; FX rate when accounts differ in currency |
| Categories | CRUD; two-level taxonomy scoped per transaction type; archive without delete; auto-seed on first run |
| Rates | Upsert per currency; base currency read-only; auto-seed on first run |
| Insight | Income/Expense/Net/Savings-rate cards; monthly bar chart; spend by category (drillable major → minor); spend by account |
| Multi-currency | Per-account currency; base currency conversion via rates table; per-transaction `fx_rate` override for cross-currency transfers |
| Theming | Light + dark, persisted per user |

## Out of scope

- Recurring transactions
- Budget limits / envelopes
- Bank or open-banking integrations
- Multi-user / role-based access
- Historical FX rates (a single current rate per currency applies to all transactions regardless of date)

## Non-functional posture

- **Single-user.** No tenancy model. Auth gate is a shared secret (PIN + TOTP).
- **Append-friendly store.** Sheets/database is the durable record; the app re-reads after every mutation rather than maintaining a cache delta.
- **Eventual consistency is not a concern.** All writes are synchronous within one request; one user means no contention.
- **Language-agnostic.** The reference implementation runs on Google Apps Script + a static JS frontend, but every requirement in `docs/` is described in terms of logic and data — not framework or platform.
