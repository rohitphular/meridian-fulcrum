# Fulcrum

Personal finance management system. Tracks expenses, debts, investments, and life organisation across a unified interface.

**Fulcrum** — the balance point of a lever. Personal finance is about finding the point where small, deliberate effort produces the greatest change. The name reflects balance, leverage, and control.

---

## Structure

### Forge

Standalone prototype modules built independently: `codebase/expense-tracker/` and `codebase/data-synchronization/` (Python data jobs), plus `infrastructure/` (local PostgreSQL services and environment settings) at the repository root. Each module solves one problem cleanly before being integrated into the unified Fulcrum app.

| Module | Status | What it does |
|---|---|---|
| `codebase/expense-tracker` | Prototype | Multi-currency expense + accounts tracker — transactions, categories, accounts (assets + liabilities), FX rates. |

---

## Planned Modules

| Module | What it covers |
|---|---|
| Expenses | Day-to-day spending, categories, monthly budgets |
| Debts | Loans, credit cards, informal debts — payoff planning |
| Investments | Portfolio tracking, returns, allocation |
| Reminders | Financial and personal reminders |
| Events | Calendar of important dates |
| Contacts | Personal contact management |
| Wishlist | Tracked items and purchase goals |
