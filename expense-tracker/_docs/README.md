# Expense Tracker — Requirements

Reverse-engineered, language-agnostic specification for the Expense Tracker app. The reference implementation runs on Google Apps Script + vanilla JS, but every document here is written in terms of logic, data shape, and behaviour — anyone could build this in any stack.

## Read in this order

1. **[overview.md](overview.md)** — What the app is, the domain model, the capabilities, what's out of scope
2. **[data-model.md](data-model.md)** — Entity shapes (Account, Transaction, Category, Rate, AuditEntry) and their cross-entity invariants
3. **[../../../documentation/APP-AUTH.md](../../../documentation/APP-AUTH.md)** — Single-user authentication with PIN + optional TOTP, IP rate limiting, session model (shared Forge doc)
4. **[accounts.md](accounts.md)** — Account types, balance conventions, derived fields, net-worth and utilisation calculations
5. **[transactions.md](transactions.md)** — The three transaction types, required fields, filters, sort, export, malformed-row handling
6. **[balance-lifecycle.md](balance-lifecycle.md)** — How `current_balance` changes on every transaction create / update / delete (two-phase reversal)
7. **[financial-rules.md](financial-rules.md)** — The six hard-block validation rules (insufficient balance, credit limit, no-money-out-from-loan, FX required, …)
8. **[categories.md](categories.md)** — Two-level taxonomy, archive semantics, account-type hints, auto-seed
9. **[rates.md](rates.md)** — FX rates, upsert semantics, conversion function, row-level vs global rate priority
10. **[insight.md](insight.md)** — Summary cards, monthly chart, category drilldown, per-account spend, date-range filter

## Historical

- **[raw-requirement.md](raw-requirement.md)** — Original product brief. Preserved as-is for traceability. Specifications above supersede it where they differ.

## Building this in any language

The following decisions are reference-implementation choices, NOT requirements. Substitute freely:

| Reference choice | What it represents | Substitution candidates |
|---|---|---|
| Google Sheet as store | Append-friendly tabular data with row identity | PostgreSQL, SQLite, Firestore, DynamoDB, even flat files with row keys |
| Apps Script `doGet` / `doPost` | HTTP entry points with action dispatch | Any HTTP framework: Express, FastAPI, Spring, ASP.NET |
| Vanilla JS modules | Static SPA with no build step | React / Vue / Svelte / Solid / native mobile — the section pattern (form-above-table, sort, filter, paginate) maps cleanly |
| `_audit` sheet for IP tracking | A keyed counter + lock-state store | Redis, a DB table, even an in-memory map for single-instance deploys |
| Chart.js | A 2D bar charting library | Any equivalent — the insight chart shapes are simple bars |
| Session in `sessionStorage` | Per-tab, short-lived session token | Cookie + server session, JWT, encrypted client storage |

Required regardless of platform:

- Atomicity of the transaction lifecycle (write + balance adjustments succeed together or not at all)
- Server-side enforcement of the six financial rules (the frontend's pre-checks are convenience only)
- Sign-convention for liabilities (stored negative; displayed as positive "owed")
- The two-phase reversal pattern for transaction updates
- Row-level `fx_rate` storage so reversal stays exact across global-rate changes
