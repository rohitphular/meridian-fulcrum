# 01 — Contracts

**Depends on:** nothing. Every later task builds on these files.

## Goal
One versioned source for what a report can be and what the job publishes, so GAS, the loader and the job cannot drift.

## Steps
1. **Report definition whitelist** — `data-synchronization/analytics/contract/report-definition.json` (`contract_version`):
   - `report_type`: `predefined`, `user_defined`.
   - `measure`: spend, income, net, savings_rate, count, average, balance, net_worth.
   - `period_preset`: last_30, this_month, last_month, last_3, last_6, last_12, ytd, last_year, all, fixed (+ `period_from`/`period_to`, UTC dates).
   - `compare_mode`: none, previous, last_year.
   - `time_grain`: none, day, week, month, quarter, year.
   - `group_by`: category, sub_category, tag, payee, account, account_type, currency, country, city (max 2).
   - `top_n`: 5, 7, 10, 15, 20; `include_other`: boolean.
   - Filters (each `;`-separated): account_ids, categories (`major` or `major|minor`), tags, payees, currencies, countries, tx_types; amount_min/amount_max — in the account's own currency (local amount), compared before any conversion.
   - `chart_kind`: line, bar, stacked, hbar, donut, table.
   - Compatibility rules (same as the builder mockup): e.g. donut = no time grain + exactly one group-by + additive measure; stacked = time grain + ≥1 group-by; balance groups only by account/account_type/currency; net_worth has no group-by; a single number = no time grain and no group-by (eligible for Home tiles).
   - Limits: max series, max points, max rows per table.
2. **Predefined catalogue** — `contract/predefined-reports.json`: stable `predefined_key` per report (the 30 current insights, Home figures, Accounts summary), its title, group (Cash flow, Comparisons, Categories and tags, Net worth and debt, Payees and places), variants (period presets, tabs, windows, top_n), and whether it is a single number (Home tile) or a panel.
3. **Output payload contract** — `contract/report-payload.md`: reuse the existing insight payload shape (`expense-tracker/api/insights-registry.gs:34-86`) with `contract_version`, every money value in XAU, and each value's `format` saying whether it is money (so GAS knows what to convert). Add `published_at` (UTC), `period.from/to` (UTC dates), `warnings` (e.g. missing rates).
4. **GAS copy** — generate `expense-tracker/api/report-contract.gs` from the JSON (a small script in the analytics module) plus a test that fails when the two differ.

## Acceptance
- JSON files validated by a schema test; the generated `.gs` matches; versions bumped together.
