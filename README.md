# Fulcrum

Personal finance management system. Tracks expenses, debts, investments, and life organisation across a unified interface.

**Fulcrum** — the balance point of a lever. Personal finance is about finding the point where small, deliberate effort produces the greatest change. The name reflects balance, leverage, and control.

---

## Structure

### Forge

Standalone prototype modules built independently, at the repository root: `expense-tracker/`, plus `data-synchronization/` (Python data jobs) and `infrastructure/` (local PostgreSQL services and environment settings). Each module solves one problem cleanly before being integrated into the unified Fulcrum app.

| Module | Status | What it does |
|---|---|---|
| `expense-tracker` | Prototype | Multi-currency expense + accounts tracker — transactions, categories, accounts (assets + liabilities), FX rates. Insight section with income/expense/net summary, category drilldown, per-account spend. |

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
