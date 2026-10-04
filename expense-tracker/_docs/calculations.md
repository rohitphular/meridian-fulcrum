# Calculations and product decisions

Report, Home and Accounts figures are computed by the **analytics** job (`data-synchronization/analytics`) in XAU and UTC and published to the Sheet; GAS converts them to the display currency (see [reports](reports.md)). List screens (Transactions, Subscriptions, Categories, Configure) are still shaped by GAS: filtering, sorting, paging and conversion of native amounts. The browser formats numbers and dates and colours values by server-given keys; it does not convert currencies, sum, filter, sort, page, bucket dates or validate. This page is the single reference for the definitions.

| Concern | Implemented in |
|---|---|
| Flows, balances over time, net worth, every report | `data-synchronization/analytics/core/mart.py`, `core/reports/*.py`, `core/user_defined.py` |
| Report periods (UTC) | `data-synchronization/analytics/core/periods.py` |
| Converting published XAU to the quote currency | `api/report-store.gs` (`rsConvert`) |
| Transactions list periods, wall-date filters, transfer pairing | `api/ledger-core.gs` (`ldg*`) |
| Currency conversion of native amounts in lists | `api/fx-utils.gs` (`fx*`) |
| Request context (`quote_currency`, `tz`, `today`), envelopes, per-request dataset | `api/view-context.gs` (`vm*`) |
| Screen view models | `api/view-*.gs`, `api/report-store.gs` (see [api/README.md](../api/README.md#view-gets)) |
| Write-path validation and business rules | entity `*-validation.gs` files; see [financial-rules.md](financial-rules.md) |

## Net worth, assets and liabilities

One definition everywhere: Accounts summary cards, Home, every report, and the advisor context.

- **Accounts counted:** all non-deleted accounts, whatever their status (`active`, `inactive`, `locked`). Deleted accounts never count.
- **Assets:** accounts of type `asset` or `investment`, at their current balance converted to the quote currency.
- **Liabilities:** accounts of type `liability`. Balances are stored negative (money owed); a liability in credit is positive and reduces total liabilities.
- **Net worth:** assets + liabilities (liabilities are negative).
- **Liquid cash** (Accounts card): asset accounts whose account type maps to the deposit detail sheet.
- **Current balance:** `opening_value_local` plus every eligible movement after the tracking cutoff, future-dated rows included (the same rule `listAccounts` uses). See [balance-lifecycle.md](balance-lifecycle.md).

Implementation: `current_net_worth` and `net_worth_on` in `analytics/core/reports/common.py`. Current balances use each currency's latest rate on or before the run date; a balance on an earlier day uses that day's rate.

## Income, spending and cash flow

Income, spending, savings, cash-flow, category, tag, counterparty, geography and daily-spend figures count only **flows** (`analytics/core/mart.py`), valued at each transaction's stored XAU base value:

- **Deleted transactions are excluded.**
- **Transfers between own accounts are excluded.** A row is an own-transfer leg when it is a child (`parent_tx_id` set) or a parent with a live child. Loan, credit-card and mortgage repayments, account-to-account moves and currency exchanges are all transfer pairs, so repayment and paydown insights read ledger balances or the transfer pairs instead of flows.
- `money-in` is income, `money-out` is spending.

Balance replays (current balances, net-worth trends, balances at a date) still include transfer legs, because they move money between accounts. The Transactions list shows every leg, including transfer legs and deleted rows, and has no income/spending totals.

## Periods and dates

- **Reports use UTC.** The run date (the anchor) is the UTC date of the job run, and a transaction belongs to the UTC date of its instant (23:30 UTC on 30 Sep is September even though it is 1 Oct in London). Only the publish time is shown in the browser's zone.
- **Lists use the request zone.** For the Transactions list, today is the zoned date for the request `tz` (browser IANA zone, default `Europe/London`); tests may pass a validated `today=` override.
- **Inclusive of today.** `last_N` days is today and the N − 1 days before (`last_30` = 30 days). `this_month`, `this_quarter`, `ytd` and `last_N` months end today: the N calendar months ending with the current month, current month to date.
- **Complete periods.** `last_week` (ISO, Monday start), `last_month`, `last_quarter` and `last_year` are the previous full calendar period.
- **Compare periods** are the previous span of equal length (or the same span a year earlier where a report says so).
- **Transactions list dates** filter by the recorded wall date of `tx_date_local` (`ldgTxDateKey`), parsed as text, never with `new Date('YYYY-MM-DD HH:MM:SS')`. A row whose date cannot be read is listed in the Transactions `warn_rows` and never silently dropped from the list.
- **Balance snapshots** compare instants: a zoned account's tracking cutoff is compared with the movement's instant in its own zone (blank zone = Europe/London); legacy unzoned accounts compare wall times.
- **Transactions list range `all`** is unbounded at both ends.

Implementation: reports `analytics/core/periods.py`; lists `ldgPeriodBounds(period, today, from, to)`, `LDG_PERIODS`, `LDG_PERIOD_LABELS`.

## Currency conversion

- Rates are units of each currency per gram of gold (XAU = 1). A value converts as `amount / rate[from] × rate[quote]`.
- A missing, zero, negative or non-finite rate makes the value **unavailable**: it is excluded from totals and the response carries a `missing_rate` warning naming the currencies. It is never converted 1:1 and never counted as zero.
- Reports are computed in XAU: flows at their stored base value, balances at the rate of their day. GAS converts published XAU with the current rate of the display currency (`value × rate[quote]`), so a report's shape never changes with today's rate, only its display unit. Native amounts in lists use current rates.
- Money fields carry the native amount and currency with the quote value (`fxMoney`); the UI shows both when they differ.

## Subscriptions

`list_subscriptions_view` computes each row's `next_payment_date`, `due_in_days` and `schedule_status` on the server. The monthly estimate converts each scheduled subscription to the quote currency and normalises by frequency (weekly × 52 ÷ 12, quarterly ÷ 3, annual ÷ 12).

## Caching

Views of published figures (`get_report`, `get_home_view`, `list_accounts_view`) add the published generation id to the cache key, because the job's writes do not bump `data_version`. View GETs are cached (CacheService, up to 10 minutes) under a key made of `data_version`, action and every param including `quote_currency`, `tz` and `today`. `data_version` changes on manual Sheet edits (`onEdit`) and after a POST that may have changed data. A successful POST bumps it unless it reports numeric `created: 0` and `updated: 0` with no `references_migrated > 0`, `catalog_written` or `deleted`; single-record actions (no counts) always bump it. A failed POST bumps it when it reports `sheet_written: true`, a non-empty `deleted` list, or `created` / `updated` / `deleted` above 0. `dry_run` requests and `advisor_chat`, `clear_advisor_history` and `fill_csv_ids` never bump it. Payloads over 90 KB are not cached and are recomputed on each request; exports are never cached.

## What changed with the analytics job (2026-10)

| Figure | Before (GAS at read time) | Now (analytics job) |
|---|---|---|
| Report dates | Request timezone | UTC |
| Amounts | Converted at current rates to the quote currency | XAU: flows at stored base value, balances at the day's rate; converted for display at read time |
| Liability paydown, loan progress, debt-free | Same rate both sides | Owed amounts compared in the account's currency and valued at one (current) rate, so a gold move is never a repayment |
| Freshness | Live on every request | As of the last publish |

## What changed from the old client

| Figure | Old client | Now |
|---|---|---|
| Home total assets | Always 0 (read non-existent `current_value` / `currency` fields), so net worth = −debt | Assets and liabilities per the definition above |
| Net worth on Home / Insights / Advisor | Active accounts only; insights 01–06 treated every non-liability as an asset | All non-deleted accounts; assets = asset + investment |
| Income and spending | Deleted rows and own-account transfer legs were counted | Both excluded |
| Insight `last_30` | today − 30 (31 days) | today − 29 (30 days) |
| Insight `last_N` months, `this_month` | Ended at month end | End today |
| Invalid-date rows in insights | Parsed with `new Date(...)` (browser-dependent, Safari differed) | Recorded wall date parsed as text; unreadable dates excluded from flows |
| Date-only transaction dates in balance replays | Counted by the client replay | Skipped, as `listAccounts` already did |
