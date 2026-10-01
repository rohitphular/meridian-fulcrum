# Expense Tracker — Requirements

Reverse-engineered, language-agnostic specification for the Expense Tracker app. The reference implementation runs on Google Apps Script + vanilla JS, but every document here is written in terms of logic, data shape, and behaviour — anyone could build this in any stack.

## Read in this order

For an existing installation, first follow [master tab naming and migration](master-sheet-names.md) to align the master CSVs, Sheet tabs and database names.

See [spreadsheet tab order](sheet-order.md) for the preferred layout and automatic/manual arrangement helper.

1. **[overview.md](overview.md)** — What the app is, the domain model, the capabilities, what's out of scope
2. **[data-model.md](data-model.md)** — Entity shapes (Account, Transaction, Category, Rate, Subscription, AuditEntry) and their cross-entity invariants
3. **[APP-AUTH-PIN-TOTP.md](../../building-standards/documents/standards/APP-AUTH-PIN-TOTP.md)** — Single-user authentication with PIN + optional TOTP, IP rate limiting, session model (shared Forge doc)
4. **[accounts.md](accounts.md)** — Account types, balance conventions, derived fields, net-worth and utilisation calculations
   - **[account-types.md](account-types.md)** — Configure tab, the existing Sheet-owned catalog, import/export, policy fields and sync
   - **[account-imports.md](account-imports.md)** — Current master/detail import contracts and extractor boundary
5. **[transactions.md](transactions.md)** — The two transaction types (money-in, money-out), single-leg model, required fields, filters, sort, export, malformed-row handling
6. **[balance-lifecycle.md](balance-lifecycle.md)** — How `current_value_local` is derived at read time via `_buildAccountNetMap`, and the post-reversal formula used when validating edits
7. **[financial-rules.md](financial-rules.md)** — Implemented validation and limitations of balance, credit-limit, and transfer checks
8. **[categories.md](categories.md)** — Two-level taxonomy, archive semantics, account-type hints, CSV import
9. **[rates.md](rates.md)** — FX rates, upsert semantics, conversion function, row-level vs global rate priority
10. **[subscriptions.md](subscriptions.md)** — Recurring payment obligations, 21-column schema, frequency, amount, account and category linkage
11. **[calculations.md](calculations.md)** — Product decisions applied by the server everywhere: net worth, income / spending exclusions, periods, conversion, caching
12. **[insight/INSIGHT.md](insight/INSIGHT.md)** — The server-computed insight section and one doc per insight ([insight.md](insight.md) is the superseded early design)

## Historical

- **[raw-requirement.md](raw-requirement.md)** — Original product brief. Retained for traceability, with storage names updated to the current convention. Specifications above supersede it where they differ.

## Building this in any language

The following decisions are reference-implementation choices, NOT requirements. Substitute freely:

| Reference choice | What it represents | Substitution candidates |
|---|---|---|
| Google Sheet as store | Append-friendly tabular data with row identity | PostgreSQL, SQLite, Firestore, DynamoDB, even flat files with row keys |
| Apps Script `doGet` / `doPost` | HTTP entry points with action dispatch | Any HTTP framework: Express, FastAPI, Spring, ASP.NET |
| Vanilla JS modules | Static SPA with no build step | React / Vue / Svelte / Solid / native mobile — the section pattern (form-above-table, sort, filter, paginate) maps cleanly |
| `_audit` sheet for IP tracking | A keyed counter + lock-state store | Redis, a DB table, even an in-memory map for single-instance deploys |
| Chart.js | A 2D bar charting library | Any equivalent — the insight chart shapes are simple bars |
| Session in `sessionStorage` | Per-tab client session containing the PIN | Cookie + server session, JWT, encrypted client storage |

Required regardless of platform:

- Validate transaction inputs before writing; see [financial-rules.md](financial-rules.md) for the current enforcement boundary
- Sign-convention for liabilities (stored negative; displayed as positive "owed")
- Read-time balance computation from the opening snapshot and eligible transaction rows
- Storing `tx_amount_local` on each transfer leg (not a single `fx_rate` column) so balance reversal stays exact even when the global rate is later changed
