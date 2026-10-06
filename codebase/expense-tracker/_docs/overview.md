# Overview

A personal-finance ledger. Tracks money in, money out, and movement between owned accounts, with multi-currency support and a category-driven taxonomy.

## What it does

1. **Capture** — log income, expenses, and transfers, either through the app form or by typing rows directly into the underlying spreadsheet/database.
2. **Maintain** — keep account balances accurate. Balances are computed at read time by scanning all non-deleted transactions; no write-back occurs on transaction create/edit/delete.
3. **Classify** — every income or expense is tagged with a two-level category (major → minor).
4. **Normalise** — convert all amounts to a single base currency for cross-account comparison.
5. **Analyse** — summarise income/expense, savings rate, and break down spend by category and account.

The store is the source of truth. The backend computes balances, conversions, totals and periods and returns ready-to-render views; the browser only renders them. Home is a placeholder for now. Definitions: [calculations](calculations.md).

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

Transactions use a **single-leg model**: each row represents one account movement. The field `account_id` identifies the affected account and `tx_amount_local` holds the movement amount. Transfers between owned accounts are represented as two linked rows; the child stores the parent ID in `parent_tx_id`.

| Type | Direction | `account_id` | Categorised |
|---|---|---|---|
| `money-in` | inflow into one owned account | the account receiving funds | yes (major + minor) |
| `money-out` | outflow from one owned account | the account losing funds | yes (major + minor) |

Transfers use two `money-out` / `money-in` rows linked via `parent_tx_id`. Cross-currency transactions require an FX rate.

## Account classification

The `account_types` Sheet owns the existing 16 classifications, their display labels and supported detail tabs. Account choices and category hints read that configuration; the application does not seed or maintain a second subtype catalog. See [Account Types](account-types.md) for the 13-column contract and the initial CSV import.

Asset and investment balances retain their supplied sign. Liabilities are modelled as accounts with negative balances; the UI displays the amount owed as a magnitude. There is no separate debt entity.

## Capabilities

| Area | Capability |
|---|---|
| Authentication | PIN + optional TOTP, IP rate-limit, audit log |
| Accounts | CRUD; archive without delete; opening snapshot and tracking date; separate account-detail CSV imports |
| Transactions | CRUD; single-leg model (`account_id` + `tx_amount_local`); server-side date range, filters, sort and pagination; CSV/JSON export; cascading category dropdowns from server option trees; FX rate when accounts differ in currency |
| Categories | CRUD; two-level taxonomy scoped per transaction type; archive without delete; CSV import or manual creation |
| Rates | Upsert per currency; XAU base currency read-only (rate = 1); auto-seed on first run |
| Subscriptions | Registry of recurring payment obligations; frequency, amount, account, and category linkage; 21-column schema |
| Multi-currency | Per-account currency; XAU base currency conversion via rates table; effective exchange rate for cross-currency transfers is implicit in the two stored `tx_amount_local` values |
| Theming | Light + dark, persisted per user |

## Out of scope

- Budget limits / envelopes
- Bank or open-banking integrations
- Multi-user / role-based access
- Historical FX rates (a single current rate per currency applies to all transactions regardless of date)

## Non-functional posture

- **Single-user.** No tenancy model. Auth gate is a shared secret (PIN + TOTP).
- **Append-friendly store.** Sheets/database is the durable record; the app re-reads after every mutation rather than maintaining a cache delta.
- **Concurrent requests are possible.** Multiple browser tabs and parallel reads can overlap even for one user. Google Sheets does not provide database transactions across sheets.
- **Language-agnostic.** The reference implementation runs on Google Apps Script + a static JS frontend, but every requirement in `docs/` is described in terms of logic and data — not framework or platform.
